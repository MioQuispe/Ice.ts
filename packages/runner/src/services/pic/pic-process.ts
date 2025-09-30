import { Deferred, Effect, Fiber, Option, Schedule, Stream } from "effect"
import { FileSystem, Path, Command, CommandExecutor } from "@effect/platform"
import os from "node:os"
import * as url from "node:url"
import { pocketIcPath, pocketIcVersion } from "@ice.ts/pocket-ic"
import { IceDir } from "../iceDir.js"
import { ReplicaError } from "../replica.js"
import { PlatformError } from "@effect/platform/Error"
import net from "node:net"
import { Process } from "@effect/platform/CommandExecutor"
import find from "find-process"

const statePathEffect = Effect.gen(function* () {
	const path = yield* Path.Path
	const { path: iceDirPath } = yield* IceDir
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

const readState = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* statePathEffect
	const exists = yield* fs.exists(path)
	if (!exists) return Option.none<PocketIcState>()
	const txt = yield* fs.readFileString(path)
	return Option.some(JSON.parse(txt) as PocketIcState)
})

const writeState = (state: PocketIcState) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* statePathEffect
		const dir = (yield* Path.Path).dirname(path)
		yield* fs.makeDirectory(dir, { recursive: true })
		yield* fs.writeFile(
			path,
			new TextEncoder().encode(JSON.stringify(state, null, 2)),
		)
	})

const removeState = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* statePathEffect
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

// Who owns <port>? If listener’s command matches pocketIcPath → Some(pid), else None.
const pidByPortIfPocketIc = (port: number) =>
	Effect.tryPromise({
		try: () => find("port", port),
		catch: () => [],
	}).pipe(
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
	stdErrFiber?: Fiber.Fiber<never, ReplicaError | PlatformError>
	pid: number
	host: string
	port: number
	reused: boolean
	shutdown: () => void
}

export const makeMonitor = (opts: {
	ip: string
	port: number
	ttlSeconds?: number
	background: boolean
}) =>
	Effect.gen(function* () {
		const ip = opts.ip
		const port = opts.port
		const fs = yield* FileSystem.FileSystem
		const pathSvc = yield* Path.Path
		const commandExec = yield* CommandExecutor.CommandExecutor

		const monitorPath = pathSvc.resolve(
			url.fileURLToPath(new URL(".", import.meta.url)),
			"../../../bin/monitor.js",
		)
		const ttl = String(opts.ttlSeconds ?? 9_999_999_999)

		if (opts.background) {
			const statePath = yield* statePathEffect

			// 1) Try reuse (state)
			const st = yield* readState
			if (Option.isSome(st)) {
				const alive = yield* isPidAlive(st.value.pid)
				const versionOk =
					(st.value.version ?? pocketIcVersion) === pocketIcVersion
				if (alive && versionOk) {
					// Ensure socket ready
					yield* waitTcpReady(ip, port).pipe(
						Effect.retry(
							Schedule.intersect(
								Schedule.spaced("120 millis"),
								Schedule.recurs(40),
							),
						),
					)
					const shutdown = () => {
						try {
							if (st.value.pid)
								process.kill(st.value.pid, "SIGTERM")
						} catch {}
					}
					return {
						reused: true,
						pid: st.value.pid,
						host: `http://${ip}`,
						port,
						shutdown,
					} satisfies Monitor
				} else {
					yield* removeState
				}
			}

			// 2) If no state: adopt only if current listener on port is *actually* pocket-ic
			const maybePid = yield* pidByPortIfPocketIc(port)
			if (Option.isSome(maybePid)) {
				const pid = maybePid.value
				const alive = yield* isPidAlive(pid)
				if (alive) {
					// Recreate state for the already-running PIC
					yield* writeState({
						pid,
						startedAt: Date.now(),
						binPath: pocketIcPath,
						args: ["-i", ip, "-p", String(port), "--ttl", ttl],
						version: pocketIcVersion,
					})
					// Be sure it's accepting
					yield* waitTcpReady(ip, port).pipe(
						Effect.retry(
							Schedule.intersect(
								Schedule.spaced("120 millis"),
								Schedule.recurs(40),
							),
						),
					)
					const shutdown = () => {
						try {
							if (pid) process.kill(pid, "SIGTERM")
						} catch {}
					}
					return {
						reused: true,
						pid,
						host: `http://${ip}`,
						port,
						shutdown,
					} satisfies Monitor
				}
			}

			// 3) Start fresh in background via monitor
			const cmd = Command.make(
				process.execPath,
				monitorPath,
				...(opts.background ? ["--background"] : []), // never empty-arg
				"--state-file",
				statePath,
				"--parent",
				String(process.pid),
				"--bin",
				pocketIcPath,
				"--",
				"-i",
				ip,
				"-p",
				String(port),
				"--ttl",
				ttl,
			)

			yield* Effect.logDebug(
				`[pocket-ic] starting.... with cmd: ${cmd.toString()}`,
			)

			const proc = yield* commandExec.start(cmd)

			yield* Effect.logDebug(
				`[pocket-ic] starting in background (monitor pid ${proc.pid})`,
			)

			// 3a) Wait state → PID alive (treat empty/invalid JSON as "not ready")
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
				const parsed = yield* Effect.try(
					() => JSON.parse(txt) as PocketIcState,
				)
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

			// 3b) Confirm the listener PID is THIS state.pid (no port guessing)
			yield* Effect.gen(function* () {
				const owner = yield* pidByPortIfPocketIc(port)
				if (Option.isNone(owner) || owner.value !== state.pid) {
					return yield* Effect.fail(
						new ReplicaError({
							message: `PocketIC did not take ownership of ${ip}:${port} (listener mismatch)`,
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

			// 3c) Finally ensure TCP accepts
			yield* waitTcpReady(ip, port).pipe(
				Effect.retry(
					Schedule.intersect(
						Schedule.spaced("120 millis"),
						Schedule.recurs(50),
					),
				),
			)

			// 3d) Stamp version if missing
			if (!state.version) {
				yield* writeState({ ...state, version: pocketIcVersion })
			}

			const shutdown = () => {
				try {
					if (state.pid) process.kill(state.pid, "SIGTERM")
				} catch {}
			}

			return {
				reused: false,
				pid: state.pid,
				host: `http://${ip}`,
				port,
				shutdown,
			} satisfies Monitor
		}

		// foreground
		const cmd = Command.make(
			process.execPath,
			monitorPath,
			...(opts.background ? ["--background"] : []), // no empty-arg
			"--parent",
			String(process.pid),
			"--bin",
			pocketIcPath,
			"--",
			"-i",
			ip,
			"-p",
			String(port),
			"--ttl",
			ttl,
		)

		yield* Effect.logDebug(
			`[pocket-ic] starting.... with cmd: ${cmd.toString()}`,
		)

		const proc = yield* commandExec.start(cmd)

		yield* Effect.logDebug(
			`[pocket-ic] starting in foreground (monitor pid ${proc.pid})`,
		)

		const fatalStderrMonitor = makeStdErrMonitor(proc, ip, port)
		const stderrMonitorFiber = yield* Effect.forkScoped(fatalStderrMonitor)
		const shutdownMonitor = () =>
			Effect.sync(() => {
				try {
					if (proc.pid) process.kill(proc.pid, "SIGTERM")
				} catch {}
			})

		yield* Effect.addFinalizer(shutdownMonitor)

		yield* Effect.logDebug(
			`Pocket-IC monitor started (pid ${proc.pid}) -> pocket-ic @ http://${ip}:${port}`,
		)
		const shutdown = () => {
			try {
				if (proc.pid) process.kill(proc.pid, "SIGTERM")
			} catch {}
		}

		return {
			reused: false,
			pid: proc.pid,
			stdErrFiber: stderrMonitorFiber,
			host: `http://${ip}`,
			port,
			shutdown,
		} satisfies Monitor
	})

export const stopBackgroundPocketIc = Effect.gen(function* () {
	const st = yield* readState
	if (Option.isNone(st)) return false
	const pid = st.value.pid
	try {
		process.kill(-pid, "SIGTERM")
	} catch {}
	yield* Effect.sleep("250 millis")
	try {
		process.kill(-pid, "SIGKILL")
	} catch {}
	yield* removeState
	return true
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