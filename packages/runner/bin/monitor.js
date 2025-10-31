#!/usr/bin/env node
import { spawn } from "node:child_process"
import * as fsp from "node:fs/promises"
import * as fs from "node:fs"
import * as path from "node:path"
import * as process from "node:process"

const LEASE_CHECK_INTERVAL_MS = 100
// Small grace so FG doesn't get torn down before the first lease appears.
const INITIAL_LEASE_GRACE_MS = 3000

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

async function readState(stateFile) {
	try {
        const raw = await fsp.readFile(stateFile, "utf8")
        return JSON.parse(raw)
    } catch {
        return undefined
    }
}

async function readActiveLeaseCount(leasesDir, stateFile) {
	try {
		await fsp.mkdir(leasesDir, { recursive: true })
		const entries = await fsp.readdir(leasesDir)
		if (!entries || entries.length === 0) return 0

		let active = 0
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue
			const leasePath = path.join(leasesDir, entry)
			try {
				const raw = await fsp.readFile(leasePath, "utf8")
				const leaseData = JSON.parse(raw)
				// Lease is considered active if:
				//  - it has no pid field (we err on the side of keeping it), OR
				//  - its pid is still alive.
				if (leaseData.mode === "foreground") {
					const ownerPid =
						typeof leaseData.pid === "number"
							? leaseData.pid
							: undefined
					if (ownerPid == null || isAlive(ownerPid)) {
						active++
					} else {
						// owner is dead -> reap stale lease
						await removeFile(leasePath)
					}
				}
                if (leaseData.mode === "background") {
                    const state = await readState(stateFile)
                    if (leaseData.startedAt !== state.startedAt) {
                        await removeFile(leasePath)
                    } else {
                        active++
                    }
                }
			} catch {
				// unreadable/corrupt -> reap
				await removeFile(leasePath)
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
		bin: undefined,
		args: [],
		stateFile: undefined,
		background: false,
		logFile: undefined,
		leasesDir: undefined,
	}
	const sep = argv.indexOf("--")
	const head = sep === -1 ? argv : argv.slice(0, sep)
	const tail = sep === -1 ? [] : argv.slice(sep + 1)
	for (let i = 0; i < head.length; i++) {
		const token = head[i]
		if (token === "--bin") result.bin = head[++i]
		else if (token === "--state-file") result.stateFile = head[++i]
		else if (token === "--background") result.background = true
		else if (token === "--log-file") result.logFile = head[++i]
		else if (token === "--leases-dir") result.leasesDir = head[++i]
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
	const { bin, args, stateFile, background, logFile, leasesDir } = parse(
		process.argv.slice(2),
	)

	if (!bin) {
		console.error("[pocketic-monitor] missing required arguments")
		process.exit(2)
	}
	try {
		await fsp.access(bin)
	} catch {
		console.error("[pocketic-monitor] bin path not accessible:", bin)
		process.exit(2)
	}

	// Keep the monitor alive in both FG and BG
	const child = spawn(bin, args, {
		detached: true,
		stdio:
			// background ? "ignore" :
			[/* stdin */ "ignore", /* stdout */ "inherit", /* stderr */ "pipe"],
		env: {
			...process.env,
			RUST_BACKTRACE: "full",
		},
	})
	try {
		child.unref()
	} catch {}

	const { bind, port } = extractNet(args)

	const startedAt = Date.now()
	const statePayload = {
		schemaVersion: 1,
		managed: true,
		mode: background ? "background" : "foreground",
		binPath: bin,
		version: null,
		pid: child.pid ?? null, // server pid
		monitorPid: process.pid, // this process
		port: typeof port === "number" ? port : null,
		bind: bind ?? null,
		startedAt,
		args,
		config: null,
		configHash: null,
		instanceRoot: stateFile ? path.dirname(stateFile) : undefined,
	}

	await writeState(stateFile, statePayload)

	if (logFile && child.stdout && child.stderr) {
		try {
			await fsp.mkdir(path.dirname(logFile), { recursive: true })
			const ws = fs.createWriteStream(logFile, { flags: "a" })
			// child.stdout.pipe(ws)
			child.stderr.pipe(ws)
		} catch (error) {
			console.error("[pocketic-monitor] failed to pipe logs:", error)
		}
	}

	// TODO: this causes issue
	// for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	// 	process.on(signal, async () => {
	// 		console.log("signal received, starting graceful stop")
	// 		await gracefulStop(child.pid)
	// 		await cleanupState(stateFile)
	// 		process.exit(0)
	// 	})
	// }

	child.on("exit", async (code, signal) => {
		await cleanupState(stateFile)
		const exitCode = signal ? 1 : (code ?? 0)
		process.exit(exitCode)
	})

	// Lease watcher: no TTL. Reap only leases whose owner pid is dead.
	const leaseWatcher = async () => {
		if (!leasesDir) {
			return
		}
		const graceUntil = startedAt + INITIAL_LEASE_GRACE_MS
		let sawAnyLease = false

		while (true) {
			await sleep(LEASE_CHECK_INTERVAL_MS)
			if (!isAlive(child.pid)) break

			const active = await readActiveLeaseCount(leasesDir, stateFile)
			if (active > 0) sawAnyLease = true

			// Stop strictly when there are 0 active leases, but don’t tear down during the initial grace window.
			if (active === 0 && (sawAnyLease || Date.now() > graceUntil)) {
				await gracefulStop(child.pid)
				await cleanupState(stateFile)
				process.exit(0)
			}
		}
	}

	leaseWatcher().catch((error) => {
		console.error("[pocketic-monitor] lease watcher error:", error)
	})
}

main().catch((error) => {
	console.error("[pocketic-monitor] fatal:", error)
	process.exit(1)
})
