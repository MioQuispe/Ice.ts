// src/services/pic/pic-process.ts
import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as url from "node:url"
import net from "node:net"
import { randomUUID } from "node:crypto"
import { pocketIcPath, pocketIcVersion } from "@ice.ts/pocket-ic"

import { ReplicaStartError } from "../replica.js"

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
	startedAt: number
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
			const lockFileHandle = await fs.open(lockPath, "wx")
			try {
				await lockFileHandle.writeFile(
					JSON.stringify(
						{ pid: process.pid, createdAt: Date.now() },
						null,
						2,
					),
					"utf8",
				)
				await lockFileHandle.sync()
			} finally {
				await lockFileHandle.close()
			}
			return async () => {
				await fs.unlink(lockPath).catch(() => {})
			}
		} catch (e: any) {
			if (e?.code !== "EEXIST") throw e
			let dead = false
			try {
				const lockFileInfo = await readJsonFile<{ pid?: number }>(
					lockPath,
				)
				dead = lockFileInfo?.pid ? !isPidAlive(lockFileInfo.pid) : true
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

/** Count alive FG leases. If serverStartedAt<=0, count ALL alive FG leases. */
const countAliveFgLeases = async (
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
		if (serverStartedAt > 0 && lease.startedAt !== serverStartedAt) continue
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

/* ----------------------------- State helpers --------------------------------- */

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

const spawnMonitor = (args: string[], background: boolean): ChildProcess =>
	spawn(process.execPath, args, {
		detached: true,
		stdio: background ? "ignore" : ["ignore", "inherit", "pipe"],
		env: { ...process.env, RUST_BACKTRACE: "full" },
	})

/* ---- Fatal stderr watcher --------------------------------------------------- */

const makeFatalStderrPromise = (
	proc: ChildProcess,
	ip: string,
	port: number,
): Promise<never> => {
	if (!proc.stderr) return new Promise<never>(() => {})
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

/* ------------------------------- Monitor (class) ------------------------------ */

export class Monitor {
	public readonly host: string
	public readonly port: number
	private readonly mode: "foreground" | "background"
	// private readonly ctx: ICEConfigContext
	private readonly iceDirPath: string
	private readonly policy: "reuse" | "restart"
	private readonly isDev: boolean

	constructor(opts: {
		host: string
		port: number
		background: boolean
		policy: "reuse" | "restart"
		iceDirPath: string
		isDev: boolean
	}) {
		this.host = opts.host
		this.port = opts.port
		this.mode = opts.background ? "background" : "foreground"
		this.isDev = opts.isDev
		this.iceDirPath = opts.iceDirPath
		this.policy = opts.policy
	}

	private async readMonitorState() {
		const stateFilePath = path.resolve(
			this.iceDirPath,
			"pocketic-server",
			"monitor.json",
		)
		const state = await readJsonFile<PocketIcState>(stateFilePath)
		return state
	}

	private computeNormalizedConfig = async (): Promise<NormalizedConfig> => {
		const stateDir = path.resolve(this.iceDirPath, "replica-state")
		const incompleteState = await detectIncompleteState(stateDir)
		return {
			pocketIcCli: {
				bind: this.host,
				port: this.port,
				ttl: 9_999_999_999,
			},
			instance: {
				stateDir,
				initialTime: { AutoProgress: { artificialDelayMs: 0 } },
				topology: createDefaultTopology(),
				incompleteState,
				// TODO: ??? wtf is this
				// nonmainnet: this.network !== "ic",
				nonmainnet: this.isDev,
				verifiedApplication: 0,
			},
		}
	}

	public async createLease(args: { mode: "foreground" | "background" }) {
		const monitorState = await this.readMonitorState()
		// Create an ephemeral lease whenever a managed server monitor.json exists.
		// If startedAt is absent, use 0 so tests count it with the "any server" rule.
		if (monitorState) {
			const dir = path.join(this.iceDirPath, "pocketic-server", "leases")
			const lease: LeaseFile = {
				mode: args.mode,
				pid: process.pid,
				startedAt: monitorState.startedAt!,
			}
			await ensureDir(dir)
			const p = path.join(dir, `${randomUUID()}.json`)
			await writeFileAtomic(p, JSON.stringify(lease, null, 2))
			// return p
		}
	}

	async spawn(): Promise<void> {
		const leasesDirPath = path.resolve(
			this.iceDirPath,
			"pocketic-server",
			"leases",
		)
		const logFilePath = path.resolve(this.iceDirPath, "pocket-ic.log")
		const stateFilePath = path.resolve(
			this.iceDirPath,
			"pocketic-server",
			"monitor.json",
		)
		const spawnLockPath = path.resolve(
			this.iceDirPath,
			"pocketic-server",
			"spawn.lock",
		)
		// spawn fresh
		const releaseLock = await acquireSpawnLock(spawnLockPath)
		try {
			const args = buildMonitorArgs({
				background: this.mode === "background",
				stateFile: stateFilePath,
				leasesDir: leasesDirPath,
				logFile: logFilePath,
				host: this.host,
				port: this.port,
			})
			const proc = spawnMonitor(args, this.mode === "background")
			if (this.mode === "background") {
				try {
					proc.unref()
				} catch {}
			}
			await this.onMonitorReady()
			const stdErrPromise =
				this.mode === "background"
					? makeFatalStderrPromise(proc, this.host, this.port)
					: new Promise<never>((_resolve, reject) => {})
			await Promise.race([stdErrPromise, this.onMonitorReady()])
		} finally {
			await releaseLock()
		}
	}

	private async writeMonitorState(
		finalState: PocketIcState,
		desired: NormalizedConfig,
	) {
		const patch = {
			binPath: pocketIcPath,
			version: pocketIcVersion,
			mode: finalState.mode ?? this.mode,
			bind: this.host,
			port: this.port,
			args: ["-i", this.host, "-p", String(this.port)],
			config: desired,
		}
		const stateFilePath = path.resolve(
			this.iceDirPath,
			"pocketic-server",
			"monitor.json",
		)
		const current =
			(await this.readMonitorState()) ??
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

		const merged = { schemaVersion: 1, ...current, ...patch }
		await writeFileAtomic(stateFilePath, JSON.stringify(merged, null, 2))
	}

	private async stateIsListening(state: PocketIcState | undefined) {
		if (!state) return false
		const bind = state.bind ?? this.host
		const port = state.port ?? this.port
		return portListening(bind, port)
	}

	/** Initialize or attach to the PocketIC monitor. Single return; deduped lease creation. */
	async start(): Promise<void> {
		const desiredConfig = await this.computeNormalizedConfig()
		const rootDir = path.resolve(this.iceDirPath, "pocketic-server")
		const leasesDirPath = path.join(rootDir, "leases")
        const stateFilePath = path.resolve(rootDir, "monitor.json")

		await ensureDir(rootDir)
		await ensureDir(leasesDirPath)

		// Adopt existing state or drop stale
		let state = await this.readMonitorState()
		if (state && !(await this.stateIsListening(state))) {
			await fs.unlink(stateFilePath).catch(() => {})
			state = undefined
		}

		// If managed state exists, decide reuse vs restart
		if (state) {
			const mismatch = !deepEqual(state.config ?? null, desiredConfig)
			const mustRestart = this.policy === "restart" && mismatch

			if (mustRestart) {
				// Guard: FG may not restart BG-managed server
				if (state.mode === "background" && this.mode === "foreground") {
					throw new ReplicaStartError({
						reason: "ProtectedServerError",
						message:
							"FG restart is not allowed while BG-managed server is present.",
					})
				}

				// Guard: restart blocked if any FG lease alive for this generation
				const startedAt =
					typeof state.startedAt === "number" ? state.startedAt : -1
				if ((await countAliveFgLeases(leasesDirPath, startedAt)) > 0) {
					// TODO: should happen, but doesnt for #10?
					throw new ReplicaStartError({
						reason: "PortInUseError",
						message:
							"Restart denied: foreground leases are active.",
					})
				}

				// Clean BG leases for this gen, release while respawning, then spawn fresh
				await removeBgLeasesFor(leasesDirPath, state.startedAt ?? -1)
				await waitUntil(
					async () => !(await this.readMonitorState()),
					200,
					50,
				)
				await this.spawn()
			} else {
				await this.onMonitorReady()
			}
		}

		// If no managed state, detect manual server or spawn a new one
		let finalState = await this.readMonitorState()
		if (!finalState) {
			const occupied = await portListening(this.host, this.port)

			if (occupied) {
				if (this.policy === "restart") {
					throw new ReplicaStartError({
						reason: "ManualPocketICPresentError",
						message:
							"Manual PocketIC present; cannot restart unmanaged server.",
					})
				}
				// Reuse manual server; mark lease for creation at end
				if (this.mode === "foreground") {
					await this.createLease({ mode: "foreground" })
				}
			} else {
				await this.spawn()
				finalState = await this.readMonitorState()
			}
		}

		// Refresh metadata if we have a managed state; schedule lease
		if (finalState) {
			await this.writeMonitorState(finalState, desiredConfig)
			await this.createLease({ mode: this.mode })
		}
	}

	public async onMonitorReady() {
		// waitForMonitorJson
		await waitUntil(async () => !!(await this.readMonitorState()), 200, 50)
		// waitForPort
		await waitUntil(
			async () => portListening(this.host, this.port),
			200,
			50,
		)
	}

	async shutdown(): Promise<void> {
        // But this cleans up all leases? problematic?
		await this.cleanLeases()
	}
	private async cleanLeases() {
		const leasesDirPath = path.join(
			this.iceDirPath,
			"pocketic-server",
			"leases",
		)
		const files = await fs.readdir(leasesDirPath).catch(() => [])
		for (const file of files) {
			await fs.unlink(path.join(leasesDirPath, file)).catch(() => {})
		}
	}
}
