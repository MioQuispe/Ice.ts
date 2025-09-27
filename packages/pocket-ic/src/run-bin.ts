#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import cp from "node:child_process"
import { pocketIcPath } from "./index.js"

function ensureExecutable(p: string) {
	try {
		const st = fs.statSync(p)
		// if not executable for user, fix it
		if ((st.mode & 0o100) === 0) {
			fs.chmodSync(p, st.mode | 0o755)
		}
	} catch {
		// ignore; will fail at spawn if missing
	}
}

function maybeClearQuarantine(p: string) {
	if (os.platform() !== "darwin") return
	try {
		// best-effort; most npm installs aren't quarantined anyway
		cp.spawnSync("xattr", ["-dr", "com.apple.quarantine", p], {
			stdio: "ignore",
		})
	} catch {
		// ignore
	}
}

function main() {
	ensureExecutable(pocketIcPath)
	maybeClearQuarantine(pocketIcPath)

	const args = process.argv.slice(2)
	const child = cp.spawn(pocketIcPath, args, {
		stdio: "inherit",
	})

	child.on("exit", (code, signal) => {
		if (signal) {
			// pass through signal-like exit
			process.kill(process.pid, signal as any)
		} else {
			process.exit(code ?? 0)
		}
	})
}

main()
