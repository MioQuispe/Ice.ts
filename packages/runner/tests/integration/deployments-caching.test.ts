import fs from "node:fs"
import path from "node:path"
import { describe, it, expect } from "vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
import { makeTaskRunner } from "./setup.js"
// Reuse same env helper as other integration tests
import { makeTestEnv, makeTestEnvEffect } from "./setup.js"
import { DeploymentsService } from "../../src/services/deployments.js"
import { Option } from "effect"
import {
	CustomCanisterScope,
	// customCanister,
	makeCustomCanister,
} from "../../src/builders/custom.js"
import { CanisterScopeSimple } from "../../src/index.js"
import { CachedTask, Task } from "../../src/types/types.js"

type Mode = "auto" | "install" | "reinstall" | "upgrade"

type Scenario = {
	mode: Mode
	installArgsChanged: boolean
	upgradeArgsChanged: boolean
	canisterExists: boolean
	modulePresent: boolean
	installCacheExists: boolean
	upgradeCacheExists: boolean
	resolvedMode: "install" | "reinstall" | "upgrade" | "latest"
	cacheUsed: "install" | "upgrade" | undefined
	expectedOutcome: "OK" | "ERROR!"
	notes: string | undefined
}

const toBool = (v: string): boolean => v.trim().toUpperCase() === "TRUE"

const parseCsv = (txt: string): Scenario[] => {
	const rows: Scenario[] = []
	const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0)
	if (lines.length <= 1) return rows
	const header = lines[0]!
	const cols = header.split(",")
	const colIndex: Record<string, number> = {}
	cols.forEach((c, i) => (colIndex[c.trim()] = i))

	const parseLine = (line: string): string[] => {
		const out: string[] = []
		let cur = ""
		let inQuotes = false
		for (let i = 0; i < line.length; i++) {
			const ch = line[i]!
			if (ch === '"') {
				inQuotes = !inQuotes
				continue
			}
			if (ch === "," && !inQuotes) {
				out.push(cur)
				cur = ""
			} else {
				cur += ch
			}
		}
		out.push(cur)
		return out.map((s) => s.trim())
	}

	const get = (raw: string[], key: string): string => {
		const idx = colIndex[key]
		return idx === undefined ? "" : (raw[idx] ?? "")
	}

	for (let i = 1; i < lines.length; i++) {
		const raw = parseLine(lines[i]!)
		if (raw.every((c) => c === "")) continue
		const mode = get(raw, "taskParams mode").toLowerCase() as Mode
		if (!mode) continue
		const scenario: Scenario = {
			mode,
			installArgsChanged: toBool(
				get(raw, "installArgsChanged") || "FALSE",
			),
			upgradeArgsChanged: toBool(
				get(raw, "upgradeArgsChanged") || "FALSE",
			),
			canisterExists: toBool(get(raw, "canisterExists") || "FALSE"),
			modulePresent: toBool(get(raw, "modulePresent") || "FALSE"),
			installCacheExists: toBool(
				get(raw, "installCacheExists") || "FALSE",
			),
			upgradeCacheExists: toBool(
				get(raw, "upgradeCacheExists") || "FALSE",
			),
			resolvedMode: (get(raw, "resolvedMode") || "install") as
				| "install"
				| "reinstall"
				| "upgrade",
			cacheUsed: (get(raw, "cacheUsed") || undefined) as
				| "install"
				| "upgrade"
				| undefined,
			expectedOutcome: (get(raw, "expectedOutcome") || "OK").replace(
				/!/g,
				"!",
			) as "OK" | "ERROR!",
			notes: get(raw, "notes") || undefined,
		}
		rows.push(scenario)
	}
	return rows
}

const csvPath = path.resolve(__dirname, "../fixtures/deploytable.csv")
const csv = fs.readFileSync(csvPath, "utf8")
const scenarios = parseCsv(csv)

describe("deployments & caching decision table", () => {
	it.each(
		scenarios.map((s, idx) => [idx + 1, s]) as Array<[number, Scenario]>,
	)("scenario #%s: %o", async (idx, s) => {
		const { runtime, telemetryExporter, customCanister } =
			await Effect.runPromise(
				Effect.gen(function* () {
					const result = yield* makeTestEnvEffect(
						`.ice_test/deploy_${idx}`,
					)
					return result
				}).pipe(Effect.scoped),
			)

		const wasm = path.resolve(
			__dirname,
			"../fixtures/canister/example.wasm",
		)
		const candid = path.resolve(
			__dirname,
			"../fixtures/canister/example.did",
		)

		// make canister name unique per scenario to avoid cross-scenario cache/deployments
		const canisterKey = `scenario_canister_${idx}`

		// Seed functions (baseline, no init/upgrade args)
		const seedInstallArgs = async () => [] as unknown[]
		const seedUpgradeArgs = async () => [] as unknown[]

		// Current run functions (vary function identity only; still return empty args)
		const installArgsSame = async () => [] as unknown[]
		const installArgsChanged = async () => {
			const variation = 1 // change identity without changing return value
			return [] as unknown[]
		}
		const upgradeArgsSame = async () => [] as unknown[]
		const upgradeArgsChanged = async () => {
			const variation = 2 // change identity without changing return value
			return [] as unknown[]
		}

		const installArgsFn = s.installArgsChanged
			? installArgsChanged
			: installArgsSame
		const upgradeArgsFn = s.upgradeArgsChanged
			? upgradeArgsChanged
			: upgradeArgsSame

		const stripCanisterCache = <S extends CustomCanisterScope>(
			scope: S,
		) => {
			const stripCache = <T extends Task>(t: T) => {
				if (!t || t._tag !== "task") return t
				const c = { ...t }
				// @ts-ignore
				delete c.computeCacheKey
				// @ts-ignore
				delete c.input
				// @ts-ignore
				delete c.encode
				// @ts-ignore
				delete c.decode
				// @ts-ignore
				delete c.encodingFormat
				// @ts-ignore
				delete c.revalidate
				return c as unknown as T
			}
			const updatedScope = {
				...scope,
				children: {
					...scope.children,
					install_args: stripCache(scope.children.install_args),
					install: stripCache(scope.children.install),
					build: stripCache(scope.children.build),
					bindings: stripCache(scope.children.bindings),
				},
			}
			// still has cache types but fine for now.
			return updatedScope satisfies S as S
		}

		// Pre-setup state based on table flags
		const seededCanisterId = await runtime.runPromise(
			Effect.gen(function* () {
				const seedScope = customCanister({ wasm, candid })
					.installArgs(seedInstallArgs)
					.upgradeArgs(seedUpgradeArgs)
					.make()
				const seed_canister = s.installCacheExists
					? seedScope
					: stripCanisterCache(seedScope)
				const taskTreeSeed = { [canisterKey]: seed_canister } as Record<
					string,
					any
				>

				// Build a seed-specific layer: when cacheExists=false, block deployment writes
				// const uncachedLayer =
				const cachedLayer = yield* Layer.memoize(
					Layer.mergeAll(DeploymentsService.Live),
				)
				const uncachedLayer = yield* Layer.memoize(
					Layer.mergeAll(
						Layer.effect(
							DeploymentsService,
							Effect.succeed({
								get: (
									_canisterName: string,
									_network: string,
								) => Effect.succeed(Option.none()), // not used in seed
								set: (_: {
									canisterName: string
									network: string
									deployment: unknown
								}) => Effect.succeed(undefined),
							}),
						),
					),
				)
				const { runTask: runTaskUncached } = yield* makeTaskRunner(
					taskTreeSeed,
				).pipe(Effect.provide(uncachedLayer))
				const { runTask: runTaskCached } = yield* makeTaskRunner(
					taskTreeSeed,
				).pipe(Effect.provide(cachedLayer))
				let createdId: string | undefined
				if (s.canisterExists) {
					if (s.modulePresent) {
						// Deploy once to create canister, install module
						const res = s.installCacheExists
							? yield* runTaskCached(
									seed_canister.children.deploy,
									{ mode: "install" as const },
								)
							: yield* runTaskUncached(
									seed_canister.children.deploy,
									{ mode: "install" as const },
								)
						// .pipe(
						// 	Effect.provide(
						// 		s.installCacheExists
						// 			? cachedLayer
						// 			: uncachedLayer,
						// 	),
						// )
						createdId = res.canisterId
						if (s.upgradeCacheExists) {
							yield* runTaskCached(
								seed_canister.children.deploy,
								{ mode: "upgrade" as const },
							)
						}
					} else {
						// Only create canister; no module installed
						createdId = yield* runTaskCached(
							seed_canister.children.create,
						)
						// Prepare artifacts for later install args encoding
						yield* runTaskCached(seed_canister.children.build)
						yield* runTaskCached(seed_canister.children.bindings)
					}
				}
				// If explicit cacheExists and we haven't deployed above, seed caches for args/build
				if (
					s.installCacheExists &&
					!(s.canisterExists && s.modulePresent)
				) {
					if (!createdId) {
						createdId = yield* runTaskCached(
							seed_canister.children.create,
						)
					}
					yield* runTaskCached(seed_canister.children.build)
					yield* runTaskCached(seed_canister.children.bindings)
				}
				// Ensure cacheExists=false means no last deployment info
				// TODO: need to make sure not cached
				return createdId
			}).pipe(Effect.scoped),
		)

		// Count install span cache hits before main run to detect cache-hit delta
		const beforeInstallCacheHits = telemetryExporter
			.getFinishedSpans()
			.filter(
				(s: any) =>
					s.name === "task_execute_effect" &&
					s.attributes?.["taskPath"] === `${canisterKey}:install` &&
					s.attributes?.["cacheHit"] === true,
				// TODO: mode install
			).length
		// Count install span cache hits before main run to detect cache-hit delta
		const beforeUpgradeCacheHits = telemetryExporter
			.getFinishedSpans()
			.filter(
				(s: any) =>
					s.name === "task_execute_effect" &&
					s.attributes?.["taskPath"] === `${canisterKey}:install` &&
					s.attributes?.["cacheHit"] === true,
				// TODO: mode upgrade
			).length

		// const scenario_canister = makeCan("current")
		const scenario_canister = customCanister({ wasm, candid })
			.installArgs(installArgsFn)
			.upgradeArgs(upgradeArgsFn)
			.make()
		const taskTree = { [canisterKey]: scenario_canister } as Record<
			string,
			any
		>
		// Execute main deploy with requested mode (internally runs install)
		const runMain = () =>
			runtime.runPromise(
				Effect.gen(function* () {
					const { runTask } = yield* makeTaskRunner(taskTree)
					// Ensure artifacts exist for install
					yield* runTask(scenario_canister.children.build)
					yield* runTask(scenario_canister.children.bindings)
					// If no canister id and mode requires existing, expect error later
					const deployArgs: any = {
						mode: s.mode as
							| "auto"
							| "install"
							| "reinstall"
							| "upgrade",
					}
					if (seededCanisterId)
						deployArgs.canisterId = seededCanisterId
					const result = yield* runTask(
						scenario_canister.children.deploy,
						deployArgs,
					)
					// // Support special value "latest" in CSV: interpret as last recorded deployment mode
					const Deployments = yield* DeploymentsService
					const maybeLastDep = yield* Deployments.get(
						canisterKey,
						"local",
					)
					const lastDep = Option.getOrThrow(maybeLastDep)
					const resolvedMode = lastDep.mode
					return { result, resolvedMode }
				}),
			)

		if (s.expectedOutcome === "ERROR!") {
			await expect(runMain()).rejects.toThrow()
			return
		}

		const { result, resolvedMode } = await runMain()
		expect(result).toMatchObject({
			canisterId: expect.any(String),
			canisterName: expect.any(String),
		})

		if (s.resolvedMode === "latest") {
			expect(["install", "upgrade"]).toContain(resolvedMode)
		} else {
			expect(resolvedMode).toBe(s.resolvedMode)
		}
		// expect(resolvedMode).toBe(s.resolvedMode)

		const afterInstallCacheHits = telemetryExporter
			.getFinishedSpans()
			.filter(
				(sp: any) =>
					sp.name === "task_execute_effect" &&
					sp.attributes?.["taskPath"] === `${canisterKey}:install` &&
					sp.attributes?.["resolvedMode"] === "install" &&
					sp.attributes?.["cacheHit"] === true,
			).length
		const afterUpgradeCacheHits = telemetryExporter
			.getFinishedSpans()
			.filter(
				(sp: any) =>
					sp.name === "task_execute_effect" &&
					sp.attributes?.["taskPath"] === `${canisterKey}:install` &&
					sp.attributes?.["resolvedMode"] === "upgrade" &&
					sp.attributes?.["cacheHit"] === true,
			).length
		const installHitsThisRun =
			afterInstallCacheHits - beforeInstallCacheHits
		const upgradeHitsThisRun =
			afterUpgradeCacheHits - beforeUpgradeCacheHits
		if (s.cacheUsed === "install") {
			expect(installHitsThisRun > 0).toBe(true)
			expect(upgradeHitsThisRun > 0).toBe(false)
		} else if (s.cacheUsed === "upgrade") {
			expect(upgradeHitsThisRun > 0).toBe(true)
			expect(installHitsThisRun > 0).toBe(false)
		} else {
			expect(installHitsThisRun + upgradeHitsThisRun > 0).toBe(false)
		}
	})
})
