#!/usr/bin/env node
import { spawn } from "node:child_process"
import * as fsp from "node:fs/promises"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const LEASE_CHECK_INTERVAL_MS = 100

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isAlive = (pid) => {
	if (!pid || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function writeFileAtomic(filePath, contents) {
	const tmp = `${filePath}.tmp`
	await fsp.mkdir(path.dirname(filePath), { recursive: true })
	const handle = await fsp.open(tmp, "w")
	try {
		await handle.writeFile(contents, "utf8")
		await handle.sync()
	} finally {
		await handle.close()
	}
	await fsp.rename(tmp, filePath)
	try {
		const dirHandle = await fsp.open(path.dirname(filePath), "r")
		try {
			await dirHandle.sync()
		} finally {
			await dirHandle.close()
		}
	} catch {
		// Some file systems do not allow fsync on directories; ignore.
	}
}

async function removeFile(filePath) {
	await fsp.unlink(filePath).catch(() => {})
}

async function readLeases(dir, ttlMs) {
	try {
		await fsp.mkdir(dir, { recursive: true })
		const entries = await fsp.readdir(dir)
		if (!entries || entries.length === 0) return 0
		const now = Date.now()
		let active = 0
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue
			const absolute = path.join(dir, entry)
			try {
				const raw = await fsp.readFile(absolute, "utf8")
				const data = JSON.parse(raw)
				const leaseTtl = typeof data.ttlMs === "number" ? data.ttlMs : ttlMs
				const alive = typeof data.pid === "number" ? isAlive(data.pid) : false
				const fresh =
					typeof data.heartbeatAt === "number"
						? now - data.heartbeatAt <= leaseTtl
						: false
				if (alive && fresh) {
					active++
				} else {
					await removeFile(absolute)
				}
			} catch {
				await removeFile(absolute)
			}
		}
		return active
	} catch {
		return 0
	}
}

const killOne = (pid, signal) => {
	try {
		process.kill(pid, signal)
	} catch {}
}

const gracefulStop = async (pid, totalTimeoutMs = 10_000) => {
	if (!pid || pid <= 0) return
	const start = Date.now()
	for (const signal of ["SIGINT", "SIGTERM"]) {
		killOne(pid, signal)
		while (Date.now() - start < totalTimeoutMs) {
			if (!isAlive(pid)) return
			await sleep(100)
		}
	}
	killOne(pid, "SIGKILL")
}

const extractNet = (argv) => {
	let bind
	let port
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "-i" && argv[i + 1]) bind = argv[i + 1]
		if (argv[i] === "-p" && argv[i + 1]) port = Number(argv[i + 1])
	}
	return { bind, port }
}

const parse = (argv) => {
	const result = {
		parent: undefined,
		bin: undefined,
		args: [],
		stateFile: undefined,
		background: false,
		logFile: undefined,
		leasesDir: undefined,
		leaseTtlMs: 5_000,
	}
	const sep = argv.indexOf("--")
	const head = sep === -1 ? argv : argv.slice(0, sep)
	const tail = sep === -1 ? [] : argv.slice(sep + 1)
	for (let i = 0; i < head.length; i++) {
		const token = head[i]
		if (token === "--parent") result.parent = Number(head[++i])
		else if (token === "--bin") result.bin = head[++i]
		else if (token === "--state-file") result.stateFile = head[++i]
		else if (token === "--background") result.background = true
		else if (token === "--log-file") result.logFile = head[++i]
		else if (token === "--leases-dir") result.leasesDir = head[++i]
		else if (token === "--lease-ttl") {
			const raw = Number(head[++i])
			if (!Number.isNaN(raw) && raw > 0) result.leaseTtlMs = raw
		}
	}
	result.args = tail
	return result
}

async function writeState(stateFile, payload) {
	if (!stateFile) return
	await writeFileAtomic(stateFile, JSON.stringify(payload, null, 2))
}

async function cleanupState(stateFile) {
	if (!stateFile) return
	const root = path.dirname(stateFile)
	await removeFile(stateFile)
	await removeFile(`${stateFile}.tmp`)
	await removeFile(path.join(root, ".pid"))
	await removeFile(path.join(root, ".server.pid"))
}

async function main() {
	const {
		parent,
		bin,
		args,
		stateFile,
		background,
		logFile,
		leasesDir,
		leaseTtlMs,
	} = parse(process.argv.slice(2))
	const keepAliveFile = stateFile
		? path.join(path.dirname(stateFile), ".keepalive")
		: undefined

	if (!parent || !bin) {
		console.error("[pocketic-monitor] missing required arguments")
		process.exit(2)
	}
	try {
		await fsp.access(bin)
	} catch {
		console.error("[pocketic-monitor] bin path not accessible:", bin)
		process.exit(2)
	}

	const spawnOpts = background
		? { detached: true, stdio: "ignore" }
		: { detached: true, stdio: ["ignore", "pipe", "pipe"] }

	const child = spawn(bin, args, spawnOpts)

	const { bind, port } = extractNet(args)

	const statePayload = {
		schemaVersion: 1,
		managed: true,
		mode: background ? "background" : "foreground",
		binPath: bin,
		version: null,
		pid: child.pid ?? null,
		monitorPid: process.pid,
		port: typeof port === "number" ? port : null,
		bind: bind ?? null,
		startedAt: Date.now(),
		args,
		config: null,
		configHash: null,
		instanceRoot: stateFile
			? path.dirname(stateFile)
			: undefined,
	}

	await writeState(stateFile, statePayload)

	if (logFile) {
		try {
			await fsp.mkdir(path.dirname(logFile), { recursive: true })
			const ws = fs.createWriteStream(logFile, { flags: "a" })
			child.stdout?.pipe(ws)
			child.stderr?.pipe(ws)
		} catch (error) {
			console.error("[pocketic-monitor] failed to pipe logs:", error)
		}
	}

	if (background) {
		try {
			child.unref()
		} catch {}
		process.exit(0)
	}

	const handleExitCleanup = async () => {
		await cleanupState(stateFile)
		process.exit(0)
	}

	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(signal, async () => {
			await gracefulStop(child.pid)
			await handleExitCleanup()
		})
	}

	child.on("exit", async (code, signal) => {
		await cleanupState(stateFile)
		const exitCode = signal ? 1 : code ?? 0
		process.exit(exitCode)
	})

	const leaseWatcher = async () => {
		if (!leasesDir) return
		let isBackground = false
		try {
			if (stateFile) {
				const raw = await fsp.readFile(stateFile, "utf8").catch(() => undefined)
				if (raw) {
					const j = JSON.parse(raw)
					isBackground = j?.mode === "background"
				}
			}
		} catch {}
		while (true) {
			await sleep(LEASE_CHECK_INTERVAL_MS)
			if (!isAlive(child.pid)) break
			const active = await readLeases(leasesDir, leaseTtlMs)
			if (!isBackground) {
				if (active === 0) {
					if (keepAliveFile && fs.existsSync(keepAliveFile)) {
						continue
					}
					await gracefulStop(child.pid)
					await cleanupState(stateFile)
					process.exit(0)
				}
			} else {
				// background: do not auto-stop on leases==0
				continue
			}
		}
	}

	const parentWatcher = async () => {
		while (true) {
			await sleep(500)
			if (!isAlive(parent)) {
				await gracefulStop(child.pid)
				await cleanupState(stateFile)
				process.exit(0)
			}
		}
	}

	leaseWatcher().catch((error) => {
		console.error("[pocketic-monitor] lease watcher error:", error)
	})
	parentWatcher().catch((error) => {
		console.error("[pocketic-monitor] parent watcher error:", error)
	})
}

main().catch((error) => {
	console.error("[pocketic-monitor] fatal:", error)
	process.exit(1)
})
