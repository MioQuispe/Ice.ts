import { Effect, Option, Schedule, Stream } from "effect"
import { FileSystem, Path, Command, CommandExecutor } from "@effect/platform"
import os from "node:os"
import * as url from "node:url"
import { pocketIcPath, pocketIcVersion } from "@ice.ts/pocket-ic"
import { IceDir } from "../iceDir.js"
import { ReplicaError } from "../replica.js"
import { PlatformError } from "@effect/platform/Error"
import net from "node:net"

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

// --- NEW: wait until <host>:<port> accepts TCP connections (with per-try timeout)
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

export const ensureBackgroundPocketIc = (opts: {
  ip: string
  port: number
  ttlSeconds?: number
  extraArgs?: readonly string[]
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path
    const commandExec = yield* CommandExecutor.CommandExecutor

    const connectHost = opts.ip

    // 1) Try reuse
    const st = yield* readState
    if (Option.isSome(st)) {
      const alive = yield* isPidAlive(st.value.pid)
      const versionOk =
        (st.value.version ?? pocketIcVersion) === pocketIcVersion
      if (alive && versionOk) {
        // ensure the socket is ready before returning
        yield* waitTcpReady(connectHost, opts.port).pipe(
          Effect.retry(
            Schedule.intersect(
              Schedule.spaced("120 millis"),
              Schedule.recurs(40),
            ),
          ),
        )
        return {
          reused: true as const,
          pid: st.value.pid,
          host: `http://${opts.ip}`,
          port: opts.port,
        }
      } else {
        yield* removeState
      }
    }

    // 2) Start background via monitor
    const monitorPath = pathSvc.resolve(
      url.fileURLToPath(new URL(".", import.meta.url)),
      "../../../bin/monitor.js",
    )
    const ttl = String(opts.ttlSeconds ?? 9_999_999_999)
    const statePath = yield* statePathEffect

    const cmd = Command.make(
      process.execPath,
      monitorPath,
      "--background",
      "--state-file",
      statePath,
      "--parent",
      String(process.pid),
      "--bin",
      pocketIcPath,
      "--",
      "-i",
      opts.ip,
      "-p",
      String(opts.port),
      "--ttl",
      ttl,
      ...(opts.extraArgs ?? []),
    )

    yield* Effect.logInfo(
      `[pocket-ic] starting.... with cmd: ${cmd.toString()}`,
    )

    const proc = yield* commandExec.start(cmd)

    yield* Effect.logInfo(
      `[pocket-ic] starting in background (monitor pid ${proc.pid})`,
    )

    // wait until state file appears & PID is alive (soft retries)
    yield* Effect.gen(function* () {
      const exists = yield* fs.exists(statePath)
      if (!exists) {
        return yield* Effect.fail(
          new ReplicaError({ message: `PocketIC background state file missing` }),
        )
      }
      const txt = yield* fs.readFileString(statePath)
      const st2 = JSON.parse(txt) as PocketIcState
      const alive2 = yield* isPidAlive(st2.pid)
      if (!alive2) {
        return yield* Effect.fail(
          new ReplicaError({ message: `PocketIC background process died` }),
        )
      }
      return st2
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.exponential("25 millis"),
          Schedule.recurs(20),
        ),
      ),
    )

    // after PID is alive, additionally wait for the port to accept connections
    yield* waitTcpReady(connectHost, opts.port).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("120 millis"),
          Schedule.recurs(50),
        ),
      ),
    )

    // Optionally update with version
    const txt = yield* fs.readFileString(statePath)
    const parsed = JSON.parse(txt) as PocketIcState
    if (!parsed.version) {
      parsed.version = pocketIcVersion
      yield* writeState(parsed)
    }

    return {
      reused: false as const,
      pid: parsed.pid,
      host: `http://${opts.ip}`,
      port: opts.port,
    }
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

// small helper to decode stdout/stderr chunks
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
  ip: string // e.g. "0.0.0.0"
  port: number // e.g. 8081
  ttlSeconds?: number // optional, defaults below
  extraArgs?: readonly string[]
  background?: boolean
}

/**
 * Starts the pocket-ic monitor which in turn starts pocket-ic in a new process group.
 * Returns the started Process (the monitor) and host/port for connecting.
 * Scoped: when the scope ends, we SIGTERM the monitor (which kills the group).
 */
export const startPocketIcWithMonitor = (opts: PocketIcOpts) =>
  Effect.gen(function* () {
    const commandExecutor = yield* CommandExecutor.CommandExecutor
    const path = yield* Path.Path

    const ip = opts.ip
    const port = opts.port
    const ttl = String(opts.ttlSeconds ?? 9_999_999_999)
    const background = opts.background ?? false

    const monitorPath = path.resolve(
      url.fileURLToPath(new URL(".", import.meta.url)),
      "../../../bin/monitor.js",
    )

    const monitor = Command.make(
      process.execPath,
      monitorPath,
      ...(background ? ["--background"] : []),
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
      ...(opts.extraArgs ?? []),
    )

    const proc = yield* commandExecutor.start(monitor)

    yield* Effect.forkDaemon(
      Stream.runForEach(proc.stdout, (chunk) =>
        Effect.logDebug(`[pocket-ic stdout] ${decodeChunk(chunk)}`),
      ),
    )
    yield* Effect.forkDaemon(
      Stream.runForEach(proc.stderr, (chunk) =>
        Effect.logError(`[pocket-ic stderr] ${decodeChunk(chunk)}`),
      ),
    )

    yield* Effect.logDebug(
      `Pocket-IC monitor started (pid ${proc.pid}) -> pocket-ic @ http://${ip}:${port}`,
    )

    const fatalStderrMonitor = Stream.runForEach(proc.stderr, (chunk) =>
      Effect.gen(function* () {
        const text = decodeChunk(chunk)
        for (const line of text.split("\n")) {
          if (!line) continue
          yield* Effect.logError(`[pocket-ic stderr] ${line}`)
          if (/Failed to bind PocketIC server to address/i.test(line)) {
            return yield* Effect.fail(
              new ReplicaError({
                message: `PocketIC failed to bind to ${ip}:${port}. Port likely in use.`,
              }),
            )
          }
          if (/thread 'main' panicked/i.test(line)) {
            return yield* Effect.fail(
              new ReplicaError({
                message: `PocketIC panicked during startup: ${line}`,
              }),
            )
          }
        }
      }),
    ) as Effect.Effect<never, ReplicaError | PlatformError>
    const stderrMonitorFiber = yield* Effect.forkDaemon(fatalStderrMonitor)

    const stdoutFiber = yield* Effect.forkDaemon(
      Stream.runForEach(proc.stdout, (chunk) =>
        Effect.gen(function* () {
          const text = decodeChunk(chunk)
          for (const line of text.split("\n")) {
            if (line) yield* Effect.logDebug(`[pocket-ic stdout] ${line}`)
          }
        }),
      ),
    )

    const decodeChunk = (chunk: unknown): string => {
      if (typeof chunk === "string") return chunk
      try {
        // best-effort for Uint8Array/Buffer
        // @ts-ignore
        if (chunk && typeof chunk.length === "number") {
          return new TextDecoder().decode(chunk as any)
        }
      } catch {}
      return String(chunk)
    }

    return {
      monitorFiber: stderrMonitorFiber,
      monitorPid: proc.pid,
      host: `http://${ip}`,
      port,
    } as const
  })