import { Deferred, Effect, Fiber, Option, Schedule, Stream } from "effect"
import { FileSystem, Path, Command, CommandExecutor } from "@effect/platform"
import * as url from "node:url"
import { pocketIcPath, pocketIcVersion } from "@ice.ts/pocket-ic"
import { ReplicaError } from "../replica.js"
import { PlatformError } from "@effect/platform/Error"
import net from "node:net"
import { Process } from "@effect/platform/CommandExecutor"
import find from "find-process"
import { ICEConfigContext } from "../../types/types.js"

const statePathEffect = (iceDirPath: string) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const STATE_DIR = path.join(iceDirPath, "pocketic-server")
		const STATE_FILE = "state.json"
		return path.join(STATE_DIR, STATE_FILE)
	})

type PocketIcState = {
	pid: number
	startedAt: number
	binPath: string
	args: string[]
	version?: string
}

const readState = (iceDirPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* statePathEffect(iceDirPath)
		const exists = yield* fs.exists(path)
		if (!exists) return Option.none<PocketIcState>()
		const txt = yield* fs.readFileString(path)
		return Option.some(JSON.parse(txt) as PocketIcState)
	})

const writeState = (iceDirPath: string, state: PocketIcState) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* statePathEffect(iceDirPath)
		const dir = (yield* Path.Path).dirname(path)
		yield* fs.makeDirectory(dir, { recursive: true })
		yield* fs.writeFile(
			path,
			new TextEncoder().encode(JSON.stringify(state, null, 2)),
		)
	})

const removeState = (iceDirPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* statePathEffect(iceDirPath)
		const exists = yield* fs.exists(path)
		if (exists) yield* fs.remove(path)
	})

const isPidAlive = (pid: number) =>
	Effect.try(() => process.kill(pid, 0) === undefined || true).pipe(
		Effect.catchAll(() => Effect.succeed(false)),
	)

// wait until <host>:<port> accepts TCP (per-try timeout)
const waitTcpReady = (host: string, port: number, perTryMs = 800) =>
	Effect.tryPromise({
		try: () =>
			new Promise<void>((resolve, reject) => {
				const socket = net.connect({ host, port })
				const to = setTimeout(() => {
					socket.destroy(new Error("timeout"))
				}, perTryMs)
				const cleanup = () => {
					clearTimeout(to)
					socket.removeAllListeners()
					socket.end()
					socket.destroy()
				}
				socket.once("connect", () => {
					cleanup()
					resolve()
				})
				socket.once("error", (err) => {
					cleanup()
					reject(err)
				})
			}),
		catch: () =>
			new ReplicaError({
				message: `PocketIC not accepting connections on ${host}:${port}`,
			}),
	})

// If a process is listening on <port> AND its command looks like pocket-ic -> Some(pid) else None
const pidByPortIfPocketIc = (port: number) =>
	Effect.tryPromise({
		try: () => find("port", port),
		catch: () =>
			new ReplicaError({
				message: `Failed to find process listening on ${port}`,
			}),
	}).pipe(
		Effect.catchAll(() => Effect.succeed([])),
		Effect.map((list) => {
			const match = list.find((p) => {
				const cmd = (p as any).cmd as string | undefined
				const name = (p as any).name as string | undefined
				return (
					(cmd && cmd.includes(pocketIcPath)) ||
					(name && name.toLowerCase().includes("pocket-ic"))
				)
			})
			return match
				? Option.some((match as any).pid as number)
				: Option.none<number>()
		}),
	)

export type Monitor = {
	stdErrFiber: Option.Option<Fiber.Fiber<never, ReplicaError | PlatformError>>
	pid: number
	host: string
	port: number
	reused: boolean
	shutdown: () => void
}

export const makeMonitor = (
	ctx: ICEConfigContext,
	opts: {
		host: string
		port: number
		ttlSeconds?: number
	},
) =>
	Effect.gen(function* () {
		const host = opts.host
		const port = opts.port
		const fs = yield* FileSystem.FileSystem
		const pathSvc = yield* Path.Path
		const commandExec = yield* CommandExecutor.CommandExecutor

		const monitorPath = pathSvc.resolve(
			url.fileURLToPath(new URL(".", import.meta.url)),
			"../../../bin/monitor.js",
		)
		const ttl = String(opts.ttlSeconds ?? 9_999_999_999)
		const statePath = yield* statePathEffect(ctx.iceDirPath)

		// --- Reuse: if we have state and the PID is alive & version matches
		const st = yield* readState(ctx.iceDirPath)
		if (Option.isSome(st)) {
			const alive = yield* isPidAlive(st.value.pid)
			const versionOk =
				(st.value.version ?? pocketIcVersion) === pocketIcVersion
			if (alive && versionOk) {
				yield* waitTcpReady(host, port).pipe(
					Effect.retry(
						Schedule.intersect(
							Schedule.spaced("120 millis"),
							Schedule.recurs(40),
						),
					),
				)
				const shutdown = () => {
					// do NOT kill here automatically; this is a background server we reused
					try {
						/* noop or gentle signal if you decide */
					} catch {}
				}
				return {
					stdErrFiber: Option.none(),
					reused: true,
					pid: st.value.pid,
					host: `http://${host}`,
					port,
					shutdown,
				} satisfies Monitor
			} else {
				yield* removeState(ctx.iceDirPath)
			}
		}

		// --- Adopt: no state, but something already listening and it is pocket-ic → recreate state, reuse
		const maybePid = yield* pidByPortIfPocketIc(port)
		if (Option.isSome(maybePid)) {
			const pid = maybePid.value
			const alive = yield* isPidAlive(pid)
			if (alive) {
				yield* writeState(ctx.iceDirPath, {
					pid,
					startedAt: Date.now(),
					binPath: pocketIcPath,
					args: ["-i", host, "-p", String(port), "--ttl", ttl],
					version: pocketIcVersion,
				})
				yield* waitTcpReady(host, port).pipe(
					Effect.retry(
						Schedule.intersect(
							Schedule.spaced("120 millis"),
							Schedule.recurs(40),
						),
					),
				)
				const shutdown = () => {
					// same: we adopted a background instance; don't kill by default
					try {
						/* noop or gentle signal if you decide */
					} catch {}
				}
				return {
					stdErrFiber: Option.none(),
					reused: true,
					pid,
					host: `http://${host}`,
					port,
					shutdown,
				} satisfies Monitor
			}
		}

		// --- Start fresh
		if (ctx.background) {
			// Background via monitor.js (writes state + exits)
			const cmd = Command.make(
				process.execPath,
				monitorPath,
				...["--background"],
				"--state-file",
				statePath,
				"--parent",
				String(process.pid),
				"--bin",
				pocketIcPath,
				"--",
				"-i",
				host,
				"-p",
				String(port),
				"--ttl",
				ttl,
			)

			yield* Effect.logDebug(`[pocket-ic] cmd: ${cmd.toString()}`)
			const proc = yield* commandExec.start(cmd)
			yield* Effect.logDebug(
				`[pocket-ic] background monitor started (pid ${proc.pid})`,
			)

			// Wait for state → parsed → pid alive
			const state = yield* Effect.gen(function* () {
				const exists = yield* fs.exists(statePath)
				if (!exists) {
					return yield* Effect.fail(
						new ReplicaError({
							message: `PocketIC background state file missing`,
						}),
					)
				}
				const txt = yield* fs.readFileString(statePath)
				if (!txt || txt.trim().length === 0) {
					return yield* Effect.fail(
						new ReplicaError({
							message: `PocketIC background state not ready`,
						}),
					)
				}
				const parsed = yield* Effect.try({
					try: () => JSON.parse(txt) as PocketIcState,
					catch: () =>
						new ReplicaError({
							message: `Failed to parse PocketIC background state`,
						}),
				})
				const alive2 = yield* isPidAlive(parsed.pid)
				if (!alive2) {
					return yield* Effect.fail(
						new ReplicaError({
							message: `PocketIC background process died`,
						}),
					)
				}
				return parsed
			}).pipe(
				Effect.retry(
					Schedule.intersect(
						Schedule.exponential("25 millis"),
						Schedule.recurs(20),
					),
				),
			)

			// Verify listener ownership then TCP ready
			yield* Effect.gen(function* () {
				const owner = yield* pidByPortIfPocketIc(port)
				if (Option.isNone(owner) || owner.value !== state.pid) {
					return yield* Effect.fail(
						new ReplicaError({
							message: `PocketIC did not take ownership of ${host}:${port} (listener mismatch)`,
						}),
					)
				}
				return void 0
			}).pipe(
				Effect.retry(
					Schedule.intersect(
						Schedule.spaced("120 millis"),
						Schedule.recurs(50),
					),
				),
			)

			yield* waitTcpReady(host, port).pipe(
				Effect.retry(
					Schedule.intersect(
						Schedule.spaced("120 millis"),
						Schedule.recurs(50),
					),
				),
			)

			if (!state.version) {
				yield* writeState(ctx.iceDirPath, {
					...state,
					version: pocketIcVersion,
				})
			}

			const shutdown = () => {
				// background: by design we keep it running; leave as no-op
				try {
					/* noop */
				} catch {}
			}

			return {
				stdErrFiber: Option.none(),
				reused: false,
				pid: state.pid,
				host: `http://${host}`,
				port,
				shutdown,
			} satisfies Monitor
		}

		// Foreground: start monitor.js (no state-file); watch stderr for fatals
		const cmd = Command.make(
			process.execPath,
			monitorPath,
			// no --background
			"--parent",
			String(process.pid),
			"--bin",
			pocketIcPath,
			"--",
			"-i",
			host,
			"-p",
			String(port),
			"--ttl",
			ttl,
		)

		yield* Effect.logDebug(`[pocket-ic] cmd: ${cmd.toString()}`)
		const proc = yield* commandExec.start(cmd)
		yield* Effect.logDebug(
			`[pocket-ic] foreground monitor started (pid ${proc.pid})`,
		)

		const fatalStderrMonitor = makeStdErrMonitor(proc, host, port)
		const stderrMonitorFiber = yield* Effect.forkScoped(fatalStderrMonitor)

		const shutdownMonitor = () =>
			Effect.sync(() => {
				try {
					if (proc.pid) process.kill(proc.pid, "SIGTERM")
				} catch {}
			})
		yield* Effect.addFinalizer(shutdownMonitor)

		const shutdown = () => {
			try {
				if (proc.pid) process.kill(proc.pid, "SIGTERM")
			} catch {}
		}

		return {
			stdErrFiber: Option.some(stderrMonitorFiber),
			reused: false,
			pid: proc.pid,
			host: `http://${host}`,
			port,
			shutdown,
		} satisfies Monitor
	})

const decodeChunk = (chunk: unknown): string => {
	if (typeof chunk === "string") return chunk
	try {
		// @ts-ignore
		if (chunk && typeof chunk.length === "number") {
			return new TextDecoder().decode(chunk as any)
		}
	} catch {}
	return String(chunk)
}

export interface PocketIcOpts {
	ip: string
	port: number
	ttlSeconds?: number
}

export const makeStdErrMonitor = (proc: Process, ip: string, port: number) =>
	Stream.runForEach(proc.stderr, (chunk) =>
		Effect.gen(function* () {
			const text = decodeChunk(chunk)
			for (const line of text.split("\n")) {
				if (!line) continue
				if (/Failed to bind PocketIC server to address/i.test(line)) {
					yield* Effect.logError(`[pocket-ic stderr] ${line}`)
					return yield* Effect.fail(
						new ReplicaError({
							message: `PocketIC failed to bind to ${ip}:${port}. Port likely in use.`,
						}),
					)
				}
				if (/thread 'main' panicked/i.test(line)) {
					yield* Effect.logError(`[pocket-ic stderr] ${line}`)
					return yield* Effect.fail(
						new ReplicaError({
							message: `PocketIC panicked during startup: ${line}`,
						}),
					)
				}
			}
		}),
	) as Effect.Effect<never, ReplicaError | PlatformError>
