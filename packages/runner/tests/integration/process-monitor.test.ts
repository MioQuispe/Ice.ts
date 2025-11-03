// packages/runner/tests/integration/process_monitor.scenarios.test.ts

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import net from "node:net"
import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { setTimeout as sleep } from "node:timers/promises"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Scope } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { KeyValueStore } from "@effect/platform"
import { ICEConfigService } from "../../src/services/iceConfig.js"
import { task } from "../../src/builders/task.js"
import { PICReplica as PocketICReplica } from "../../src/services/pic/pic.js"
import { runTask } from "../../src/tasks/run.js"
import { pocketIcPath } from "@ice.ts/pocket-ic"
import { IcpConfigFlag } from "@dfinity/pic"
import { Replica } from "../../src/services/replica.js"
import { TaskTree } from "../../src/types/types.js"
import { NodeContext } from "@effect/platform-node"
import { makeTestEnvEffect } from "./setup.js"
import { DeploymentsService } from "../../src/services/deployments.js"
import { ReplicaStartError } from "../../src/services/replica.js"
import { LeaseFile, PocketIcState } from "../../src/services/pic/pic-process.js"

// ----------------------------- CSV / Types ----------------------------------------

type RunMode = "fg" | "bg"
type ExistingServer = "none" | "managed_fg" | "managed_bg" | "manual"
type ArgsMismatch = "yes" | "no"
type ArgsMismatchSelection = "reuse" | "restart" | "-"

type ExpectedAction =
	| "spawn_new"
	| "reuse"
	| "restart"
	| "reject_in_use"
	| "attach_manual"
	| "reject_manual"

type PidChange = "new" | "same"
type ServerAfter = "managed_fg" | "managed_bg" | "manual" | "none"
type EphemeralLeasesAfter = "0" | "1" | "2"
type EphemeralLeasesBefore = "0" | "1" | "2"
type BgLeasesBefore = "0" | "1"
type BgLeasesAfter = "0" | "1"
type ErrorCode =
	| "-"
	| "PortInUseError"
	| "ManualPocketICPresentError"
	| "ProtectedServerError"

interface ScenarioRow {
	scenario: string
	run_mode: RunMode
	existing_server: ExistingServer
	args_mismatch: ArgsMismatch
	args_mismatch_selection: ArgsMismatchSelection
	ephemeral_leases_before: EphemeralLeasesBefore
	bg_leases_before: BgLeasesBefore
	bg_leases_after: BgLeasesAfter
	expected_action: ExpectedAction
	pid_change: PidChange
	server_after: ServerAfter
	ephemeral_leases_after: EphemeralLeasesAfter
	error: ErrorCode
	notes: string
}

// ----------------------------- Config ---------------------------------------------

const TEST_TMP_ROOT = path.join(tmpdir(), "pic-orch-scenarios-" + Date.now())
const FIXTURES_DIR = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"../fixtures",
)
const SCENARIOS_CSV_PATH = path.join(
	FIXTURES_DIR,
	"process_monitor_scenarios.csv",
)

const DEFAULT_BIND = "0.0.0.0"
const BASE_PORT = 18081 // per-scenario port = BASE_PORT + idx
const STABILIZE_MS = 200

// ----------------------------- Tiny CSV parser (semicolon) ------------------------

function splitSemicolonPreservingQuotes(line: string): string[] {
	const result: string[] = []
	let cur = ""
	let inQuote = false
	let quoteChar: '"' | "“" | "”" | "'" | null = null
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!
		if (!inQuote && c === ";") {
			result.push(cur)
			cur = ""
			continue
		}
		if (c === '"' || c === "'" || c === "“" || c === "”") {
			if (!inQuote) {
				inQuote = true
				quoteChar = c as any
				continue
			}
			if (c === quoteChar) {
				inQuote = false
				quoteChar = null
				continue
			}
		}
		cur += c
	}
	result.push(cur)
	return result.map((s) => s.trim().replace(/^["“']|["”']$/g, ""))
}

function loadScenarios(): ScenarioRow[] {
	const text = fs.readFileSync(SCENARIOS_CSV_PATH, "utf8")
	const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
	const header = splitSemicolonPreservingQuotes(lines[0]!)
	const out: ScenarioRow[] = []
	for (let i = 1; i < lines.length; i++) {
		const cols = splitSemicolonPreservingQuotes(lines[i]!)
		if (cols.length !== header.length) continue
		const row: any = {}
		header.forEach((h, idx) => (row[h] = cols[idx]))
		out.push(row as ScenarioRow)
	}
	return out
}

// ----------------------------- Public artifacts snapshot --------------------------

const statePath = (iceDir: string) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		return path.join(iceDir, "pocketic-server", "monitor.json")
	})

const leasesDir = (iceDir: string) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		return path.join(iceDir, "pocketic-server", "leases")
	})

const pidAlive = (pid?: number) =>
	Effect.sync(() => {
		if (!pid) return false
		try {
			process.kill(pid, 0)
			return true
		} catch {
			return false
		}
	})

const readJSON = <T>(
	p: string,
): Effect.Effect<T | undefined, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const raw = yield* fs
			.readFileString(p)
			.pipe(Effect.catchAll(() => Effect.succeed(undefined)))
		if (!raw) return undefined
		return yield* Effect.try({
			try: () => JSON.parse(raw) as T,
			catch: () => undefined,
		}).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
	})

const getLeases = (iceDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const leasesDirPath = yield* leasesDir(iceDir)
		console.log("leasesDirPath", leasesDirPath)
		const entries = yield* fs.readDirectory(leasesDirPath).pipe(
			Effect.catchAll((e) => {
				console.log(`[countFgLeases] Failed to read directory: ${e}`)
				return Effect.succeed([] as ReadonlyArray<string>)
			}),
		)
		const files = entries.filter((n) => n.endsWith(".json"))

		const fgLeases: LeaseFile[] = []
		const bgLeases: LeaseFile[] = []
		for (const n of files) {
			const filePath = path.join(leasesDirPath, n)
			const fs = yield* FileSystem.FileSystem
			const raw = yield* fs.readFileString(filePath)
			const lease = yield* Effect.try({
				try: () => JSON.parse(raw) as LeaseFile,
				catch: (e) => e,
			})
			if (lease.mode === "foreground") {
				fgLeases.push(lease)
			}
			if (lease.mode === "background") {
				bgLeases.push(lease)
			}
		}
		return { fgLeases, bgLeases }
	})

const portOccupied = (bind: string, port: number): Effect.Effect<boolean> =>
	Effect.async<boolean>((resume) => {
		const socket = net.connect({ host: bind, port })
		let settled = false
		const done = (v: boolean) => {
			if (!settled) {
				settled = true
				try {
					socket.destroy()
				} catch {}
				resume(Effect.succeed(v))
			}
		}
		socket.once("connect", () => done(true))
		socket.once("error", () => done(false))
		// In case connection hangs (rare for localhost), bound timeout:
		socket.setTimeout(200, () => done(false))
	})

// keep PocketIcState as you defined it above

type SnapManaged = {
	kind: "managed"
	mode: "foreground" | "background"
	startedAt?: number
	fgLeases: LeaseFile[]
	bgLeases: LeaseFile[]
}

type SnapManual = {
	kind: "manual"
	mode: undefined
	startedAt?: undefined
	fgLeases: []
	bgLeases: []
}

type SnapNone = {
	kind: "none"
	mode: undefined
	startedAt?: undefined
	fgLeases: []
	bgLeases: []
}

export type Snapshot = SnapManaged | SnapManual | SnapNone

const snapshot = (iceDir: string, bind: string, port: number) =>
	Effect.gen(function* () {
		const stateFilePath = yield* statePath(iceDir)
		const st = yield* readJSON<PocketIcState>(stateFilePath)

		const occupied = yield* portOccupied(bind, port)

		console.log("st", st)
		// TODO: occupied check not working???
		console.log("occupied", occupied)
		console.log("bind", bind)
		console.log("port", port)
		if (st?.managed) {
			console.log("checking leases")
			const startedAt = st.startedAt!
			const { fgLeases, bgLeases } = yield* getLeases(iceDir)
			let mode: "foreground" | "background" | undefined
			if (fgLeases.length > 0) {
				mode = "foreground"
			}
			if (bgLeases.length > 0) {
				mode = "background"
			}
			if (!mode) {
				console.error("Mode not found for state:", st)
				return {
					kind: "none",
					mode: undefined,
					startedAt: undefined,
					fgLeases: [],
					bgLeases: [],
				} satisfies SnapNone
			}

			return {
				kind: "managed",
				mode,
				startedAt,
				fgLeases,
				bgLeases,
			} satisfies SnapManaged
		}

		if (occupied) {
			return {
				kind: "manual",
				mode: undefined,
				startedAt: undefined,
				fgLeases: [],
				bgLeases: [],
			} satisfies SnapManual
		}

		return {
			kind: "none",
			mode: undefined,
			startedAt: undefined,
			fgLeases: [],
			bgLeases: [],
		} satisfies SnapNone
	})

// ----------------------------- Utilities ------------------------------------------

const classify = (after: Snapshot): Effect.Effect<ServerAfter> =>
	Effect.sync(() => {
		if (after.kind === "none") return "none"
		if (after.kind === "manual") return "manual"
		// managed
		return after.mode === "background" ? "managed_bg" : "managed_fg"
	})

const toPidChange = (
	before: Snapshot,
	after: Snapshot,
): Effect.Effect<PidChange> =>
	Effect.sync(() => {
		if (before.kind === after.kind) {
			if (before.startedAt === after.startedAt) {
				return "same"
			}
		}
		return "new"
	})

const matchesEphemeral = (
	actual: number,
	expected: EphemeralLeasesAfter,
): Effect.Effect<boolean> =>
	Effect.sync(() => {
		console.log("actual", actual)
		console.log("expected", expected)
		switch (expected) {
			case "0":
				return actual === 0
			case "1":
				return actual === 1
			// case "1+":
			// 	return actual >= 1
			// case "2+":
			// 	return actual >= 2
			case "2":
				return actual === 2
			default:
				return false
		}
	})

const launchManualPocketIc = (opts: {
	bind: string
	port: number
	cwd: string
}): Effect.Effect<number> =>
	Effect.sync(() => {
		const args = [
			"-i",
			opts.bind,
			"-p",
			String(opts.port),
			// "--ttl",
			// "99999999999",
		]
		// TODO: ?? not working
		const proc = spawn(pocketIcPath, args, {
			cwd: opts.cwd,
			detached: true,
			stdio: "ignore",
		})
		// try {
		proc.unref()
		// } catch (e) {
		// 	console.error("error spawning manual pocketic", e)
		// 	throw e
		// }
		return proc.pid!
	})

const killManualPocketIc = (pid: number) =>
	Effect.sync(() => {
		try {
			process.kill(pid, "SIGKILL")
		} catch {}
	})

const makeGlobalArgs = (row: ScenarioRow, iceDir: string) => {
	let policy: "reuse" | "restart" = "restart"
	if (row.existing_server === "managed_bg") {
		policy = "reuse"
	} else if (row.existing_server === "managed_fg") {
		policy = "reuse"
	}
	if (row.args_mismatch_selection !== "-") {
		policy = row.args_mismatch_selection
	}

	const globalArgs = {
		network: "local" as const,
		iceDirPath: iceDir,
		background: row.run_mode === "bg",
		logLevel: "error" as const,
		policy,
		origin: "cli",
	} as const

	const prepareGlobalArgs = {
		network: "local" as const,
		iceDirPath: iceDir,
		background: row.existing_server === "managed_bg",
		logLevel: "error" as const,
		policy: "restart" as const,
		origin: "cli" as const,
	} as const

	return { prepareGlobalArgs, globalArgs }
}

// ----------------------------- Test ------------------------------------------------

describe("process orchestration — scenarios (public APIs only)", () => {
	// const scenarios = [loadScenarios()[10 - 1]]
	const scenarios = loadScenarios()
	// .slice(12 - 1, 15 - 1)

	beforeAll(async () => {
		await fsp.mkdir(TEST_TMP_ROOT, { recursive: true })
	})

	afterAll(async () => {
		try {
			await fsp.rm(TEST_TMP_ROOT, { recursive: true, force: true })
		} catch {}
	})

	it.each(
		scenarios.map((s, idx) => [idx + 1, s]) as Array<[number, ScenarioRow]>,
	)("scenario #%s: %o", async (idx, row) => {
		const testEff = Effect.gen(function* () {
			// const idx = scenarios.indexOf(row)
			const iceDir = path.join(`.ice_test/${idx}`)
			const port = BASE_PORT + idx
			const { globalArgs, prepareGlobalArgs } = makeGlobalArgs(
				row,
				iceDir,
			)
			const releasePath = path.join(iceDir, ".release", "lease.txt")
			const useMismatch = row.args_mismatch === "yes"

			// Create a manual scope that lives for the entire test
			const testScope = yield* Scope.make()

			const picReplica = new PocketICReplica({
				host: DEFAULT_BIND,
				port,
				manual: row.existing_server === "manual",
				picConfig: {
					icpConfig: { betaFeatures: IcpConfigFlag.Enabled },
				},
			})
			const mismatchReplica = new PocketICReplica({
				host: DEFAULT_BIND,
				port,
				manual: row.existing_server === "manual",
				picConfig: {
					icpConfig: { betaFeatures: IcpConfigFlag.Disabled },
				},
			})

			// TODO: if
			const prepareIceConfig = {
				// if (
				//     row.existing_server === "managed_fg" ||
				//     row.existing_server === "managed_bg"
				// ) {
				networks: { local: { replica: picReplica } },
				// else manual replica, leave these empty or just define port?
			}
			const hold_task = task("hold_lease")
				.run(async () => {
					while (true) {
						try {
							await fsp.access(releasePath, fs.constants.F_OK)
							console.log("releasePath exists, breaking")
							break
						} catch {}
						await sleep(50)
					}
				})
				.make()

			const taskTree = {
				hold: hold_task,
			} satisfies TaskTree

			const PrepareICEConfigLayer = ICEConfigService.Test(
				prepareGlobalArgs,
				taskTree,
				prepareIceConfig,
			)
			const { layer: prepareLayer } = makeTestEnvEffect(
				iceDir,
				prepareGlobalArgs,
				idx,
			)

			const runPrepare = Effect.gen(function* () {
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				let manualPid: number | undefined
				if (row.existing_server === "manual") {
					manualPid = yield* launchManualPocketIc({
						bind: DEFAULT_BIND,
						port,
						cwd: iceDir,
					})
				}

				const { config } = yield* ICEConfigService
				const replica = config?.networks?.["local"]?.replica!

				// TODO: move this logic to ICEConfigService?
				// const { config } = yield* ICEConfigService
				// const replica = config?.networks?.["local"]?.replica!

				// // Start only if precondition demands a managed server
				// if (
				// 	row.existing_server === "managed_fg" ||
				// 	row.existing_server === "managed_bg"
				// ) {
				// console.log("starting prepare replica...............", replica)
				// yield* Effect.tryPromise({
				// 	try: async () => {
				// 		await replica.start(prepareGlobalArgs)
				// 	},
				// 	catch: (e) => {
				// 		console.error("error starting prepare replica", e)
				// 		if (e instanceof ReplicaStartError) {
				// 			return new ReplicaStartError({
				// 				reason: e.reason,
				// 				message: e.message,
				// 			})
				// 		}
				// 		return e as Error
				// 	},
				// })
				// yield* Effect.sleep(STABILIZE_MS)
				// }

				let preHoldFiber:
					| Fiber.RuntimeFiber<unknown, unknown>
					| undefined
				preHoldFiber = yield* runTask(hold_task).pipe(
					// Effect.provide(taskLayer),
					// Effect.provide(ChildTaskRuntimeLayer),
					// Effect.provide(PrepareICEConfigLayer),
					Effect.provide(DeploymentsLayer),
					Effect.forkIn(testScope),
				)
				if (row.ephemeral_leases_before === "0") {
					yield* Effect.sleep(1000)
					console.log("stopping foreground replica...............")
					yield* Effect.tryPromise({
						try: () => replica.stop({ scope: "foreground" }),
						catch: (error) => {
							console.error("error stopping replica", error)
							return error
						},
					})
					yield* Effect.sleep(1000)
				}
				if (
					row.bg_leases_before === "0" &&
					row.existing_server === "managed_bg"
				) {
					yield* Effect.sleep(1000)
					console.log("stopping background replica...............")
					yield* Effect.tryPromise({
						try: () => replica.stop({ scope: "background" }),
						catch: (error) => {
							console.error("error stopping replica", error)
							return error
						},
					})
					yield* Effect.sleep(1000)
				}
				return { preHoldFiber, manualPid }
			})

			// if (row.existing_server !== "none") {
			const prepareRuntime = ManagedRuntime.make(
				Layer.mergeAll(prepareLayer, PrepareICEConfigLayer),
			)
            // TODO: build it here?
            // TaskRuntimeLayer.pipe(
            //     Layer.provide(NodeContext.layer),
            //     Layer.provide(KVStorageLayer),
            //     Layer.provide(ICEConfigLayer),
            //     Layer.provide(telemetryLayer),
            //     Layer.provide(telemetryConfigLayer),
            //     Layer.provide(ReplicaService),
            //     Layer.provide(
            //         DefaultConfigLayer.pipe(Layer.provide(ReplicaService)),
            //     ),
            //     Layer.provide(CanisterIdsLayer),
            //     Layer.provide(configLayer),
            //     Layer.provide(InFlightLayer),
            //     Layer.provide(IceDirLayer),
            //     Layer.provide(DeploymentsLayer),
            //     Layer.provide(PromptsService.Live),
            //     Layer.provide(
            //         TaskRegistry.Live.pipe(Layer.provide(KVStorageLayer)),
            //     ),
            // )
			const { preHoldFiber, manualPid } = yield* Effect.tryPromise({
				try: () =>
					prepareRuntime.runPromise(
						runPrepare,
						// .pipe(Effect.provide(PrepareICEConfigLayer)),
					),
				catch: (error) => {
					return error
				},
			})

			yield* Effect.sleep(1000)
			if (preHoldFiber && row.ephemeral_leases_before === "0") {
				const preInterruptResult = yield* Fiber.interrupt(preHoldFiber)
				yield* Scope.close(testScope, Exit.void)
				yield* prepareRuntime.disposeEffect
			}
			// }

			// Check if port is still listening
			const before = yield* snapshot(iceDir, DEFAULT_BIND, port).pipe(
				Effect.provide(NodeContext.layer),
			)
			console.log(
				`[SNAPSHOT BEFORE #${idx}] Result:`,
				JSON.stringify(before, null, 2),
			)

			const { layer: mainLayer } = makeTestEnvEffect(
				iceDir,
				globalArgs,
				idx,
			)

			const mainScope = yield* Scope.make()
			const mainPicReplica = new PocketICReplica({
				host: DEFAULT_BIND,
				port,
				manual: false,
				picConfig: {
					icpConfig: { betaFeatures: IcpConfigFlag.Enabled },
				},
			})
			const mainMismatchReplica = new PocketICReplica({
				host: DEFAULT_BIND,
				port,
				manual: false,
				picConfig: {
					icpConfig: { betaFeatures: IcpConfigFlag.Disabled },
				},
			})

			const mainIceConfig = {
				networks: {
					local: {
						replica: useMismatch
							? mainMismatchReplica
							: mainPicReplica,
					},
				},
			}
			const MainICEConfigLayer = ICEConfigService.Test(
				globalArgs,
				taskTree,
				mainIceConfig,
			)

			const runMain = () =>
				Effect.gen(function* () {
					const KVStorageImpl = yield* KeyValueStore.KeyValueStore
					const KVStorageLayer = Layer.succeed(
						KeyValueStore.KeyValueStore,
						KVStorageImpl,
					)
					const DeploymentsLayer = DeploymentsService.Live.pipe(
						Layer.provide(KVStorageLayer),
					)

					const { config } = yield* ICEConfigService
					const replica = config?.networks?.["local"]?.replica!

					const mainHoldFiber = yield* runTask(hold_task).pipe(
						// Effect.provide(taskLayer),
						// Effect.provide(ChildTaskRuntimeLayer),
						// Effect.provide(MainICEConfigLayer),
						Effect.provide(DeploymentsLayer),
						Effect.forkIn(mainScope),
					)

					// IMMEDIATELY check if it failed during startup
					// Give it a moment to initialize
					yield* Effect.sleep(1000)
					const fiberStatus = yield* Fiber.status(mainHoldFiber)

					// If it's already done (failed), join it to get the error
					if (fiberStatus._tag === "Done") {
						const result = yield* Fiber.join(mainHoldFiber)
						// This will re-throw any errors from the fiber
					}

					const fgStop =
						row.ephemeral_leases_after === "0" &&
						row.ephemeral_leases_before !== "0"

					if (fgStop) {
						console.log("fgStop called on main replica")
						yield* Effect.tryPromise({
							try: () => replica.stop({ scope: "foreground" }),
							catch: (error) => {
								console.error("error stopping replica", error)
								return error
							},
						})
						yield* Effect.sleep(1000)
						console.log("Main Foreground replica stopped")
					}

					return { mainHoldFiber }
				}).pipe(Effect.scoped)

			const mainRuntime = ManagedRuntime.make(
				Layer.mergeAll(mainLayer, MainICEConfigLayer),
			)
			const mainResult = yield* Effect.tryPromise({
				try: () => mainRuntime.runPromiseExit(runMain()),
				catch: (error) => {
					return error
				},
			})

			const mainHoldFiber = Exit.match(mainResult, {
				onSuccess: (value) => {
					console.log(
						`[MAIN RESULT] Success - mainHoldFiber: ${value.mainHoldFiber ? "exists" : "undefined"}`,
					)
					return value.mainHoldFiber
				},
				onFailure: () => {
					console.log(`[MAIN RESULT] Failure - no fiber`)
					return undefined
				},
			})

			// Give forked task time to create lease
			if (mainHoldFiber) {
				yield* Effect.sleep(1000)
				const mainFiberStatus = yield* Fiber.status(mainHoldFiber)
				console.log("mainFiberStatus", mainFiberStatus)
				yield* Effect.sleep(500)
			}

			console.log(`\n[SNAPSHOT AFTER #${idx}]`)
			console.log(
				`[SNAPSHOT AFTER #${idx}] About to call snapshot with: iceDir=${iceDir}, port=${port}`,
			)
			const after = yield* snapshot(iceDir, DEFAULT_BIND, port).pipe(
				Effect.provide(NodeContext.layer),
			)
			console.log(
				`[SNAPSHOT AFTER #${idx}] Result:`,
				JSON.stringify(after, null, 2),
			)

			const errCode = Exit.match(mainResult, {
				onSuccess: () => "-" as const,
				onFailure: (cause) => {
					if (cause._tag === "Fail") {
						if (cause.error instanceof ReplicaStartError) {
							return cause.error.reason
						}
					}
					// unexpected failures:
					throw cause
				},
			})

			// ------------------ Assertions ------------------
			console.log(`\n[ASSERTIONS]`)
			console.log(`[ASSERT] errCode: ${errCode} (expected: ${row.error})`)

			expect(errCode).toBe(row.error)

			const pidDelta = yield* toPidChange(before, after)
			console.log(
				`[ASSERT] pidDelta: ${pidDelta} (expected: ${row.pid_change})`,
			)
			expect(pidDelta).toBe(row.pid_change)

			const serverAfter = yield* classify(after)
			expect(serverAfter).toBe(row.server_after)

			const ephOk =
				after.fgLeases.length === Number(row.ephemeral_leases_after)
			expect(ephOk).toBe(true)

			const bgOk = after.bgLeases.length === Number(row.bg_leases_after)
			expect(bgOk).toBe(true)

			if (row.existing_server === "manual" && manualPid) {
				yield* killManualPocketIc(manualPid)
			}

			// Close the test scope (will interrupt any remaining fibers)
			yield* Scope.close(testScope, Exit.void)
			yield* Scope.close(mainScope, Exit.void)
		})
		await Effect.runPromise(testEff)
	})
})
