import fs from "node:fs"
import path from "node:path"
import { describe, it, expect, afterAll } from "vitest"
import { Effect, Layer, LogLevel, ManagedRuntime } from "effect"
// Reuse same env helper as other integration tests
import { makeTestEnvEffect } from "./setup.js"
import { DeploymentsService } from "../../src/services/deployments.js"
import { Option } from "effect"
import {
	CustomCanisterScope,
	customCanister,
} from "../../src/builders/custom.js"
import { PICReplica } from "../../src/services/pic/pic.js"
import { CachedTask, Task } from "../../src/types/types.js"
import { ICEConfigService } from "../../src/services/iceConfig.js"
import { layerMemory } from "@effect/platform/KeyValueStore"
import { TaskRuntime } from "../../src/services/taskRuntime.js"
import { runTask } from "../../src/tasks/run.js"
import { ICEConfig } from "../../src/types/types.js"
import { KeyValueStore } from "@effect/platform"
import { CanisterIdsService } from "../../src/services/canisterIds.js"
import { IcpConfigFlag } from "@dfinity/pic"
import { spawn } from "node:child_process"
import { pocketIcPath } from "@ice.ts/pocket-ic"

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
	cacheUsed: "install" | "upgrade" | "latest" | undefined
	lastDeployment: "install" | "upgrade" | undefined
	expectedOutcome: "OK" | "ERROR!"
	notes: string | undefined
	lineNumber: number
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
				| "upgrade"
				| "latest",
			cacheUsed: (get(raw, "cacheUsed") || undefined) as
				| "install"
				| "upgrade"
				| "latest"
				| undefined,
			lastDeployment: (get(raw, "lastDeployment") || undefined) as
				| "install"
				| "upgrade"
				| undefined,
			expectedOutcome: (get(raw, "expectedOutcome") || "OK").replace(
				/!/g,
				"!",
			) as "OK" | "ERROR!",
			notes: get(raw, "notes") || undefined,
			lineNumber: i + 1,
		}
		rows.push(scenario)
	}
	return rows
}

const csvPath = path.resolve(__dirname, "../fixtures/deploy_table.csv")
const csv = fs.readFileSync(csvPath, "utf8")
const allScenarios = parseCsv(csv)
// const allScenarios = parseCsv(csv).slice(1 - 1, 10 - 1)
// const scenarios = allScenarios
// const scenarios = allScenarios.slice(0, 10)
const stripCanisterCache = <S extends CustomCanisterScope>(scope: S) => {
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

// const scenarios = [parseCsv(csv)[24]!]

// TODO: not working properly?
// const SHARDS = Number(process.env["SHARDS"]) || 1
// const SHARD = Number(process.env["SHARD"]) || 0
// const scenarios =
// 	SHARDS > 1
// 		? allScenarios.filter((_, i) => i % SHARDS === SHARD)
// 		: allScenarios

describe("deployments & caching decision table", () => {
	it.each(
		allScenarios.map((s, idx) => [idx + 1, s, s.lineNumber]) as Array<
			[number, Scenario, number]
		>,
	)("scenario #%s: %o. line number: %s", async (idx, s, lineNumber) => {
		const iceDirPath = path.join(`.ice_test/${idx}`)
		const globalArgs = {
			network: "local",
			logLevel: "info",
			background: false,
			policy: "reuse",
			// manual: true,
			// or flag for auto-confirm install?
			origin: "cli",
			iceDirPath,
		} as const

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

		const seed_canister = customCanister({ wasm, candid })
			.installArgs(seedInstallArgs)
			.upgradeArgs(seedUpgradeArgs)
			.make()

		const scenario_canister = customCanister({ wasm, candid })
			.installArgs(installArgsFn)
			.upgradeArgs(upgradeArgsFn)
			.make()

		const taskTreeSeed = {
			[canisterKey]: seed_canister,
		}

		const taskTreeScenario = {
			[canisterKey]: scenario_canister,
		}

		const picReplica = new PICReplica({
			host: "0.0.0.0",
			port: 8081 + idx,
			ttlSeconds: 9999999999,
			manual: false,
			picConfig: {
				icpConfig: { betaFeatures: IcpConfigFlag.Enabled },
			},
		})
		const config = {
			network: "local",
			replica: picReplica,
		} satisfies ICEConfig
		const {
			runtime: runtimeSeed,
			telemetryExporter: telemetryExporterSeed,
		} = makeTestEnvEffect(idx, globalArgs, taskTreeSeed, config)
		const {
			runtime: runtimeScenario,
			telemetryExporter: telemetryExporterScenario,
			// customCanister: customCanisterScenario,
		} = makeTestEnvEffect(idx, globalArgs, taskTreeScenario, config)

		// Execute main deploy with requested mode (internally runs install)
		const runPrepare = () =>
			Effect.gen(function* () {
				const { replica } = yield* TaskRuntime
				yield* Effect.tryPromise({
					try: () => replica.start(globalArgs),
					catch: (error) => {
						return error
					},
				})

				let seededCanisterId: string | undefined
				if (s.canisterExists) {
					if (s.modulePresent) {
						console.log("s.modulePresent running install")
						const res = yield* runTask(
							(s.installCacheExists
								? seed_canister
								: stripCanisterCache(seed_canister)
							).children.deploy,
							{
								mode: "install" as const,
								forceReinstall: true,
							},
						)

						seededCanisterId = res.canisterId
						if (s.upgradeCacheExists) {
							console.log("s.upgradeCacheExists running upgrade")
							yield* runTask(
								(s.upgradeCacheExists
									? seed_canister
									: stripCanisterCache(seed_canister)
								).children.deploy,
								{
									mode: "upgrade" as const,
									forceReinstall: true,
								},
							)
						}

						if (s.lastDeployment === "install") {
							console.log(
								"s.lastDeployment === 'install' running reinstall",
							)
							yield* runTask(
								(s.installCacheExists
									? seed_canister
									: stripCanisterCache(seed_canister)
								).children.deploy,
								{
									mode: "reinstall" as const,
									// TODO: autoConfirm?
									forceReinstall: true,
								},
							)
						}

					} else {
						// Only create canister; no module installed
						const createResult = yield* runTask(
							seed_canister.children.create,
						)
						if (!createResult) {
							return yield* Effect.fail(
								new Error("Failed to create seed canister"),
							)
						}
						seededCanisterId = createResult
						// Prepare artifacts for later install args encoding
						const buildResult = yield* runTask(
							seed_canister.children.build,
						)

						yield* runTask(seed_canister.children.bindings)
					}
				}
				// If explicit cacheExists and we haven't deployed above, seed caches for args/build
				if (
					s.installCacheExists &&
					!(s.canisterExists && s.modulePresent)
				) {
					if (!seededCanisterId) {
						const createResult = yield* runTask(
							seed_canister.children.create,
						)
						if (!createResult) {
							return yield* Effect.fail(
								new Error("Failed to create seed canister"),
							)
						}
						seededCanisterId = createResult
					}
					yield* runTask(seed_canister.children.build)
					yield* runTask(seed_canister.children.bindings)
				}
				// Ensure cacheExists=false means no last deployment info
				// TODO: need to make sure not cached

				const beforeInstallCacheHits = telemetryExporterSeed
					.getFinishedSpans()
					.filter(
						(s) =>
							s.name === "task_execute_effect" &&
							s.attributes?.["taskPath"] ===
								`${canisterKey}:install` &&
							s.attributes?.["cacheHit"] === true &&
							s.attributes?.["computedMode"] === "install",
						// TODO: mode install
					).length

				// Count install span cache hits before main run to detect cache-hit delta
				const beforeUpgradeCacheHits = telemetryExporterSeed
					.getFinishedSpans()
					.filter(
						(s) =>
							s.name === "task_execute_effect" &&
							s.attributes?.["taskPath"] ===
								`${canisterKey}:install` &&
							s.attributes?.["cacheHit"] === true &&
							s.attributes?.["computedMode"] === "upgrade",
						// TODO: mode upgrade
					).length

				const Deployments = yield* DeploymentsService
				const maybeLastDep = yield* Deployments.get(
					canisterKey,
					"local",
				)
				// TODO: remove lastDeployment if needed
				console.log("checking s.lastDeployment", s.lastDeployment)
				if (
					s.lastDeployment !== "install" &&
					s.lastDeployment !== "upgrade" &&
					Option.isSome(maybeLastDep)
				) {
					console.log(
						"removing last deployment",
						canisterKey,
						"local",
					)
					yield* Deployments.remove(canisterKey, "local")
				}
				yield* Effect.logInfo("get last deployment", {
					lastDep: Option.isSome(maybeLastDep)
						? maybeLastDep.value
						: "none",
					Deployments: Deployments.serviceType,
				})
				const lastDeployment = Option.isSome(maybeLastDep)
					? maybeLastDep.value
					: undefined

				return {
					lastDeployment,
					beforeInstallCacheHits,
					beforeUpgradeCacheHits,
					seededCanisterId,
				}
			})

		const {
			lastDeployment,
			seededCanisterId,
			beforeInstallCacheHits,
			beforeUpgradeCacheHits,
		} = await runtimeSeed.runPromise(runPrepare())

		console.log("lastDeployment", lastDeployment)
		console.log("seededCanisterId", seededCanisterId)
		console.log("beforeInstallCacheHits", beforeInstallCacheHits)
		console.log("beforeUpgradeCacheHits", beforeUpgradeCacheHits)

		const runMain = () =>
			Effect.gen(function* () {
				const { replica } = yield* TaskRuntime
				yield* Effect.tryPromise({
					try: () => replica.start(globalArgs),
					catch: (error) => {
						return error
					},
				})

				// Ensure artifacts exist for install
				yield* runTask(scenario_canister.children.build)
				yield* runTask(scenario_canister.children.bindings)
				// If no canister id and mode requires existing, expect error later
				const deployArgs = {
					mode: s.mode as
						| "auto"
						| "install"
						| "reinstall"
						| "upgrade",
					...(seededCanisterId
						? { canisterId: seededCanisterId }
						: {}),
					forceReinstall: true,
				}

				console.log("running deploy with mode", deployArgs.mode)
				const result = yield* runTask(
					scenario_canister.children.deploy,
					deployArgs,
				)

				yield* Effect.tryPromise({
					try: () => replica.stop({ scope: "foreground" }),
					catch: (error) => {
						return error
					},
				})

				return {
					result,
				}
			})

		if (s.expectedOutcome === "ERROR!") {
			await expect(
				runtimeScenario.runPromise(runMain()),
			).rejects.toThrow()
			return
		}

		const {
			result,
		} = await runtimeScenario.runPromise(runMain())

		expect(result).toMatchObject({
			canisterId: expect.any(String),
			canisterName: expect.any(String),
		})
		const resolvedModeSpans = [
			telemetryExporterSeed,
			telemetryExporterScenario,
		]
			.map((te) =>
				te
					.getFinishedSpans()
					.filter(
						(sp) =>
							sp.name === "task_execute_effect" &&
							sp.attributes?.["taskPath"] ===
								`${canisterKey}:install`,
					),
			)
			.flat()
		const resolvedMode =
			resolvedModeSpans[resolvedModeSpans.length - 1]?.attributes?.[
				"resolvedMode"
			]

		console.log("resolvedModeSpans", resolvedModeSpans)

		if (s.resolvedMode === "latest") {
			expect(lastDeployment?.mode).toBe(s.resolvedMode)
		} else {
			expect(resolvedMode).toBe(s.resolvedMode)
		}

		const afterInstallCacheHitSpans = [
			telemetryExporterSeed,
			telemetryExporterScenario,
		]
			.map((te) =>
				te
					.getFinishedSpans()
					.filter(
						(sp) =>
							sp.name === "task_execute_effect" &&
							sp.attributes?.["taskPath"] ===
								`${canisterKey}:install` &&
							sp.attributes?.["computedMode"] === "install" &&
							sp.attributes?.["cacheHit"] === true,
					),
			)
			.flat()
		const afterInstallCacheHits = afterInstallCacheHitSpans.length
		const afterUpgradeCacheHitSpans = [
			telemetryExporterSeed,
			telemetryExporterScenario,
		]
			.map((te) =>
				te
					.getFinishedSpans()
					.filter(
						(sp) =>
							sp.name === "task_execute_effect" &&
							sp.attributes?.["taskPath"] ===
								`${canisterKey}:install` &&
							sp.attributes?.["computedMode"] === "upgrade" &&
							sp.attributes?.["cacheHit"] === true,
					),
			)
			.flat()
		const afterUpgradeCacheHits = afterUpgradeCacheHitSpans.length

		console.log("afterInstallCacheHitSpans", afterInstallCacheHitSpans)
		console.log("afterUpgradeCacheHitSpans", afterUpgradeCacheHitSpans)
		console.log("afterInstallCacheHits", afterInstallCacheHits)
		console.log("afterUpgradeCacheHits", afterUpgradeCacheHits)

		const installHitsThisRun =
			afterInstallCacheHits - beforeInstallCacheHits
		console.log("installHitsThisRun", installHitsThisRun)
		const upgradeHitsThisRun =
			afterUpgradeCacheHits - beforeUpgradeCacheHits
		if (s.cacheUsed === "install") {
			expect(installHitsThisRun > 0).toBe(true)
			expect(upgradeHitsThisRun > 0).toBe(false)
		} else if (s.cacheUsed === "upgrade") {
			expect(upgradeHitsThisRun > 0).toBe(true)
			expect(installHitsThisRun > 0).toBe(false)
		} else if (s.cacheUsed === "latest") {
			const latestMode = lastDeployment?.mode
			expect(installHitsThisRun > 0).toBe(latestMode === "install")
			expect(upgradeHitsThisRun > 0).toBe(latestMode === "upgrade")
		} else {
			expect(installHitsThisRun + upgradeHitsThisRun > 0).toBe(false)
		}

		await runtimeSeed.dispose()
		await runtimeScenario.dispose()
	})
	// afterAll(async () => {
	// 	const appDir = fs.realpathSync(process.cwd())
	// 	const result = await fs.promises.rmdir(
	// 		path.resolve(appDir, "./.ice_test"),
	// 		{ recursive: true },
	// 	)
	// })
})
