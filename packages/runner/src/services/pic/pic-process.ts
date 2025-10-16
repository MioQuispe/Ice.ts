// src/services/pic/pic-process.ts
import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as url from "node:url"
import net from "node:net"
import { randomUUID } from "node:crypto"
import { pocketIcPath, pocketIcVersion } from "@ice.ts/pocket-ic"

import { ReplicaStartError } from "../replica.js"
import type { ICEConfigContext } from "../../types/types.js"

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

/* ----------------------------- Types ---------------------------------------- */

const createDefaultTopology = () =>
	({
		nns: { state: { type: "New" as const } },
		ii: { state: { type: "New" as const } },
		fiduciary: { state: { type: "New" as const } },
		bitcoin: { state: { type: "New" as const } },
		sns: { state: { type: "New" as const } },
		application: [{ state: { type: "New" as const } }],
	}) as const

export type NormalizedConfig = {
	pocketIcCli: {
		bind: string
		port: number
		ttl: number
	}
	instance: {
		stateDir: string
		initialTime: {
			AutoProgress: { artificialDelayMs: number }
		}
		topology: ReturnType<typeof createDefaultTopology>
		incompleteState: boolean
		nonmainnet: boolean
		verifiedApplication: number
	}
}

export type PocketIcState = {
	schemaVersion?: number
	managed: boolean
	mode: "foreground" | "background" | null
	monitorPid: number | null
	binPath: string | null
	version: string | null
	args: ReadonlyArray<string> | null
	bind: string | null
	port: number | null
	startedAt: number | null
	instanceRoot?: string
	config?: NormalizedConfig | null
}

export type LeaseFile = {
	mode: "foreground" | "background"
	pid: number
	startedAt: number // == state.startedAt at the moment this lease was created
}

type Paths = {
	root: string
	stateFile: string
	leasesDir: string
	spawnLock: string
	instanceRoot: string
}

export type Monitor = {
	host: string
	port: number
	reused: boolean
	shutdown: () => void
	waitForExit: () => Promise<void>
}

/* ----------------------------- Utils ---------------------------------------- */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const isPidAlive = (pid: number | null | undefined): boolean => {
	if (!pid || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

const resolvePaths = (iceDirPath: string): Paths => {
	const root = path.resolve(iceDirPath, "pocketic-server")
	return {
		root,
		stateFile: path.join(root, "state.json"),
		leasesDir: path.join(root, "leases"),
		spawnLock: path.join(root, "spawn.lock"),
		instanceRoot: root,
	}
}

const ensureDir = async (p: string) => {
	await fs.mkdir(p, { recursive: true }).catch(() => {})
}

const readJsonFile = async <T>(p: string): Promise<T | undefined> => {
	try {
		const txt = await fs.readFile(p, "utf8")
		return JSON.parse(txt) as T
	} catch {
		return undefined
	}
}

const writeFileAtomic = async (target: string, contents: string) => {
	const tmp = `${target}.tmp`
	await ensureDir(path.dirname(target))
	const fh = await fs.open(tmp, "w")
	try {
		await fh.writeFile(contents, "utf8")
		await fh.sync()
	} finally {
		await fh.close()
	}
	await fs.rename(tmp, target)
	try {
		const d = await fs.open(path.dirname(target), "r")
		try {
			await d.sync()
		} finally {
			await d.close()
		}
	} catch {}
}

const portListening = (
	host: string,
	port: number,
	timeoutMs = 400,
): Promise<boolean> =>
	new Promise((resolve) => {
		const socket = net.connect({ host, port })
		let done = false
		const finish = (v: boolean) => {
			if (done) return
			done = true
			try {
				socket.destroy()
			} catch {}
			resolve(v)
		}
		const to = setTimeout(() => finish(false), timeoutMs)
		socket.once("connect", () => {
			clearTimeout(to)
			finish(true)
		})
		socket.once("error", () => {
			clearTimeout(to)
			finish(false)
		})
	})

const waitUntil = async (
	fn: () => Promise<boolean>,
	attempts: number,
	delayMs: number,
) => {
	for (let i = 0; i < attempts; i++) {
		if (await fn()) return
		await sleep(delayMs)
	}
	throw new Error("timeout")
}

const stableSort = (v: unknown): unknown => {
	if (Array.isArray(v)) return v.map(stableSort)
	if (v && typeof v === "object") {
		const entries = Object.entries(v as Record<string, unknown>).sort(
			([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
		)
		const out: Record<string, unknown> = {}
		for (const [k, val] of entries) out[k] = stableSort(val)
		return out
	}
	return v
}

const deepEqual = (a: unknown, b: unknown): boolean =>
	JSON.stringify(stableSort(a)) === JSON.stringify(stableSort(b))

/* -------------------------- Spawn lock (spawn.lock) -------------------------- */

const acquireSpawnLock = async (
	lockPath: string,
): Promise<() => Promise<void>> => {
	await ensureDir(path.dirname(lockPath))
	while (true) {
		try {
			const fh = await fs.open(lockPath, "wx")
			try {
				await fh.writeFile(
					JSON.stringify(
						{ pid: process.pid, createdAt: Date.now() },
						null,
						2,
					),
					"utf8",
				)
				await fh.sync()
			} finally {
				await fh.close()
			}
			return async () => {
				await fs.unlink(lockPath).catch(() => {})
			}
		} catch (e: any) {
			if (e?.code !== "EEXIST") throw e
			let dead = false
			try {
				const raw = await readJsonFile<{ pid?: number }>(lockPath)
				dead = raw?.pid ? !isPidAlive(raw.pid) : true
			} catch {
				dead = true
			}
			if (dead) {
				await fs.unlink(lockPath).catch(() => {})
				continue
			}
			await sleep(100)
		}
	}
}

/* ----------------------------- Leases ---------------------------------------- */

const listFgAliveLeases = async (
	dir: string,
	serverStartedAt: number,
): Promise<number> => {
	await ensureDir(dir)
	const files = await fs.readdir(dir).catch(() => [])
	let fg = 0
	for (const f of files) {
		if (!f.endsWith(".json")) continue
		const p = path.join(dir, f)
		const lease = await readJsonFile<LeaseFile>(p)
		if (!lease) continue
		if (lease.mode !== "foreground") continue
		if (lease.startedAt !== serverStartedAt) continue
		if (isPidAlive(lease.pid)) fg++
		else await fs.unlink(p).catch(() => {})
	}
	return fg
}

const removeBgLeasesFor = async (dir: string, serverStartedAt: number) => {
	await ensureDir(dir)
	const files = await fs.readdir(dir).catch(() => [])
	for (const f of files) {
		if (!f.endsWith(".json")) continue
		const p = path.join(dir, f)
		const lease = await readJsonFile<LeaseFile>(p)
		if (!lease) continue
		if (
			lease.mode === "background" &&
			lease.startedAt === serverStartedAt
		) {
			await fs.unlink(p).catch(() => {})
		}
	}
}

const createLease = async (dir: string, data: LeaseFile): Promise<string> => {
	await ensureDir(dir)
	const p = path.join(dir, `${randomUUID()}.json`)
	await writeFileAtomic(p, JSON.stringify(data, null, 2))
	return p
}

/* ----------------------------- State helpers --------------------------------- */

export const readState = (p: string) => readJsonFile<PocketIcState>(p)

const patchState = async (p: string, patch: Partial<PocketIcState>) => {
	const cur =
		(await readState(p)) ??
		({
			managed: true,
			mode: null,
			monitorPid: null,
			binPath: pocketIcPath,
			version: pocketIcVersion,
			args: null,
			bind: null,
			port: null,
			startedAt: null,
		} as PocketIcState)
	const merged = { schemaVersion: 1, ...cur, ...patch }
	await writeFileAtomic(p, JSON.stringify(merged, null, 2))
}

/* ----------------------------- Monitor spawn --------------------------------- */

const buildMonitorArgs = (opts: {
	background: boolean
	stateFile: string
	leasesDir: string
	logFile?: string
	host: string
	port: number
}) => {
	const args: string[] = [path.resolve(__dirname, "../../../bin/monitor.js")]
	if (opts.background) args.push("--background")
	args.push("--state-file", opts.stateFile)
	args.push("--leases-dir", opts.leasesDir)
	args.push("--bin", pocketIcPath)
	if (opts.logFile) args.push("--log-file", path.resolve(opts.logFile))
	args.push("--", "-i", opts.host, "-p", String(opts.port))
	return args
}

// NOTE: foreground uses stderr=pipe so we can parse fatal lines.
const spawnMonitor = (args: string[], background: boolean): ChildProcess =>
	spawn(process.execPath, args, {
		detached: true,
		stdio: background ? "ignore" : ["ignore", "inherit", "pipe"],
		env: { ...process.env, RUST_BACKTRACE: "full" },
	})

/* ---- Fatal stderr watcher (PocketIC-specific parse of monitor stderr) ------- */

const makeFatalStderrPromise = (
	proc: ChildProcess,
	ip: string,
	port: number,
): Promise<never> => {
	if (!proc.stderr) {
		return new Promise<never>(() => {})
	}
	return new Promise<never>((_resolve, reject) => {
		let sawFatal = false
		const onData = (chunk: Buffer | string) => {
			const text =
				typeof chunk === "string" ? chunk : chunk.toString("utf8")
			for (const line of text.split("\n")) {
				if (!line) continue
				if (/Failed to bind PocketIC server to address/i.test(line)) {
					sawFatal = true
					reject(
						new ReplicaStartError({
							reason: "PortInUseError",
							message: `PocketIC failed to bind to ${ip}:${port}. Port likely in use.`,
						}),
					)
				}
				if (/thread 'main' panicked/i.test(line)) {
					sawFatal = true
					reject(
						new ReplicaStartError({
							reason: "PortInUseError",
							// No dedicated "Panic" code in scenarios; treat as start failure.
							message: `PocketIC panicked during startup: ${line}`,
						}),
					)
				}
			}
		}
		proc.stderr?.on("data", onData)
		proc.on("exit", () => {
			if (!sawFatal) return
			reject(
				new ReplicaStartError({
					reason: "PortInUseError",
					message:
						"PocketIC monitor exited unexpectedly during startup",
				}),
			)
		})
	})
}

/* ------------------------------- Config -------------------------------------- */

const detectIncompleteState = async (stateDir: string): Promise<boolean> => {
	try {
		const entries = await fs.readdir(stateDir, { withFileTypes: true })
		return !entries.some((e) => e.isDirectory())
	} catch {
		return true
	}
}

const computeNormalizedConfig = async (
	ctx: ICEConfigContext,
	host: string,
	port: number,
): Promise<NormalizedConfig> => {
	const stateDir = path.resolve(ctx.iceDirPath, "replica-state")
	const incompleteState = await detectIncompleteState(stateDir)
	return {
		pocketIcCli: { bind: host, port, ttl: 9_999_999_999 },
		instance: {
			stateDir,
			initialTime: { AutoProgress: { artificialDelayMs: 0 } },
			topology: createDefaultTopology(),
			incompleteState,
			nonmainnet: ctx.network !== "ic",
			verifiedApplication: 0,
		},
	}
}

/* ------------------------------- Main API ------------------------------------ */

export async function makeMonitor(
	ctx: ICEConfigContext,
	opts: { host: string; port: number },
): Promise<Monitor> {
	const mode: "foreground" | "background" = ctx.background
		? "background"
		: "foreground"
	const host = opts.host
	const port = opts.port
	const desiredArgs = ["-i", host, "-p", String(port)]
	const desiredConfig = await computeNormalizedConfig(ctx, host, port)
	const paths = resolvePaths(ctx.iceDirPath)
	const logFile = path.join(ctx.iceDirPath, "pocket-ic.log")

	await ensureDir(paths.root)
	await ensureDir(paths.leasesDir)

	const releaseLock = await acquireSpawnLock(paths.spawnLock)
	let reused = false
	try {
		let st = await readState(paths.stateFile)

		if (st) {
			const listening = await portListening(
				st.bind ?? host,
				st.port ?? port,
			)
			if (!listening) {
				await fs.unlink(paths.stateFile).catch(() => {})
				st = undefined
			}
		}

		if (st) {
			const mismatch = !deepEqual(st.config ?? null, desiredConfig)
			if (ctx.policy === "restart" && mismatch) {
				if (st.mode === "background" && mode === "foreground") {
					throw new ReplicaStartError({
						reason: "ProtectedServerError",
						message:
							"FG restart is not allowed while BG-managed server is present.",
					})
				}
				const startedAt = st.startedAt ?? 0
				const fgAlive = await listFgAliveLeases(
					paths.leasesDir,
					startedAt,
				)
				if (fgAlive > 0) {
					throw new ReplicaStartError({
						reason: "PortInUseError",
						message:
							"Restart denied: foreground leases are active.",
					})
				}
				await removeBgLeasesFor(paths.leasesDir, startedAt)

				// wait for monitor to shut down (leases==0 → state.json removed)
				await releaseLock()
				await waitUntil(
					async () => !(await readState(paths.stateFile)),
					200,
					50,
				)

				// spawn fresh
				const relock = await acquireSpawnLock(paths.spawnLock)
				try {
					const args = buildMonitorArgs({
						background: mode === "background",
						stateFile: paths.stateFile,
						leasesDir: paths.leasesDir,
						logFile,
						host,
						port,
					})
					const proc = spawnMonitor(args, mode === "background")
					if (mode === "background") {
						try {
							proc.unref()
						} catch {}
						await waitUntil(
							async () => !!(await readState(paths.stateFile)),
							200,
							50,
						)
						await waitUntil(
							async () => portListening(host, port),
							200,
							50,
						)
					} else {
						const fatal = makeFatalStderrPromise(proc, host, port)
						await Promise.race([
							fatal,
							(async () => {
								await waitUntil(
									async () =>
										!!(await readState(paths.stateFile)),
									200,
									50,
								)
								await waitUntil(
									async () => portListening(host, port),
									200,
									50,
								)
								return true
							})(),
						])
					}
				} finally {
					await relock()
				}
				reused = false
			} else {
				await waitUntil(async () => portListening(host, port), 200, 50)
				reused = true
			}
		}

		let finalState = await readState(paths.stateFile)
		if (!finalState) {
			const occupied = await portListening(host, port)
			if (occupied) {
				if (ctx.policy === "restart") {
					await releaseLock()
					throw new ReplicaStartError({
						reason: "ManualPocketICPresentError",
						message:
							"Manual PocketIC present; cannot restart unmanaged server.",
					})
				}
				return {
					host,
					port,
					reused: true,
					shutdown: () => {},
					waitForExit: async () => {},
				}
			}

			const args = buildMonitorArgs({
				background: mode === "background",
				stateFile: paths.stateFile,
				leasesDir: paths.leasesDir,
				logFile,
				host,
				port,
			})
			const proc = spawnMonitor(args, mode === "background")
			if (mode === "background") {
				try {
					proc.unref()
				} catch {}
				await waitUntil(
					async () => !!(await readState(paths.stateFile)),
					200,
					50,
				)
				await waitUntil(async () => portListening(host, port), 200, 50)
			} else {
				const fatal = makeFatalStderrPromise(proc, host, port)
				await Promise.race([
					fatal,
					(async () => {
						await waitUntil(
							async () => !!(await readState(paths.stateFile)),
							200,
							50,
						)
						await waitUntil(
							async () => portListening(host, port),
							200,
							50,
						)
						return true
					})(),
				])
			}
			reused = false
			finalState = await readState(paths.stateFile)
		}

		// patch state so future runs can detect mismatch by deep-equal on config
		if (finalState) {
			await patchState(paths.stateFile, {
				binPath: pocketIcPath,
				version: pocketIcVersion,
				mode: finalState.mode ?? mode,
				bind: host,
				port,
				args: ["-i", host, "-p", String(port)],
				config: desiredConfig,
			})
		}

		// create lease for managed only
		// const stNow = (await readState(paths.stateFile))!
		// if (stNow?.managed && stNow.startedAt) {
		// 	const lease: LeaseFile = {
		// 		mode,
		// 		pid: mode === "foreground" ? process.pid : 0,
		// 		startedAt: stNow.startedAt,
		// 	}
		// 	await createLease(paths.leasesDir, lease)
		// }
	} finally {
		await releaseLock()
	}

	return {
		host,
		port,
		reused,
		shutdown: () => {},
		waitForExit: async () => {},
	}
}

/* ------------ Optional helpers used by other parts of the runner ------------- */

export async function createLeaseFile(opts: {
	iceDirPath: string
	mode: "foreground" | "background"
	serverStartedAt: number
}): Promise<string> {
	const dir = path.join(opts.iceDirPath, "pocketic-server", "leases")
	const lease: LeaseFile = {
		mode: opts.mode,
		pid: opts.mode === "foreground" ? process.pid : 0,
		startedAt: opts.serverStartedAt,
	}
	return createLease(dir, lease)
}

export async function removeLeaseFileByPath(p: string) {
	await fs.unlink(p).catch(() => {})
}
