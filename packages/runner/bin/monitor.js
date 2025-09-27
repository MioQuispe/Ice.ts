#!/usr/bin/env node
import { spawn } from "node:child_process"
import fs from "node:fs"
import process from "node:process"
import path from "node:path" // ← ESM import (fixes require error)

/**
 * Usage:
 *   node monitor.js [--background] [--state-file <PATH>] --parent <PPID> --bin <ABS_BIN_PATH> -- [args...]
 *
 * Foreground (default):
 *  - spawns <BIN> *detached* (new PGID)
 *  - forwards SIGINT/SIGTERM/SIGHUP to the group
 *  - watches parent; on parent death (even SIGKILL) -> kills group
 *  - exits with child's exit code
 *
 * Background:
 *  - spawns <BIN> *detached* (new PGID)
 *  - DOES NOT forward signals, DOES NOT watch parent
 *  - writes JSON state file { pid, startedAt, binPath, args } if provided
 *  - exits immediately (leaving the server running)
 */

function isAlive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function killGroup(pid, sig = "SIGTERM") {
	try {
		process.kill(-pid, sig)
	} catch {}
}
async function gracefulKillGroup(pid, timeout = 2500) {
	killGroup(pid, "SIGTERM")
	const t0 = Date.now()
	for (;;) {
		try {
			process.kill(pid, 0)
		} catch {
			return
		}
		if (Date.now() - t0 > timeout) break
		await sleep(50)
	}
	killGroup(pid, "SIGKILL")
}

function parse(argv) {
	const out = {
		parent: undefined,
		bin: undefined,
		args: [],
		stateFile: undefined,
		background: false,
	}
	const sep = argv.indexOf("--")
	const head = sep === -1 ? argv : argv.slice(0, sep)
	const tail = sep === -1 ? [] : argv.slice(sep + 1)
	for (let i = 0; i < head.length; i++) {
		const k = head[i]
		if (k === "--parent") out.parent = Number(head[++i])
		else if (k === "--bin") out.bin = head[++i]
		else if (k === "--state-file") out.stateFile = head[++i]
		else if (k === "--background") out.background = true
	}
	out.args = tail
	return out
}

async function main() {
	const { parent, background, bin, args, stateFile } = parse(
		process.argv.slice(2),
	)
	if (!parent || !bin || !fs.existsSync(bin)) {
		console.error("[pocketic-monitor] bad args or missing bin")
		process.exit(2)
	}

	// Use isolated stdio in background so the child isn't tied to the monitor's fds
	const spawnOpts = background
		? { detached: true, stdio: "ignore" }
		: { detached: true, stdio: ["ignore", "inherit", "inherit"] }

	const child = spawn(bin, args, spawnOpts)

	// Write state file ASAP (no require; ESM-safe)
	if (stateFile) {
		try {
			fs.mkdirSync(path.dirname(stateFile), { recursive: true })
			fs.writeFileSync(
				stateFile,
				JSON.stringify(
					{
						pid: child.pid,
						startedAt: Date.now(),
						binPath: bin,
						args,
					},
					null,
					2,
				),
			)
		} catch (e) {
			console.error("[pocketic-monitor] failed to write state file:", e)
			// not fatal in foreground; background will still proceed
		}
	}

	if (background) {
		// Fully detach and exit now; leave server running
		try {
			child.unref()
		} catch {}
		process.exit(0)
	}

	// Foreground behavior only below
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(sig, () => killGroup(child.pid, sig))
	}

	child.on("exit", (code, signal) => {
		process.exit(signal ? 1 : (code ?? 0))
	})

	// Parent-death watcher (foreground only)
	;(async () => {
		while (true) {
			if (!isAlive(parent)) {
				await gracefulKillGroup(child.pid)
				process.exit(0)
			}
			await sleep(500)
		}
	})()
}

main().catch((e) => {
	console.error("[pocketic-monitor] fatal:", e)
	process.exit(1)
})
