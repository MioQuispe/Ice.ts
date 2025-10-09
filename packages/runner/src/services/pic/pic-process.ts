// pic-process.ts (async/await version, no effect-ts)

import { spawn, ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import * as fssync from "node:fs"
import * as path from "node:path"
import * as url from "node:url"
import net from "node:net"
import find from "find-process"
import { pocketIcPath, pocketIcVersion } from "@ice.ts/pocket-ic"
import { ReplicaError } from "../replica.js"
import type { ICEConfigContext } from "../../types/types.js"

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

// ---------------- helpers ----------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const statePath = (iceDirPath: string) =>
	path.join(iceDirPath, "pocketic-server", "state.json")
const logBasePath = (iceDirPath: string) => path.join(iceDirPath)

const ensureDir = async (p: string) => {
	await fs.mkdir(p, { recursive: true }).catch(() => {})
}

const readJson = async <T>(p: string): Promise<T> => {
	const txt = await fs.readFile(p, "utf8")
	return JSON.parse(txt) as T
}

const writeJson = async (p: string, data: unknown) => {
	await ensureDir(path.dirname(p))
	await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8")
}

const removeIfExists = async (p: string) => {
	try {
		await fs.unlink(p)
	} catch {}
}

const exists = async (p: string) => {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

const isPidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

const waitTcpReady = (host: string, port: number, perTryMs = 800) =>
	new Promise<void>((resolve, reject) => {
		const socket = net.connect({ host, port })
		const to = setTimeout(
			() => socket.destroy(new Error("timeout")),
			perTryMs,
		)

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
	})

// TODO: fix:
export async function awaitPortClosed(
	port: number,
	host = "0.0.0.0",
	timeoutMs = 15000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const closed = await new Promise<boolean>((resolve) => {
			const s = net.connect({ port, host }, () => {
				s.destroy()
				resolve(false) // still open
			})
			s.on("error", () => resolve(true)) // connection refused => closed
			s.setTimeout(200, () => {
				s.destroy()
				resolve(false)
			})
		})
		if (closed) return
		await sleep(100)
	}
	throw new ReplicaError({
		message: `port ${host}:${port} still open after ${timeoutMs}ms`,
	})
}

// If a process is listening on <port> and looks like pocket-ic -> pid, else undefined
async function pidByPortIfPocketIc(port: number): Promise<number | undefined> {
	try {
		const list = await find("port", port)
		const match = list.find((p) => {
			const cmd = (p as any).cmd as string | undefined
			const name = (p as any).name as string | undefined
			return (
				// Only adopt processes that are our managed pocket-ic binary path
				!!cmd && cmd.includes(pocketIcPath)
			)
		})
		return match ? ((match as any).pid as number) : undefined
	} catch {
		return undefined
	}
}

type PocketIcState = {
	pid: number
	startedAt: number
	binPath: string
	args: string[]
	version?: string
}

function buildMonitorArgs(opts: {
	background: boolean
	parentPid: number
	stateFile?: string
	logFile?: string
	ip: string
	port: number
	ttl: string
}) {
	const args: string[] = [path.resolve(__dirname, "../../../bin/monitor.js")]
	if (opts.background) args.push("--background")
	if (opts.stateFile) {
		args.push("--state-file", opts.stateFile)
	}
	console.log("creating monitor with logFile", opts.logFile)
	if (opts.logFile) {
		args.push("--log-file", path.resolve(opts.logFile))
	}
	args.push(
		"--parent",
		String(opts.parentPid),
		"--bin",
		pocketIcPath,
		"--",
		"-i",
		opts.ip,
		"-p",
		String(opts.port),
		"--ttl",
		opts.ttl,
	)
	console.log("monitor args", args)
	return args
}

function spawnMonitor(args: string[], bg: boolean): ChildProcess {
	// In background, monitor itself will detach pocket-ic; we don't need to capture stdio
	return spawn(process.execPath, args, {
		detached: true,
		stdio: bg ? "ignore" : ["ignore", "inherit", "pipe"], // capture stderr for fatal scan in foreground
		env: {
			RUST_BACKTRACE: "full",
		},
	})
}

function makeFatalStderrPromise(
	proc: ChildProcess,
	ip: string,
	port: number,
): Promise<never> {
	if (!proc.stderr) {
		// No stderr available → never resolve/reject (acts like Effect.never)
		return new Promise<never>(() => {})
	}
	return new Promise<never>((_resolve, reject) => {
		const onData = (chunk: Buffer | string) => {
			const text =
				typeof chunk === "string" ? chunk : chunk.toString("utf8")
			for (const line of text.split("\n")) {
				if (!line) continue
				if (/Failed to bind PocketIC server to address/i.test(line)) {
					reject(
						new ReplicaError({
							message: `PocketIC failed to bind to ${ip}:${port}. Port likely in use.`,
						}),
					)
				}
				if (/thread 'main' panicked/i.test(line)) {
					reject(
						new ReplicaError({
							message: `PocketIC panicked during startup: ${line}`,
						}),
					)
				}
			}
		}
		proc.stderr!.on("data", onData)
		proc.on("exit", () => {
			// If it exits before we ever became healthy, treat as fatal
			reject(
				new ReplicaError({
					message: `PocketIC monitor exited unexpectedly during startup`,
				}),
			)
		})
	})
}

// --------------- public API ---------------

export type Monitor = {
	pid: number
	host: string // "http://<ip>"
	port: number
	reused: boolean
	shutdown: () => void
	waitForExit: () => Promise<void>
	fatalStderr?: Promise<never> // only for foreground; race this against client init
}

export async function makeMonitor(
	ctx: ICEConfigContext,
	opts: {
		host: string // ip (e.g. "0.0.0.0")
		port: number
		ttlSeconds?: number
	},
): Promise<Monitor> {
	const ip = opts.host
	const port = opts.port
	const ttl = String(opts.ttlSeconds ?? 9_999_999_999)
	const stPath = statePath(ctx.iceDirPath)

	// --- Reuse: state exists & alive & version matches
	if (await exists(stPath)) {
		try {
			const st = await readJson<PocketIcState>(stPath)
			const alive = isPidAlive(st.pid)
			const versionOk =
				(st.version ?? pocketIcVersion) === pocketIcVersion
			if (alive && versionOk) {
				// ensure accepting connections
				await retry(async () => waitTcpReady(ip, port), 40, 120)
				return {
					pid: st.pid,
					host: `http://${ip}`,
					port,
					reused: true,
					shutdown: () => {
						/* no-op for reused background */
					},
					waitForExit: async () => {
						// Reused background process: do not wait; assume managed externally
						return
					},
				}
			}
		} catch {
			// fall through to remove
		}
		await removeIfExists(stPath)
	}

	// --- Adopt: something is already listening AND is pocket-ic → recreate state and reuse
	{
		const pid = await pidByPortIfPocketIc(port)
		if (pid && isPidAlive(pid)) {
			await writeJson(stPath, {
				pid,
				startedAt: Date.now(),
				binPath: pocketIcPath,
				args: ["-i", ip, "-p", String(port), "--ttl", ttl],
				version: pocketIcVersion,
			} satisfies PocketIcState)
			await retry(async () => waitTcpReady(ip, port), 40, 120)
			return {
				pid,
				host: `http://${ip}`,
				port,
				reused: true,
				shutdown: () => {
					/* adopted background → no-op by default */
				},
				waitForExit: async () => {
					// Adopted external process: do not wait; assume managed externally
					return
				},
			}
		}
	}

	console.log("iceDirPath", ctx.iceDirPath, "logPathBase", logBasePath(ctx.iceDirPath))
	// --- Start fresh (background or foreground)
	if (ctx.background) {
		// Background: monitor writes state and exits immediately
		const logPathBase = logBasePath(ctx.iceDirPath)
		const args = buildMonitorArgs({
			background: true,
			parentPid: process.pid,
			stateFile: stPath,
			logFile: `${logPathBase}/pocket-ic.log`,
			ip,
			port,
			ttl,
		})
		const proc = spawnMonitor(args, true)
		try {
			proc.unref()
		} catch {}

		// Wait: state file exists + parse + pid alive (soft retries)
		const state = await retry(
			async () => {
				if (!(await exists(stPath))) {
					throw new ReplicaError({
						message: "PocketIC background state file missing",
					})
				}
				const txt = await fs.readFile(stPath, "utf8")
				if (!txt.trim()) {
					throw new ReplicaError({
						message: "PocketIC background state not ready",
					})
				}
				let parsed: PocketIcState
				try {
					parsed = JSON.parse(txt)
				} catch {
					throw new ReplicaError({
						message: "Failed to parse PocketIC background state",
					})
				}
				if (!isPidAlive(parsed.pid)) {
					throw new ReplicaError({
						message: "PocketIC background process died",
					})
				}
				return parsed
			},
			20,
			25,
			true,
		) // exponential-ish (25ms base)

		// Verify listener ownership by pid, then TCP ready
		await retry(
			async () => {
				const owner = await pidByPortIfPocketIc(port)
				if (owner !== state.pid) {
					throw new ReplicaError({
						message: `PocketIC did not take ownership of ${ip}:${port} (listener mismatch)`,
					})
				}
			},
			50,
			120,
		)
		await retry(async () => waitTcpReady(ip, port), 50, 120)

		// Stamp version if missing
		if (!state.version) {
			await writeJson(stPath, { ...state, version: pocketIcVersion })
		}

		return {
			pid: state.pid,
			host: `http://${ip}`,
			port,
			reused: false,
			shutdown: () => {
				// design choice: keep background instance running
			},
			waitForExit: async () => {
				// Background monitor exits immediately; we cannot wait on it here
				// Users should not rely on waitForExit in background mode
				return
			},
		}
	}

	const logPathBase = logBasePath(ctx.iceDirPath)
	// Foreground: start monitor; keep stderr fatal watcher and provide shutdown
	const args = buildMonitorArgs({
		background: false,
		parentPid: process.pid,
		logFile: `${logPathBase}.log`,
		ip,
		port,
		ttl,
	})
	const proc = spawnMonitor(args, false)

	const fatalStderr = makeFatalStderrPromise(proc, ip, port)
	try {
		await Promise.race([
			fatalStderr,
			retry(async () => waitTcpReady(ip, port), 60, 100, true),
		])
		console.log(
			`[PICMonitor] foreground pocket-ic ready ${ip}:${port} (pid=${proc.pid ?? "unknown"})`,
		)
	} catch (error) {
		console.error(
			`[PICMonitor] failed to observe pocket-ic readiness on ${ip}:${port}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
		try {
			if (proc.pid) process.kill(proc.pid, "SIGKILL")
		} catch {}
		throw error
	}
	const shutdown = () => {
		try {
			if (proc.pid) process.kill(proc.pid, "SIGTERM")
		} catch {}
	}

	const waitForExit = () =>
		new Promise<void>((resolve) => {
			proc.on("exit", () => resolve())
		})

	return {
		pid: proc.pid ?? -1,
		host: `http://${ip}`,
		port,
		reused: false,
		shutdown,
		waitForExit,
		fatalStderr,
	}
}

// simple retry helper: attempts, spaced delayMs; if exponential=true use 2^n backoff on the base
async function retry<T>(
	fn: () => Promise<T>,
	attempts: number,
	delayMs: number,
	exponential = false,
): Promise<T> {
	let lastErr: unknown
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn()
		} catch (e) {
			lastErr = e
			const d = exponential ? delayMs * Math.max(1, 2 ** i) : delayMs
			await sleep(d)
		}
	}
	throw lastErr
}
