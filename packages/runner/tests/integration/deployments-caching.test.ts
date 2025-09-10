import fs from "node:fs"
import path from "node:path"
import { describe, it, expect } from "vitest"
import { Effect } from "effect"
import { makeTaskRunner } from "./setup.js"
// Reuse same env helper as other integration tests
import { makeTestEnv } from "./setup.js"
import { DeploymentsService } from "../../src/services/deployments.js"

type Mode = "auto" | "install" | "reinstall" | "upgrade"

type Scenario = {
	mode: Mode
	installArgsChanged: boolean
	upgradeArgsChanged: boolean
	canisterExists: boolean
	modulePresent: boolean
	cacheExists: boolean
	resolvedMode: "install" | "reinstall" | "upgrade"
	cacheUsed: boolean
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
			cacheExists: toBool(get(raw, "cacheExists") || "FALSE"),
			resolvedMode: (get(raw, "resolvedMode") || "install") as
				| "install"
				| "reinstall"
				| "upgrade",
			cacheUsed: toBool(get(raw, "cacheUsed") || "FALSE"),
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

const csvPath = path.resolve(__dirname, "../fixtures/deploy_table.csv")
const csv = fs.readFileSync(csvPath, "utf8")
const scenarios = parseCsv(csv)

describe("deployments & caching decision table", () => {
	it.each(
		scenarios.map((s, idx) => [idx + 1, s]) as Array<[number, Scenario]>,
	)("scenario #%s: %o", async (idx, s) => {
		const { runtime, telemetryExporter, customCanister } = makeTestEnv(
			`.ice_test/deploy_${idx}`,
		)

		const wasm = path.resolve(
			__dirname,
			"../fixtures/canister/example.wasm",
		)
		const candid = path.resolve(
			__dirname,
			"../fixtures/canister/example.did",
		)

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

		const makeCan = (variant: "seed" | "current", cached: boolean = true) => {
			const scope = customCanister({ wasm, candid })
				.installArgs(
					variant === "seed" ? seedInstallArgs : installArgsFn,
				)
				.upgradeArgs(
					variant === "seed" ? seedUpgradeArgs : upgradeArgsFn,
				)
				.make()
			// If seeding and cacheExists=false, disable caching for these tasks to simulate no cache
			if (!cached) {
				const stripCache = (t: any) => {
					if (!t || t._tag !== "task") return t
					const c = { ...t }
					delete c.computeCacheKey
					delete c.input
					delete c.encode
					delete c.decode
					delete c.encodingFormat
					delete c.revalidate
					return c
				}
				scope.children.install_args = stripCache(
					scope.children.install_args,
				)
				scope.children.install = stripCache(scope.children.install)
				scope.children.build = stripCache(scope.children.build)
				scope.children.bindings = stripCache(scope.children.bindings)
			}
			return scope
		}

		const seed_canister = makeCan("seed", s.cacheExists)
		const taskTreeSeed = { scenario_canister: seed_canister }

		// Pre-setup state based on table flags
		const seededCanisterId = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTask } = yield* makeTaskRunner(taskTreeSeed)
				let createdId: string | undefined
				if (s.canisterExists) {
					if (s.modulePresent) {
						// Deploy once to create canister, install module, and seed caches
						const res = yield* runTask(
							seed_canister.children.deploy,
							{ mode: "install" as const },
						)
						createdId = res.canisterId
					} else {
						// Only create canister; no module installed
						createdId = yield* runTask(
							seed_canister.children.create,
						)
						// Prepare artifacts for later install args encoding
						yield* runTask(seed_canister.children.build)
						yield* runTask(seed_canister.children.bindings)
					}
				}
				// If explicit cacheExists and we haven't deployed above, seed caches for args/build
				if (s.cacheExists && !(s.canisterExists && s.modulePresent)) {
					if (!createdId) {
						createdId = yield* runTask(
							seed_canister.children.create,
						)
					}
					yield* runTask(seed_canister.children.build)
					yield* runTask(seed_canister.children.bindings)
				}
				// Ensure cacheExists=false means no last deployment info
                // TODO: need to make sure not cached
				return createdId
			}),
		)

		// Count install span cache hits before main run to detect cache-hit delta
		const beforeInstallCacheHits = telemetryExporter
			.getFinishedSpans()
			.filter(
				(s: any) =>
					s.name === "task_execute_effect" &&
					s.attributes?.["taskPath"] ===
						"scenario_canister:install" &&
					s.attributes?.["cacheHit"] === true,
			).length

		const canister = makeCan("current")
		const taskTree = { scenario_canister: canister }
		// Execute main deploy with requested mode (internally runs install)
		const runMain = () =>
			runtime.runPromise(
				Effect.gen(function* () {
					const { runTask } = yield* makeTaskRunner(taskTree)
					// Ensure artifacts exist for install
					yield* runTask(canister.children.build)
					yield* runTask(canister.children.bindings)
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
						canister.children.deploy,
						deployArgs,
					)
					return result
				}),
			)

		if (s.expectedOutcome === "ERROR!") {
			await expect(runMain()).rejects.toThrow()
			return
		}

		const result = await runMain()
		expect(result).toMatchObject({
			canisterId: expect.any(String),
			canisterName: expect.any(String),
		})
		expect(result.mode).toBe(s.resolvedMode)

		const afterInstallCacheHits = telemetryExporter
			.getFinishedSpans()
			.filter(
				(sp: any) =>
					sp.name === "task_execute_effect" &&
					sp.attributes?.["taskPath"] ===
						"scenario_canister:install" &&
					sp.attributes?.["cacheHit"] === true,
			).length
		const cacheHitsThisRun = afterInstallCacheHits - beforeInstallCacheHits
		const cacheUsedThisRun = cacheHitsThisRun > 0
		expect(cacheUsedThisRun).toBe(s.cacheUsed)
	})
})
