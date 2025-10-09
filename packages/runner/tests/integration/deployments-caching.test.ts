import fs from "node:fs"
import path from "node:path"
import { describe, it, expect, afterAll } from "vitest"
import { Effect, Layer, LogLevel, ManagedRuntime } from "effect"
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
import { ICEConfigService } from "../../src/services/iceConfig.js"
import { layerMemory } from "@effect/platform/KeyValueStore"
import { makeTaskLayer } from "../../src/services/taskRuntime.js"
import { TaskRuntime } from "../../src/services/taskRuntime.js"
import { TaskRunnerShape } from "./setup.js"
import { TaskParamsToArgs, TaskRuntimeError } from "../../src/tasks/lib.js"
import { runTask } from "../../src/tasks/run.js"
import { runTasks } from "../../src/tasks/run.js"
import { ICEConfig } from "../../src/types/types.js"
import { KeyValueStore } from "@effect/platform"
import { CanisterIdsService } from "../../src/services/canisterIds.js"

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

const csvPath = path.resolve(__dirname, "../fixtures/deploytable.csv")
const csv = fs.readFileSync(csvPath, "utf8")
const allScenarios = parseCsv(csv)
// const scenarios = allScenarios
// const scenarios = allScenarios.slice(0, 10)
const globalArgs = {
	network: "local",
	logLevel: "debug",
	background: false,
} as const

// const scenarios = [parseCsv(csv)[24]!]

// TODO: not working properly?
const SHARDS = Number(process.env["SHARDS"]) || 1
const SHARD = Number(process.env["SHARD"]) || 0
const scenarios =
	SHARDS > 1
		? allScenarios.filter((_, i) => i % SHARDS === SHARD)
		: allScenarios

describe("deployments & caching decision table", () => {
	it.concurrent.each(
		scenarios.map((s, idx) => [
			idx + 1 + SHARD * SHARDS,
			s,
			s.lineNumber,
		]) as Array<[number, Scenario, number]>,
	)("scenario #%s: %o. line number: %s", async (idx, s, lineNumber) => {
		const { runtime, telemetryExporter, customCanister } =
			makeTestEnvEffect(`.ice_test/deploy_${idx}`, globalArgs)

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

		// Execute main deploy with requested mode (internally runs install)
		const runMain = () =>
			runtime.runPromise(
				Effect.gen(function* () {
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

					const taskTree = {
						[canisterKey]: scenario_canister,
					}

					const config = {} satisfies Partial<ICEConfig>
					const ICEConfigSeed = ICEConfigService.Test(
						globalArgs,
						taskTreeSeed,
						config,
					)
					const ICEConfigScenario = ICEConfigService.Test(
						globalArgs,
						taskTree,
						config,
					)
					const KVStorageImpl = yield* KeyValueStore.KeyValueStore
					const KVStorageLayer = Layer.succeed(
						KeyValueStore.KeyValueStore,
						KVStorageImpl,
					)
					const DeploymentsLayer = DeploymentsService.Live.pipe(
						Layer.provide(KVStorageLayer),
					)

					const DeploymentsNoOpLayer = Layer.effect(
						DeploymentsService,
						Effect.succeed({
							get: (_canisterName: string, _network: string) =>
								Effect.succeed(Option.none()), // not used in seed
							set: (_: {
								canisterName: string
								network: string
								deployment: unknown
							}) => Effect.succeed(undefined),
							serviceType: "NoOp",
						}),
					)

					const CanisterIdsImpl = yield* CanisterIdsService
					const CanisterIdsLayer = Layer.succeed(
						CanisterIdsService,
						CanisterIdsImpl,
					)

					const { taskLayer: taskLayerSeed, runtime: runtimeSeed } =
						yield* makeTaskLayer(globalArgs)
							// inject layer at call site
							.pipe(
								Effect.provide(ICEConfigSeed),
								Effect.provide(DeploymentsLayer),
								// Effect.provide(CanisterIdsLayer),
							)
					const ChildTaskRuntimeSeedLayer = Layer.succeed(
						TaskRuntime,
						{
							runtime: runtimeSeed,
							taskLayer: taskLayerSeed,
						},
					)

					let seededCanisterId: string | undefined
					if (s.canisterExists) {
						if (s.modulePresent) {
							// Deploy once to create canister, install module

							const {
								taskLayer: taskLayerSeedInstall,
								runtime: runtimeSeedInstall,
							} = yield* makeTaskLayer(globalArgs)
								// inject layer at call site
								.pipe(
									Effect.provide(ICEConfigSeed),
									Effect.provide(
										s.installArgsChanged ||
											s.installCacheExists
											? DeploymentsLayer
											: DeploymentsNoOpLayer,
									),
								)
							const ChildTaskRuntimeSeedInstallLayer =
								Layer.succeed(TaskRuntime, {
									runtime: runtimeSeedInstall,
									taskLayer: taskLayerSeedInstall,
								})

							const res = yield* runTask(
								(s.installCacheExists
									? seed_canister
									: stripCanisterCache(seed_canister)
								).children.deploy,
								{ mode: "install" as const },
							).pipe(
								Effect.provide(taskLayerSeedInstall),
								Effect.provide(
									ChildTaskRuntimeSeedInstallLayer,
								),
							)

							seededCanisterId = res.canisterId
							if (s.upgradeCacheExists) {
								const {
									taskLayer: taskLayerSeedUpgrade,
									runtime: runtimeSeedUpgrade,
								} = yield* makeTaskLayer(globalArgs)
									// inject layer at call site
									.pipe(
										Effect.provide(ICEConfigSeed),
										Effect.provide(DeploymentsLayer),
									)
								const ChildTaskRuntimeSeedUpgradeLayer =
									Layer.succeed(TaskRuntime, {
										runtime: runtimeSeedUpgrade,
										taskLayer: taskLayerSeedUpgrade,
									})
								yield* runTask(
									(s.upgradeCacheExists
										? seed_canister
										: stripCanisterCache(seed_canister)
									).children.deploy,
									{
										mode: "upgrade" as const,
									},
								).pipe(
									Effect.provide(taskLayerSeedUpgrade),
									Effect.provide(
										ChildTaskRuntimeSeedUpgradeLayer,
									),
								)
							}

							if (s.lastDeployment === "install") {
								const {
									taskLayer: taskLayerSeedLastDeployment,
									runtime: runtimeSeedLastDeployment,
								} = yield* makeTaskLayer(globalArgs)
									// inject layer at call site
									.pipe(
										Effect.provide(ICEConfigSeed),
										Effect.provide(DeploymentsLayer),
									)
								const ChildTaskRuntimeSeedLastDeploymentLayer =
									Layer.succeed(TaskRuntime, {
										runtime: runtimeSeedLastDeployment,
										taskLayer: taskLayerSeedLastDeployment,
									})
								yield* runTask(
									(s.installCacheExists
										? seed_canister
										: stripCanisterCache(seed_canister)
									).children.deploy,
									{
										mode: "reinstall" as const,
									},
								).pipe(
									Effect.provide(taskLayerSeedLastDeployment),
									Effect.provide(
										ChildTaskRuntimeSeedLastDeploymentLayer,
									),
								)
							}

							// if (s.lastDeployment) {
							// 	const cacheExists =
							// 		s.lastDeployment === "upgrade"
							// 			? s.upgradeCacheExists
							// 			: s.installCacheExists
							// 	const {
							// 		taskLayer: taskLayerSeedLastDeployment,
							// 	} = yield* makeTaskLayer()
							// 		// inject layer at call site
							// 		.pipe(
							// 			Effect.provide(ICEConfigSeed),
							// 			Effect.provide(DeploymentsLayer),
							// 		)
							// 	yield* runTask(
							// 		(cacheExists
							// 			? seed_canister
							// 			: stripCanisterCache(seed_canister)
							// 		).children.deploy,
							// 		{
							// 			mode:
							// 				s.lastDeployment === "upgrade"
							// 					? "upgrade"
							// 					: "reinstall",
							// 		},
							// 	).pipe(
							// 		Effect.provide(taskLayerSeedLastDeployment),
							// 	)
							// }
						} else {
							// Only create canister; no module installed
							seededCanisterId = yield* runTask(
								seed_canister.children.create,
							).pipe(
								Effect.provide(taskLayerSeed),
								Effect.provide(ChildTaskRuntimeSeedLayer),
							)
							// Prepare artifacts for later install args encoding
							yield* runTask(seed_canister.children.build).pipe(
								Effect.provide(taskLayerSeed),
								Effect.provide(ChildTaskRuntimeSeedLayer),
							)

							yield* runTask(
								seed_canister.children.bindings,
							).pipe(
								Effect.provide(taskLayerSeed),
								Effect.provide(ChildTaskRuntimeSeedLayer),
							)
						}
					}
					// If explicit cacheExists and we haven't deployed above, seed caches for args/build
					if (
						s.installCacheExists &&
						!(s.canisterExists && s.modulePresent)
					) {
						if (!seededCanisterId) {
							seededCanisterId = yield* runTask(
								seed_canister.children.create,
							).pipe(
								Effect.provide(taskLayerSeed),
								Effect.provide(ChildTaskRuntimeSeedLayer),
							)
						}
						yield* runTask(seed_canister.children.build).pipe(
							Effect.provide(taskLayerSeed),
							Effect.provide(ChildTaskRuntimeSeedLayer),
						)
						yield* runTask(seed_canister.children.bindings).pipe(
							Effect.provide(taskLayerSeed),
							Effect.provide(ChildTaskRuntimeSeedLayer),
						)
					}
					// Ensure cacheExists=false means no last deployment info
					// TODO: need to make sure not cached

					const beforeInstallCacheHits = telemetryExporter
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
					const beforeUpgradeCacheHits = telemetryExporter
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

					const {
						taskLayer: taskLayerScenario,
						runtime: runtimeScenario,
					} = yield* makeTaskLayer(globalArgs)
						// inject layer at call site
						.pipe(
							Effect.provide(ICEConfigScenario),
							Effect.provide(DeploymentsLayer),
							// Effect.provide(CanisterIdsLayer),
						)
					const ChildTaskRuntimeScenarioLayer = Layer.succeed(
						TaskRuntime,
						{
							runtime: runtimeScenario,
							taskLayer: taskLayerScenario,
						},
					)

					// Ensure artifacts exist for install
					yield* runTask(scenario_canister.children.build).pipe(
						Effect.provide(taskLayerScenario),
						Effect.provide(ChildTaskRuntimeScenarioLayer),
					)
					yield* runTask(scenario_canister.children.bindings).pipe(
						Effect.provide(taskLayerScenario),
						Effect.provide(ChildTaskRuntimeScenarioLayer),
					)

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
					}

					const result = yield* runTask(
						scenario_canister.children.deploy,
						deployArgs,
					).pipe(
						Effect.provide(taskLayerScenario),
						Effect.provide(ChildTaskRuntimeScenarioLayer),
					)

					// // Support special value "latest" in CSV: interpret as last recorded deployment mode
					const {
						// resolvedMode,
						lastDeployment,
					} = yield* Effect.gen(function* () {
						const Deployments = yield* DeploymentsService
						const maybeLastDep = yield* Deployments.get(
							canisterKey,
							"local",
						)
						yield* Effect.logInfo("get last deployment", {
							lastDep: Option.isSome(maybeLastDep)
								? maybeLastDep.value
								: "none",
							Deployments: Deployments.serviceType,
						})
						const lastDep = Option.getOrThrow(maybeLastDep)
						// // TODO: wrong
						// const resolvedMode = lastDep.mode
						return {
							// resolvedMode,
							lastDeployment: lastDep,
						}
					}).pipe(Effect.provide(taskLayerScenario))
					return {
						result,
						// resolvedMode,
						lastDeployment,
						beforeInstallCacheHits,
						beforeUpgradeCacheHits,
					}
				}),
			)

		if (s.expectedOutcome === "ERROR!") {
			await expect(runMain()).rejects.toThrow()
			return
		}

		const {
			result,
			// resolvedMode,
			lastDeployment,
			beforeInstallCacheHits,
			beforeUpgradeCacheHits,
		} = await runMain()
		expect(result).toMatchObject({
			canisterId: expect.any(String),
			canisterName: expect.any(String),
		})
		const resolvedModeSpans = telemetryExporter
			.getFinishedSpans()
			.filter(
				(sp) =>
					sp.name === "task_execute_effect" &&
					sp.attributes?.["taskPath"] === `${canisterKey}:install`,
			)
		const resolvedMode =
			resolvedModeSpans[resolvedModeSpans.length - 1]?.attributes?.[
				"resolvedMode"
			]

		// console.log("resolvedModeSpans", resolvedModeSpans)
		// console.log("resolvedMode", resolvedMode)

		if (s.resolvedMode === "latest") {
			// this makes the test pass but may cause false positives
			// expect(["install", "upgrade"]).toContain(resolvedMode)
			// TODO: tests dont specify which deployment is the latest
			expect(lastDeployment?.mode).toBe(s.resolvedMode)
		} else {
			expect(resolvedMode).toBe(s.resolvedMode)
		}

		const afterInstallCacheHits = telemetryExporter
			.getFinishedSpans()
			.filter(
				(sp) =>
					sp.name === "task_execute_effect" &&
					sp.attributes?.["taskPath"] === `${canisterKey}:install` &&
					sp.attributes?.["computedMode"] === "install" &&
					sp.attributes?.["cacheHit"] === true,
			).length
		const afterUpgradeCacheHits = telemetryExporter
			.getFinishedSpans()
			.filter(
				(sp) =>
					sp.name === "task_execute_effect" &&
					sp.attributes?.["taskPath"] === `${canisterKey}:install` &&
					sp.attributes?.["computedMode"] === "upgrade" &&
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
		} else if (s.cacheUsed === "latest") {
			const latestMode = lastDeployment?.mode
			expect(installHitsThisRun > 0).toBe(latestMode === "install")
			expect(upgradeHitsThisRun > 0).toBe(latestMode === "upgrade")
		} else {
			expect(installHitsThisRun + upgradeHitsThisRun > 0).toBe(false)
		}

		await runtime.dispose()
	})
	afterAll(async () => {
		const appDir = fs.realpathSync(process.cwd())
		const result = await fs.promises.rmdir(
			path.resolve(appDir, "./.ice_test"),
			{ recursive: true },
		)
	})
})
