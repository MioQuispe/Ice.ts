import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as url from "node:url"
import net from "node:net"
import find from "find-process"
import { sha256 } from "js-sha256"
import { pocketIcPath, pocketIcVersion } from "@ice.ts/pocket-ic"

import { ReplicaError } from "../replica.js"
import type { ICEConfigContext } from "../../types/types.js"

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

const LEASE_TTL_MS = 5_000
const LOCK_STALE_MS = 30_000

const createDefaultTopology = () =>
	({
		nns: { state: { type: "New" as const } },
		ii: { state: { type: "New" as const } },
		fiduciary: { state: { type: "New" as const } },
		bitcoin: { state: { type: "New" as const } },
		sns: { state: { type: "New" as const } },
		application: [{ state: { type: "New" as const } }],
	}) as const

type LeaseFile = {
	pid: number
	createdAt: number
	heartbeatAt: number
	ttlMs: number
}

type NormalizedConfig = {
	pocketIcCli: {
		bind: string
		port: number
		ttl: number
	}
	instance: {
		stateDir: string
		initialTime: {
			AutoProgress: {
				artificialDelayMs: number
			}
		}
		topology: ReturnType<typeof createDefaultTopology>
		incompleteState: boolean
		nonmainnet: boolean
		verifiedApplication: number
	}
	signatureVariant: "baseline" | "variant-b"
}

export type PocketIcState = {
	schemaVersion?: number
	managed: boolean
	mode?: "foreground" | "background" | null
	binPath?: string | null
	version?: string | null
	pid: number | null
	monitorPid?: number | null
	port?: number | null
	bind?: string | null
	startedAt?: number | null
	args?: ReadonlyArray<string> | null
	config?: NormalizedConfig | null
	configHash?: string | null
	instanceRoot?: string
}

type Paths = {
	root: string
	stateFile: string
	stateTmp: string
	locksDir: string
	adminLock: string
	leasesDir: string
	monitorPidFile: string
	serverPidFile: string
	instanceRoot: string
	keepAliveFile: string
}

type LeaseRecord = {
	path: string
	entry: LeaseFile
	active: boolean
}

export type Monitor = {
	pid: number
	host: string
	port: number
	reused: boolean
	shutdown: () => void
	waitForExit: () => Promise<void>
	fatalStderr?: Promise<never>
}

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
		stateTmp: path.join(root, "state.json.tmp"),
		locksDir: path.join(root, "locks"),
		adminLock: path.join(root, "locks", "admin.lock"),
		leasesDir: path.join(root, "leases"),
	monitorPidFile: path.join(root, ".pid"),
	serverPidFile: path.join(root, ".server.pid"),
	instanceRoot: root,
	keepAliveFile: path.join(root, ".keepalive"),
	}
}

const ensureDir = async (p: string) => {
	await fs.mkdir(p, { recursive: true }).catch(() => {})
}

const writeFileAtomic = async (target: string, contents: string) => {
	const tmp = `${target}.tmp`
	await ensureDir(path.dirname(target))
	const handle = await fs.open(tmp, "w")
	try {
		await handle.writeFile(contents, "utf8")
		await handle.sync()
	} finally {
		await handle.close()
	}
	await fs.rename(tmp, target)
	try {
		const dirHandle = await fs.open(path.dirname(target), "r")
		try {
			await dirHandle.sync()
		} finally {
			await dirHandle.close()
		}
	} catch {
		// best effort; some FS do not allow syncing dirs
	}
}

const readJsonFile = async <T>(p: string): Promise<T | undefined> => {
	try {
		const txt = await fs.readFile(p, "utf8")
		return JSON.parse(txt) as T
	} catch {
		return undefined
	}
}

const writeStateFile = async (paths: Paths, state: PocketIcState) => {
	const payload = {
		schemaVersion: 1,
		...state,
		instanceRoot: paths.instanceRoot,
	}
	await writeFileAtomic(paths.stateFile, JSON.stringify(payload, null, 2))
}

const removeFile = async (p: string) => {
	await fs.unlink(p).catch(() => {})
}

const cleanupStateArtifacts = async (paths: Paths) => {
	await removeFile(paths.stateFile)
	await removeFile(paths.stateTmp)
	await removeFile(paths.monitorPidFile)
	await removeFile(paths.serverPidFile)
	await removeFile(paths.keepAliveFile)
}

const setKeepAlive = async (paths: Paths, enable: boolean) => {
	if (enable) {
		await writeFileAtomic(paths.keepAliveFile, JSON.stringify({ keepAlive: true }))
	} else {
		await removeFile(paths.keepAliveFile)
	}
}

const acquireAdminLock = async (
	lockPath: string,
	staleMs: number,
): Promise<() => Promise<void>> => {
	await ensureDir(path.dirname(lockPath))
	while (true) {
		try {
			const handle = await fs.open(lockPath, "wx")
			try {
				await handle.writeFile(
					JSON.stringify(
						{ pid: process.pid, acquiredAt: Date.now() },
						null,
						2,
					),
					"utf8",
				)
				await handle.sync()
			} finally {
				await handle.close()
			}
			return async () => {
				await removeFile(lockPath)
			}
		} catch (error: unknown) {
			const err = error as NodeJS.ErrnoException
			if (err.code !== "EEXIST") throw error

			let stale = false
			try {
				const stat = await fs.stat(lockPath)
				const age = Date.now() - stat.mtimeMs
				const payload = await readJsonFile<{ pid?: number }>(lockPath)
				const holderAlive =
					payload?.pid && typeof payload.pid === "number"
						? isPidAlive(payload.pid)
						: false
				if (!holderAlive && age > staleMs) {
					stale = true
				}
			} catch {
				stale = true
			}
			if (stale) {
				await removeFile(lockPath)
				continue
			}
			await sleep(125)
		}
	}
}

export const readLeases = async (dir: string): Promise<LeaseRecord[]> => {
	await ensureDir(dir)
	const files = await fs.readdir(dir).catch(() => [])
	const now = Date.now()
	const out: LeaseRecord[] = []
	for (const file of files) {
		if (!file.endsWith(".json")) continue
		const absolute = path.join(dir, file)
		try {
			const parsed = await readJsonFile<LeaseFile>(absolute)
			if (!parsed) continue
			const ttl = parsed.ttlMs ?? LEASE_TTL_MS
			const alive = isPidAlive(parsed.pid)
			const fresh = now - parsed.heartbeatAt <= ttl
			const active = alive && fresh
			out.push({ path: absolute, entry: parsed, active })
			if (!active) {
				await removeFile(absolute)
			}
		} catch {
			await removeFile(absolute)
		}
	}
	return out.filter((r) => r.active)
}

export async function createLeaseFile(opts: {
	iceDirPath: string
	leaseId: string
	ttlMs: number
}): Promise<string> {
	const { iceDirPath, leaseId, ttlMs } = opts
	const dir = path.join(iceDirPath, "pocketic-server", "leases")
	await ensureDir(dir)
	const leasePath = path.join(dir, `${leaseId}.json`)
	const now = Date.now()
	const payload: LeaseFile = {
		pid: process.pid,
		createdAt: now,
		heartbeatAt: now,
		ttlMs,
	}
	await writeFileAtomic(leasePath, JSON.stringify(payload, null, 2))
	return leasePath
}

export async function heartbeatLeaseFile(
	leasePath: string,
	ttlMs?: number,
): Promise<void> {
	try {
		const txt = await fs.readFile(leasePath, "utf8")
		const payload = JSON.parse(txt) as LeaseFile
		payload.heartbeatAt = Date.now()
		if (typeof ttlMs === "number") {
			payload.ttlMs = ttlMs
		}
		await writeFileAtomic(leasePath, JSON.stringify(payload, null, 2))
	} catch {
		// best-effort: if the lease disappeared, nothing to do
	}
}

export const removeLeaseFile = async (leasePath: string) => {
	await removeFile(leasePath)
}

const stableSortKeys = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map((v) => stableSortKeys(v))
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
		)
		const acc: Record<string, unknown> = {}
		for (const [k, v] of entries) {
			acc[k] = stableSortKeys(v)
		}
		return acc
	}
	return value
}

const detectIncompleteState = async (stateDir: string): Promise<boolean> => {
	try {
		const entries = await fs.readdir(stateDir, { withFileTypes: true })
		return !entries.some((entry) => entry.isDirectory())
	} catch {
		// If the directory is missing, treat as incomplete so we stay conservative.
		return true
	}
}

const computeNormalizedConfig = async (
	ctx: ICEConfigContext,
	opts: { host: string; port: number; ttlSeconds?: number },
	variant: "baseline" | "variant-b",
): Promise<NormalizedConfig> => {
	const stateDir = path.resolve(ctx.iceDirPath, "replica-state")
	const incompleteState = await detectIncompleteState(stateDir)
	return {
		pocketIcCli: {
			bind: opts.host,
			port: opts.port,
			ttl: opts.ttlSeconds ?? 9_999_999_999,
		},
		instance: {
			stateDir,
			initialTime: {
				AutoProgress: {
					artificialDelayMs: 0,
				},
			},
			topology: createDefaultTopology(),
			incompleteState,
			nonmainnet: ctx.network !== "ic",
			verifiedApplication: 0,
		},
		signatureVariant: variant,
	}
}

const computeConfigHash = (config: NormalizedConfig): string => {
	const stable = stableSortKeys(config)
	return sha256(JSON.stringify(stable))
}

const pidByPortIfPocketIc = async (
	port: number,
): Promise<number | undefined> => {
	try {
		const list = await find("port", port)
		const match = list.find((p) => {
			const cmd = (p as any).cmd as string | undefined
			return !!cmd && cmd.includes(pocketIcPath)
		})
		return match ? ((match as any).pid as number) : undefined
	} catch {
		return undefined
	}
}

const waitTcpReady = (
	host: string,
	port: number,
	perTryMs = 800,
): Promise<void> => {
	return new Promise<void>((resolve, reject) => {
		const socket = net.connect({ host, port })
		const to = setTimeout(() => socket.destroy(new Error("timeout")), perTryMs)

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
}

const gracefulStopPid = async (pid: number, timeoutMs: number) => {
	const start = Date.now()
	for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
		try {
			process.kill(pid, signal)
		} catch {
			return
		}
		while (Date.now() - start < timeoutMs) {
			if (!isPidAlive(pid)) return
			await sleep(100)
		}
	}
}

const stopManagedServer = async (state: PocketIcState, paths: Paths) => {
	const monitorPid = state.monitorPid ?? null
	const serverPid = state.pid ?? null
	await setKeepAlive(paths, false)

	if (monitorPid && isPidAlive(monitorPid)) {
		try {
			process.kill(monitorPid, "SIGTERM")
		} catch {}
		const started = Date.now()
		while (Date.now() - started < 10_000) {
			if (!isPidAlive(monitorPid)) break
			await sleep(100)
		}
	}
	if (serverPid && isPidAlive(serverPid)) {
		await gracefulStopPid(serverPid, 10_000)
	}
	await cleanupStateArtifacts(paths)
}

const buildMonitorArgs = (opts: {
	background: boolean
	parentPid: number
	stateFile: string
	leasesDir: string
	leaseTtlMs: number
	logFile?: string
	ip: string
	port: number
	ttl: string
}) => {
	const args: string[] = [
		path.resolve(__dirname, "../../../bin/monitor.js"),
	]
	if (opts.background) args.push("--background")
	args.push("--parent", String(opts.parentPid))
	args.push("--state-file", opts.stateFile)
	args.push("--leases-dir", opts.leasesDir)
	args.push("--lease-ttl", String(opts.leaseTtlMs))
	args.push("--bin", pocketIcPath)
	if (opts.logFile) {
		args.push("--log-file", path.resolve(opts.logFile))
	}
	args.push("--", "-i", opts.ip, "-p", String(opts.port), "--ttl", opts.ttl)
	return args
}

const spawnMonitor = (args: string[], background: boolean): ChildProcess => {
	return spawn(process.execPath, args, {
		detached: true,
		stdio: background ? "ignore" : ["ignore", "inherit", "pipe"],
		env: {
			...process.env,
			RUST_BACKTRACE: "full",
		},
	})
}

const makeFatalStderrPromise = (
	proc: ChildProcess,
	ip: string,
	port: number,
): Promise<never> => {
	if (!proc.stderr) {
		return new Promise<never>(() => {})
	}
    return new Promise<never>((_resolve, reject) => {
        let sawFatalError = false
        const onData = (chunk: Buffer | string) => {
            const text =
                typeof chunk === "string" ? chunk : chunk.toString("utf8")
            for (const line of text.split("\n")) {
                if (!line) continue
                if (/Failed to bind PocketIC server to address/i.test(line)) {
                    sawFatalError = true
                    reject(
                        new ReplicaError({
                            message: `PocketIC failed to bind to ${ip}:${port}. Port likely in use.`,
                        }),
                    )
                }
                if (/thread 'main' panicked/i.test(line)) {
                    sawFatalError = true
                    reject(
                        new ReplicaError({
                            message: `PocketIC panicked during startup: ${line}`,
                        }),
                    )
                }
            }
        }
        proc.stderr?.on("data", onData)
        proc.on("exit", () => {
            if (!sawFatalError) return
            reject(
                new ReplicaError({
                    message:
                        "PocketIC monitor exited unexpectedly during startup",
                }),
            )
        })
    })
}

const updatePidFiles = async (paths: Paths, state: PocketIcState) => {
	if (state.monitorPid) {
		await writeFileAtomic(
			paths.monitorPidFile,
			String(state.monitorPid ?? ""),
		)
	} else {
		await removeFile(paths.monitorPidFile)
	}
	if (state.pid) {
		await writeFileAtomic(paths.serverPidFile, String(state.pid ?? ""))
	} else {
		await removeFile(paths.serverPidFile)
	}
}

const loadExistingState = async (
	paths: Paths,
): Promise<PocketIcState | undefined> => {
	const state = await readJsonFile<PocketIcState>(paths.stateFile)
	return state ?? undefined
}

const normalizeManagedState = (
	raw: PocketIcState | undefined,
): PocketIcState | undefined => {
	if (!raw) return undefined
	const normalized: PocketIcState = {
		schemaVersion: raw.schemaVersion ?? 1,
		managed: raw.managed ?? true,
		mode: raw.mode ?? null,
		binPath: raw.binPath ?? pocketIcPath,
		version: raw.version ?? pocketIcVersion,
		pid: typeof raw.pid === "number" ? raw.pid : null,
		monitorPid:
			typeof raw.monitorPid === "number" ? raw.monitorPid : null,
		port: raw.port ?? null,
		bind: raw.bind ?? null,
		startedAt: raw.startedAt ?? Date.now(),
		args: raw.args ?? null,
		config: raw.config ?? null,
		configHash: raw.configHash ?? null,
	}
	if (raw.instanceRoot !== undefined) {
		normalized.instanceRoot = raw.instanceRoot
	}
	return normalized
}

const adoptManual = async (
	paths: Paths,
	bind: string,
	port: number,
	pid: number,
	config: NormalizedConfig,
	configHash: string,
) => {
	const state: PocketIcState = {
		managed: false,
		mode: null,
		binPath: null,
		version: null,
		pid,
		monitorPid: null,
		port,
		bind,
		startedAt: Date.now(),
		args: ["-i", bind, "-p", String(port), "--ttl", String(config.pocketIcCli.ttl)],
		config,
		configHash,
		instanceRoot: paths.instanceRoot,
	}
	await writeStateFile(paths, state)
	await updatePidFiles(paths, state)
}

const readStateAndVerify = async (
	paths: Paths,
	bind: string,
	port: number,
	config: NormalizedConfig,
	configHash: string,
): Promise<PocketIcState | undefined> => {
	const existing = normalizeManagedState(await loadExistingState(paths))
	if (existing) {
		if (existing.managed) {
			if (existing.pid && isPidAlive(existing.pid)) {
				return existing
			}
			await cleanupStateArtifacts(paths)
			return undefined
		}

		// Manual server recorded in state.json
		if (existing.pid && isPidAlive(existing.pid)) {
			const updated: PocketIcState = {
				...existing,
				config,
				configHash,
				args:
					existing.args ??
					["-i", bind, "-p", String(port), "--ttl", String(config.pocketIcCli.ttl)],
			}
			await writeStateFile(paths, updated)
			await updatePidFiles(paths, updated)
			return updated
		}
		await cleanupStateArtifacts(paths)
		return undefined
	}

	// No state file: attempt manual adoption.
	const manualPid = await pidByPortIfPocketIc(port)
	if (manualPid && isPidAlive(manualPid)) {
		await adoptManual(paths, bind, port, manualPid, config, configHash)
		return normalizeManagedState(await loadExistingState(paths))
	}

	return undefined
}

const subtractCurrentLease = (active: LeaseRecord[]): number => {
	if (active.length === 0) return 0
	return Math.max(0, active.length - 1)
}

const defaultMismatchStrategy = (): "restart" | "reuse" => {
	const env = process.env["ICE_POCKETIC_ARGS_MISMATCH"]
	if (env && env.toLowerCase() === "reuse") return "reuse"
	if (env && env.toLowerCase() === "restart") return "restart"
	return "reuse"
}

export async function makeMonitor(
	ctx: ICEConfigContext,
	opts: {
		host: string
		port: number
		ttlSeconds?: number
		forceArgsMismatch?: boolean
		argsMismatchSelection?: "restart" | "reuse"
	},
): Promise<Monitor> {
	const mode = ctx.background ? "background" : "foreground"
	const ip = opts.host
	const port = opts.port
	const ttl = String(opts.ttlSeconds ?? 9_999_999_999)
	const logFilePath = path.join(ctx.iceDirPath, "pocket-ic.log")
	const paths = resolvePaths(ctx.iceDirPath)
	const signatureVariant = opts.forceArgsMismatch ? "variant-b" : "baseline"
	const normalizedConfig = await computeNormalizedConfig(ctx, opts, signatureVariant)
	const configHash = computeConfigHash(normalizedConfig)
	const mismatchStrategy =
		opts.argsMismatchSelection ?? defaultMismatchStrategy()

	await ensureDir(paths.root)
	await ensureDir(paths.leasesDir)
	await ensureDir(paths.locksDir)

	const releaseLock = await acquireAdminLock(paths.adminLock, LOCK_STALE_MS)

	let activeLeases: LeaseRecord[] = []
	let state: PocketIcState | undefined
	let reused = false
	let monitorProc: ChildProcess | undefined
	let fatalStderr: Promise<never> | undefined
	let managedMismatchDetected = false
	let restarted = false

	try {
		activeLeases = await readLeases(paths.leasesDir)
		state = await readStateAndVerify(paths, ip, port, normalizedConfig, configHash)

		if (state?.managed) {
			const mismatch =
				opts.forceArgsMismatch ||
				(!!state.configHash && state.configHash !== configHash)
			if (mismatch) {
				managedMismatchDetected = true
				const otherActive = subtractCurrentLease(activeLeases)
				if (mismatchStrategy === "restart" && otherActive > 0) {
					throw new ReplicaError({
						message:
							"PocketIC restart rejected: server currently in use",
					})
				}
				if (mismatchStrategy === "restart" && otherActive === 0) {
					await stopManagedServer(state, paths)
					state = undefined
					restarted = true
				} else {
					reused = true
				}
			} else {
				reused = true
				// Ensure the reused managed server is actually reachable before proceeding
				await retry(
					async () => waitTcpReady(ip, port),
					60,
					100,
					true,
				)
			}
		}

		if (!state) {
			const manualPid = await pidByPortIfPocketIc(port)
			if (manualPid && isPidAlive(manualPid)) {
				await adoptManual(paths, ip, port, manualPid, normalizedConfig, configHash)
				state = await readStateAndVerify(paths, ip, port, normalizedConfig, configHash)
			}
		}

		if (!state) {
			const args = buildMonitorArgs({
				background: mode === "background",
				parentPid: process.pid,
				stateFile: paths.stateFile,
				leasesDir: paths.leasesDir,
				leaseTtlMs: LEASE_TTL_MS,
				logFile: logFilePath,
				ip,
				port,
				ttl,
			})
			monitorProc = spawnMonitor(args, mode === "background")
			if (mode === "background") {
				try {
					monitorProc.unref()
				} catch {}
			}

			if (mode === "background") {
				const backgroundState = await retry(
					async () => {
						const st = normalizeManagedState(
							await loadExistingState(paths),
						)
						if (!st?.pid || !isPidAlive(st.pid)) {
							throw new ReplicaError({
								message:
									"PocketIC background state not ready yet",
							})
						}
						return st
					},
					50,
					80,
					true,
				)
				await retry(
					async () => {
						const owner = await pidByPortIfPocketIc(port)
						if (owner !== backgroundState.pid) {
							throw new ReplicaError({
								message: `PocketIC did not bind ${ip}:${port} yet`,
							})
						}
					},
					25,
					120,
				)
				await retry(
					async () => waitTcpReady(ip, port),
					60,
					100,
					true,
				)
				const managedState: PocketIcState = {
					...backgroundState,
					managed: true,
					mode,
					binPath: pocketIcPath,
					version: pocketIcVersion,
					pid: backgroundState.pid ?? null,
					monitorPid: null,
					port,
					bind: ip,
					startedAt: backgroundState.startedAt ?? Date.now(),
					args:
						backgroundState.args ?? [
							"-i",
							ip,
							"-p",
							String(port),
							"--ttl",
							ttl,
						],
					config: normalizedConfig,
					configHash,
					instanceRoot: paths.instanceRoot,
				}
			await writeStateFile(paths, managedState)
			await updatePidFiles(paths, managedState)
			state = managedState
			restarted = true
		} else {
				fatalStderr = makeFatalStderrPromise(monitorProc, ip, port)
				await Promise.race([
					fatalStderr,
					retry(
						async () => waitTcpReady(ip, port),
						60,
						120,
						true,
					),
				])
				const observed = await retry(
					async () => {
						const snapshot = normalizeManagedState(
							await loadExistingState(paths),
						)
						if (!snapshot?.pid || !isPidAlive(snapshot.pid)) {
							throw new ReplicaError({
								message:
									"PocketIC foreground state not ready yet",
							})
						}
						return snapshot
					},
					50,
					80,
					true,
				)
				const fgState: PocketIcState = {
					...observed,
					managed: true,
					mode,
					binPath: pocketIcPath,
					version: pocketIcVersion,
					pid: observed.pid,
					monitorPid: monitorProc.pid ?? observed.monitorPid ?? null,
					port,
					bind: ip,
					startedAt: observed.startedAt ?? Date.now(),
					args:
						observed.args ?? [
							"-i",
							ip,
							"-p",
							String(port),
							"--ttl",
							ttl,
						],
					config: normalizedConfig,
					configHash,
					instanceRoot: paths.instanceRoot,
				}
			await writeStateFile(paths, fgState)
			await updatePidFiles(paths, fgState)
			state = fgState
			restarted = true
		}
		reused = false
		} else if (!state.managed) {
		const manualMismatch =
			opts.forceArgsMismatch ||
			(state.configHash !== undefined &&
				state.configHash !== null &&
				state.configHash !== configHash)
		if (manualMismatch && mismatchStrategy === "restart") {
			throw new ReplicaError({
				message:
					"Cannot restart manually managed PocketIC server",
			})
		}
			if (!manualMismatch || mismatchStrategy !== "reuse") {
			const updatedManual: PocketIcState = {
				...state,
				config: normalizedConfig,
				configHash,
				args:
					state.args ??
					["-i", ip, "-p", String(port), "--ttl", ttl],
			}
			await writeStateFile(paths, updatedManual)
			await updatePidFiles(paths, updatedManual)
			state = updatedManual
		}
			reused = true
			// For manual, verify reachability before returning
			await retry(async () => waitTcpReady(ip, port), 60, 100, true)
	} else {
		if (!restarted && !managedMismatchDetected) {
			const updated: PocketIcState = {
				...state,
				mode: state.mode ?? mode,
				config: normalizedConfig,
				configHash,
			}
			await writeStateFile(paths, updated)
			await updatePidFiles(paths, updated)
			state = updated
		}
	}
	} finally {
		if (state?.managed) {
			const needsKeepAlive =
				(state.mode === "background") ||
				(state.mode === "foreground" && mode === "background")
			await setKeepAlive(paths, needsKeepAlive)
		} else {
			await setKeepAlive(paths, false)
		}
		await releaseLock()
	}

	const serverPid = state?.managed
		? state.pid ?? monitorProc?.pid ?? -1
		: state?.pid ?? -1

	const shutdown =
		mode === "background" || reused
			? () => {}
			: () => {
					try {
						if (monitorProc?.pid) {
							process.kill(monitorProc.pid, "SIGTERM")
						}
					} catch {}
				}

	const waitForExit =
		mode === "background" || reused
			? async () => {}
			: async () =>
					await new Promise<void>((resolve) => {
						monitorProc?.on("exit", () => resolve())
					})

	return {
		pid: serverPid ?? -1,
		host: `http://${ip}`,
		port,
		reused,
		shutdown,
		waitForExit,
		...(fatalStderr ? { fatalStderr } : {}),
	}
}

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
		} catch (error) {
			lastErr = error
			const waitFor =
				exponential && i > 0 ? delayMs * 2 ** i : delayMs
			await sleep(waitFor)
		}
	}
	throw lastErr
}
