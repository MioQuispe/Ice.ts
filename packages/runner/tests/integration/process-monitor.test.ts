// packages/runner/tests/integration/process_monitor.scenarios.test.ts
//
// Process Orchestration Scenarios — Spec-Driven E2E
//
// What you must wire up after pasting this file:
//  1) Replace the `replica` placeholder with a real ReplicaService instance (or proxy)
//     so that `replica.start(ctx)` / `replica.stop()` call your PUBLIC APIs.
//  2) Ensure your runner creates FG leases while a task runs (our FG task is a normal
//     public `task()` that blocks until a "release" file appears — we stop it via
//     another public task that writes that file).
//  3) If your `replica.start()` emits structured errors, make them expose `.code` as
//     "in-use" | "manual_present" | "protected". The test maps those to CSV `error`.
//
// This file intentionally avoids any “monitor logic”. It just:
//   - Prepares preconditions using public APIs,
//   - Executes one public action per row,
//   - Snapshots state (via public artifacts) before/after,
//   - Asserts the CSV columns verbatim.
//

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { describe, it, beforeAll, afterAll, expect } from "vitest"
import { setTimeout as sleep } from "node:timers/promises"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { Cause, Data, Effect, Exit, Fiber, Layer } from "effect"
import { FileSystem, Path as EffectPath } from "@effect/platform"
import { KeyValueStore } from "@effect/platform"
import { makeTaskLayer } from "../../src/services/taskRuntime.js"
import { TaskRuntime } from "../../src/services/taskRuntime.js"
import { ICEConfigService } from "../../src/services/iceConfig.js"
import { task, Ice, Replica } from "../../src/index.js"
import { runTask } from "../../src/tasks/run.js"
import { pocketIcPath } from "@ice.ts/pocket-ic"
import { IcpConfigFlag } from "@dfinity/pic"
import { DefaultReplica } from "../../src/services/replica.js"
import { TaskTree } from "../../src/types/types.js"
import { NodeContext } from "@effect/platform-node"
import { makeTestEnvEffect } from "./setup.js"
import { DeploymentsService } from "../../src/services/deployments.js"
import { ReplicaStartError } from "../../src/services/replica.js"
import { TaskSuccess } from "../../src/tasks/lib.js"

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
type EphemeralLeasesAfter = "0" | "1" | "1+" | "2+"
// type ErrorCode = "-" | "in-use" | "manual_present" | "protected"
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
	ephemeral_leases_before: "0" | "1+"
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

// ----------------------------- Public test tasks ----------------------------------
//
// We use ONLY public task API to create/hold/release FG leases.
// hold_task blocks until `releasePath` exists; release_task creates it.
//

const makeTasks = (releasePath: string) => {
	const hold_task = task("hold_lease")
		.run(async () => {
			// Block until released by `release_lease` task
			while (true) {
				try {
					await fsp.access(releasePath, fs.constants.F_OK)
					break
				} catch {
					// not released yet
				}
				await sleep(50)
			}
		})
		.make()

	const release_task = task("release_lease")
		.run(async () => {
			await fsp.mkdir(path.dirname(releasePath), { recursive: true })
			await fsp.writeFile(releasePath, "release", "utf8")
		})
		.make()

	const noop_task = task("noop")
		.run(async () => {})
		.make()

	return { hold_task, release_task, noop_task }
}

// ----------------------------- Public artifacts snapshot --------------------------

const statePath = (workDir: string) =>
	Effect.gen(function* () {
		const pathService = yield* EffectPath.Path
		return pathService.join(
			workDir,
			".ice",
			"pocketic-server",
			"state.json",
		)
	})

const leasesDir = (workDir: string) =>
	Effect.gen(function* () {
		const pathService = yield* EffectPath.Path
		return pathService.join(workDir, ".ice", "pocketic-server", "leases")
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

const countFgLeases = (workDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const pathService = yield* EffectPath.Path
		const leasesDirPath = yield* leasesDir(workDir)
		const entries = yield* fs
			.readDirectory(leasesDirPath)
			.pipe(
				Effect.catchAll(() =>
					Effect.succeed([] as ReadonlyArray<string>),
				),
			)
		const files = entries.filter((n) => n.endsWith(".json"))
		let fg = 0
		for (const n of files) {
			const filePath = pathService.join(leasesDirPath, n)
			const j = yield* readJSON<{ mode?: "foreground" | "background" }>(
				filePath,
			)
			if (j?.mode === "foreground") fg++
		}
		return fg
	})

const snapshot = (workDir: string, bind: string, port: number) =>
	Effect.gen(function* () {
		const stateFilePath = yield* statePath(workDir)
		const st = yield* readJSON<{ monitorPid?: number; serverPid?: number }>(
			stateFilePath,
		)
		if (st?.serverPid && st?.monitorPid) {
			const serverAlive = yield* pidAlive(st.serverPid)
			const monitorAlive = yield* pidAlive(st.monitorPid)
			if (serverAlive && monitorAlive) {
				const fg = yield* countFgLeases(workDir)
				const hasBg = yield* hasBgLease(workDir)
				return {
					kind: "managed" as const,
					serverPid: st.serverPid,
					monitorPid: st.monitorPid,
					ephemeralLeases: fg,
					hasBgLease: hasBg,
				}
			}
		}
		// Manual (we only spawn from test; no state.json, port-bound server)
		const occupied = yield* portOccupied(bind, port)
		if (occupied) {
			// not reliable cross-scenarios; we stick to managed/no/manual via state file presence.
		}
		return { kind: "none" as const, ephemeralLeases: 0, hasBgLease: false }
	})

const hasBgLease = (workDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const pathService = yield* EffectPath.Path
		const leasesDirPath = yield* leasesDir(workDir)
		const entries = yield* fs
			.readDirectory(leasesDirPath)
			.pipe(
				Effect.catchAll(() =>
					Effect.succeed([] as ReadonlyArray<string>),
				),
			)
		const files = entries.filter((n) => n.endsWith(".json"))
		for (const n of files) {
			const filePath = pathService.join(leasesDirPath, n)
			const j = yield* readJSON<{ mode?: "foreground" | "background" }>(
				filePath,
			)
			if (j?.mode === "background") return true
		}
		return false
	})

// ----------------------------- Utilities ------------------------------------------

const sanitize = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 80)

const exists = (p: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.exists(p)
	})

type SnapshotResult = Effect.Effect.Success<ReturnType<typeof snapshot>>

const classify = (after: SnapshotResult): Effect.Effect<ServerAfter> =>
	Effect.sync(() => {
		if (after.kind === "none") return "none"
		return after.hasBgLease ? "managed_bg" : "managed_fg"
	})

const toPidChange = (
	before: SnapshotResult,
	after: SnapshotResult,
): Effect.Effect<PidChange> =>
	Effect.sync(() => {
		const b = (before as any).serverPid as number | undefined
		const a = (after as any).serverPid as number | undefined
		if (!b && a) return "new"
		if (b && a && b !== a) return "new"
		return "same"
	})

const matchesEphemeral = (
	actual: number,
	expected: EphemeralLeasesAfter,
): Effect.Effect<boolean> =>
	Effect.sync(() => {
		switch (expected) {
			case "0":
				return actual === 0
			case "1":
				return actual === 1
			case "1+":
				return actual >= 1
			case "2+":
				return actual >= 2
			default:
				return false
		}
	})

const portOccupied = (_bind: string, _port: number): Effect.Effect<boolean> =>
	// Not needed for assertions; manual detection is by scenario setup.
	Effect.succeed(false)

const launchManualPocketIc = (opts: {
	bind: string
	port: number
	cwd: string
}): Effect.Effect<number> =>
	Effect.sync(() => {
		const args = ["-i", opts.bind, "-p", String(opts.port)]
		const proc = spawn(pocketIcPath, args, {
			cwd: opts.cwd,
			detached: true,
			stdio: "ignore",
		})
		try {
			proc.unref()
		} catch {}
		return proc.pid!
	})

const killManualPocketIc = (pid: number) =>
	Effect.sync(() => {
		process.kill(pid, "SIGKILL")
	})

const makeGlobalArgs = (row: ScenarioRow, workDir: string) => {
	let policy: "reuse" | "restart" = "restart" as const
	if (row.existing_server === "managed_bg") {
		policy = "reuse" as const
	} else if (row.existing_server === "managed_fg") {
		policy = "reuse" as const
	}
	let background = false
	if (row.existing_server === "managed_bg") {
		background = true
	} else if (row.existing_server === "managed_fg") {
		background = false
	}
	const globalArgs = {
		network: "local" as const,
		iceDirPath: workDir,
		background: row.run_mode === ("bg" as const),
		logLevel: "debug" as const,
		policy,
	}

	const prepareGlobalArgs = {
		network: "local" as const,
		iceDirPath: workDir,
		background: row.existing_server === "managed_bg",
		logLevel: "error" as const,
		policy: "restart" as const,
	}

	return {
		prepareGlobalArgs,
		globalArgs,
	}
}

// ----------------------------- Test ------------------------------------------------

describe("process orchestration — scenarios (public APIs only)", () => {
	const scenarios = loadScenarios()

	beforeAll(async () => {
		await fsp.mkdir(TEST_TMP_ROOT, { recursive: true })
	})

	afterAll(async () => {
		try {
			await fsp.rm(TEST_TMP_ROOT, { recursive: true, force: true })
		} catch {}
	})

	it.concurrent.each(scenarios)("scenario: %s", async (row) => {
		const idx = scenarios.indexOf(row)
		const port = BASE_PORT + idx
		const workDir = path.join(
			TEST_TMP_ROOT,
			sanitize(`${idx + 1}-${row.scenario}`),
		)
		const { globalArgs, prepareGlobalArgs } = makeGlobalArgs(row, workDir)
		const releasePath = path.join(workDir, ".release", "lease.txt")
		// ------------------ Action (PUBLIC APIs only) ------------------
		const policy: "reuse" | "restart" =
			row.args_mismatch_selection === "restart" ? "restart" : "reuse"
		const useMismatch = row.args_mismatch === "yes"

		await fsp.mkdir(workDir, { recursive: true })

		const picReplica = new Replica.PocketIC({
			host: DEFAULT_BIND,
			port: port,
			picConfig: {
				icpConfig: {
					// mismatch -> different config
					betaFeatures: IcpConfigFlag.Enabled,
				},
			},
		})
		const mismatchReplica = new Replica.PocketIC({
			host: DEFAULT_BIND,
			port: port,
			picConfig: {
				icpConfig: { betaFeatures: IcpConfigFlag.Disabled },
			},
		})

		// TODO: separate prepare and main configs
		const prepareIceConfig = {
			networks: {
				local: {
					replica: picReplica,
				},
			},
		}
		const tasks = makeTasks(path.join(workDir, ".release", "lease.txt"))

		const taskTree = {
			hold: tasks.hold_task,
			release: tasks.release_task,
			noop: tasks.noop_task,
		} satisfies TaskTree

		const PrepareICEConfigLayer = ICEConfigService.Test(
			prepareGlobalArgs,
			taskTree,
			prepareIceConfig,
		)
		const { runtime: prepareRuntime } = makeTestEnvEffect(
			workDir,
			prepareGlobalArgs,
		)

		const runPrepare = Effect.gen(function* () {
			// Prepare the world per existing_server
			let manualPid: number | undefined
			if (row.existing_server === "manual") {
				manualPid = yield* launchManualPocketIc({
					bind: DEFAULT_BIND,
					port,
					cwd: workDir,
				})
			}
			// TODO: turn into service with default value? optional service?
			const KVStorageImpl = yield* KeyValueStore.KeyValueStore
			const KVStorageLayer = Layer.succeed(
				KeyValueStore.KeyValueStore,
				KVStorageImpl,
			)
			const DeploymentsLayer = DeploymentsService.Live.pipe(
				Layer.provide(KVStorageLayer),
			)
			const { taskLayer, runtime: taskRuntime } = yield* makeTaskLayer(
				prepareGlobalArgs,
			).pipe(
				Effect.provide(PrepareICEConfigLayer),
				Effect.provide(DeploymentsLayer),
			)

			const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
				runtime: taskRuntime,
				taskLayer,
			})
			const iceDirPath = path.join(workDir, ".ice")

			const replica = yield* DefaultReplica

			if (row.existing_server !== "manual") {
				const P = Effect.tryPromise({
					try: () => replica.start(prepareGlobalArgs),
					catch: (e) => {
						console.error(e)
						if (e instanceof ReplicaStartError) {
							return new ReplicaStartError({
								reason: e.reason,
								message: e.message,
							})
						}
						return e as Error
					},
				})
				// TODO: remove??
				yield* Effect.sleep(STABILIZE_MS)
			}

			// If precondition asks for 1+ ephemeral leases, start one task (public)
			const holdFiber =
				row.ephemeral_leases_before === "1+"
                && row.run_mode === "fg"
					? yield* runTask(tasks.hold_task).pipe(
							Effect.provide(taskLayer),
							Effect.provide(ChildTaskRuntimeLayer),
							Effect.forkDaemon,
						)
					: undefined
			// TODO:... fix. no hardcoded shit.
			yield* Effect.sleep(STABILIZE_MS)
			return { manualPid, holdFiber }
		})
		const { manualPid, holdFiber } =
			await prepareRuntime.runPromise(runPrepare)

		const before = await Effect.runPromise(
			snapshot(workDir, DEFAULT_BIND, port).pipe(
				Effect.provide(NodeContext.layer),
			),
		)

		const { runtime: mainRuntime } = makeTestEnvEffect(workDir, globalArgs)

		const mainIceConfig = {
			networks: {
				local: {
					replica: useMismatch ? mismatchReplica : picReplica,
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
				// TODO: turn into service with default value? optional service?
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(MainICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)

				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const iceDirPath = path.join(workDir, ".ice")

				const replica = yield* DefaultReplica

				yield* Effect.tryPromise({
					try: () => replica.start(globalArgs),
					catch: (e) => {
						console.error(e)
						if (e instanceof ReplicaStartError) {
							return new ReplicaStartError({
								reason: e.reason,
								message: e.message,
							})
						}
						return e as Error
					},
				})

				const holdFiber =
					row.expected_action !== "attach_manual" &&
					row.expected_action !== "reject_manual"
						? yield* runTask(tasks.hold_task).pipe(
								Effect.provide(taskLayer),
								Effect.provide(ChildTaskRuntimeLayer),
                                Effect.forkDaemon,
							)
						: undefined

                return { holdFiber }
			})

		const mainResult = await mainRuntime.runPromiseExit(runMain())
		const after = await Effect.runPromise(
			snapshot(workDir, DEFAULT_BIND, port).pipe(
				Effect.provide(NodeContext.layer),
			),
		)
		const errCode = Exit.match(mainResult, {
			onSuccess: () => "-" as const,
			onFailure: (cause) => {
				if (cause._tag === "Fail") {
					if (cause.error instanceof ReplicaStartError) {
						// TODO: ???
						return cause.error.reason
					}
				}
				console.error(cause)
			},
		})
        const mainHoldFiber = Exit.match(mainResult, {
            onSuccess: (value) => value.holdFiber,
            onFailure: (cause) => undefined,
        })

		expect(errCode).toBe(row.error)

		// 2) pid_change
		expect(toPidChange(before, after)).toBe(row.pid_change)

		// 3) server_after
		expect(classify(after)).toBe(row.server_after)

		// 4) ephemeral_leases_after
		expect(
			matchesEphemeral(after.ephemeralLeases, row.ephemeral_leases_after),
		).toBe(true)

		if (holdFiber) {
			await Effect.runPromise(Fiber.interrupt(holdFiber))
		}
		if (mainHoldFiber) {
			await Effect.runPromise(Fiber.interrupt(mainHoldFiber))
		}

		if (row.existing_server === "manual" && manualPid) {
			killManualPocketIc(manualPid)
		}
	})
})
