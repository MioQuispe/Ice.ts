import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import net from "node:net"
import { spawn, type ChildProcess } from "node:child_process"
import { describe, it, expect } from "vitest"

import { makeMonitor, type Monitor } from "../../src/services/pic/pic-process.js"
import type { ICEConfigContext } from "../../src/types/types.js"
import { pocketIcPath } from "@ice.ts/pocket-ic"

type ModeRun = "foreground" | "background"
type ExistingServer = "none" | "managed" | "manual"
type ExistingMode = "foreground" | "background" | "—"
type Concurrency = "single" | "parallel"
type ParallelRole = "first" | "second" | "—"
type ExpectedAction =
	| "spawn"
	| "reuse"
	| "restart"
	| "reject-in-use"
	| "adopt-manual"
	| "reject-cannot-restart-manual"
type ExpectedModeAfter = "foreground" | "background" | "—" | "n/a"
type ExpectedPidChange = "same" | "different" | "n/a"

type Scenario = {
	modeRun: ModeRun
	existingServer: ExistingServer
	existingMode: ExistingMode
	activeLeasesBefore: "0" | "1" | ">0"
	argsMismatch: boolean
	argsMismatchSelection: "reuse" | "restart"
	concurrency: Concurrency
	parallelRole: ParallelRole
	expectedAction: ExpectedAction
	expectedManagedAfter: boolean | undefined
	expectedModeAfter: ExpectedModeAfter
	expectedPidChange: ExpectedPidChange
	expectedLeasesAfter: "1" | "2" | ">0" | "n/a"
	expectServerRunningDuring: boolean
	expectStateJsonPresentDuring: boolean
	expectServerRunningAfterExit: boolean
	expectStateJsonPresentAfterExit: boolean
	expectedError: "in-use" | "cannot-restart-manual" | "—"
	notes?: string
	lineNumber: number
}

type LeaseFile = {
	pid: number
	createdAt: number
	heartbeatAt: number
	ttlMs: number
}

type PocketIcStateFile = {
	pid: number | null
	startedAt?: number
	binPath?: string | null
	args?: ReadonlyArray<string>
	version?: string | null
	managed?: boolean | null
	mode?: "foreground" | "background" | null
	port?: number | null
	bind?: string | null
	monitorPid?: number | null
	configHash?: string | null
}

const CSV_PATH = path.resolve(__dirname, "../fixtures/process_monitor_table.csv")

const toBool = (v: string): boolean => String(v).trim().toUpperCase() === "TRUE"
const toMaybe = (v: string): string | undefined => (v && v !== "—" ? v : undefined)

function readCsv(filePath: string): ReadonlyArray<Scenario> {
	const txt = fs.readFileSync(filePath, "utf8")
	const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0)
	if (lines.length <= 1) return []
	const header = lines[0]!
	const cols = header.split(",").map((s) => s.trim())
	const colIndex: Record<string, number> = {}
	cols.forEach((c, i) => (colIndex[c] = i))

	const parseLine = (line: string): string[] => {
		const out: string[] = []
		let cur = ""
		let inQuotes = false
		for (let i = 0; i < line.length; i++) {
			const ch = line[i]!
			if (ch === '"') {
				inQuotes = !inQuotes
				continue
			}
			if (ch === "," && !inQuotes) {
				out.push(cur)
				cur = ""
			} else {
				cur += ch
			}
		}
		out.push(cur)
		return out.map((s) => s.trim())
	}

	const get = (raw: string[], key: string): string => {
		const idx = colIndex[key]
		return idx === undefined ? "" : (raw[idx] ?? "")
	}

	const scenarios: Scenario[] = []
	for (let i = 1; i < lines.length; i++) {
		const raw = parseLine(lines[i]!)
		if (raw.every((c) => c === "")) continue
    const base: Omit<Scenario, "notes"> = {
			modeRun: get(raw, "mode_run").toLowerCase() as ModeRun,
			existingServer: get(raw, "existing_server").toLowerCase() as ExistingServer,
			existingMode: (get(raw, "existing_mode") || "—") as ExistingMode,
			activeLeasesBefore: (get(raw, "active_leases_before") || "0") as "0" | "1" | ">0",
			argsMismatch: (get(raw, "args_mismatch") || "no").toLowerCase() === "yes",
			argsMismatchSelection: (get(raw, "args_mismatch_selection") || "reuse") as "reuse" | "restart",
			concurrency: (get(raw, "concurrency") || "single") as Concurrency,
			parallelRole: (get(raw, "parallel_role") || "—") as ParallelRole,
			expectedAction: get(raw, "expected_action") as ExpectedAction,
			expectedManagedAfter: ((): boolean | undefined => {
				const v = toMaybe(get(raw, "expected_managed_after"))
				return v === undefined ? undefined : toBool(v)
			})(),
			expectedModeAfter: (get(raw, "expected_mode_after") || "—") as ExpectedModeAfter,
			expectedPidChange: (get(raw, "expected_pid_change") || "n/a") as ExpectedPidChange,
			expectedLeasesAfter: (get(raw, "expected_leases_after") || "n/a") as "1" | "2" | ">0" | "n/a",
			expectServerRunningDuring: toBool(get(raw, "expect_server_running_during") || "TRUE"),
			expectStateJsonPresentDuring: toBool(get(raw, "expect_statejson_present_during") || "TRUE"),
			expectServerRunningAfterExit: toBool(get(raw, "expect_server_running_after_exit") || "TRUE"),
			expectStateJsonPresentAfterExit: toBool(get(raw, "expect_statejson_present_after_exit") || "TRUE"),
			expectedError: ((get(raw, "expected_error") || "—") as "in-use" | "cannot-restart-manual" | "—"),
			lineNumber: i + 1,
        }
        const maybeNotes = toMaybe(get(raw, "notes"))
        const scenario: Scenario = (maybeNotes
            ? { ...base, notes: maybeNotes }
            : { ...base }) as Scenario
        scenarios.push(scenario)
	}
	return scenarios
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitTcpReady(host: string, port: number, timeoutMs: number): Promise<void> {
	const started = Date.now()
	let lastErr: unknown
	while (Date.now() - started < timeoutMs) {
		try {
			await new Promise<void>((resolve, reject) => {
				const socket = net.connect({ host, port })
				const to = setTimeout(() => socket.destroy(new Error("timeout")), 600)
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
			return
		} catch (e) {
			lastErr = e
			await sleep(100)
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function getFreePort(host: string = "0.0.0.0"): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const s = net.createServer()
        s.once("error", (e) => reject(e))
        s.listen({ host, port: 0 }, () => {
            const address = s.address()
            if (typeof address === "object" && address && typeof address.port === "number") {
                const p = address.port
                s.close(() => resolve(p))
            } else {
                s.close(() => reject(new Error("failed to allocate port")))
            }
        })
    })
}

function isPidAlive(pid: number | null | undefined): boolean {
	if (!pid) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function leaseDir(iceDirName: string): string {
	return path.resolve(process.cwd(), iceDirName, "pocketic-server", "leases")
}

function stateFilePath(iceDirName: string): string {
	return path.resolve(process.cwd(), iceDirName, "pocketic-server", "state.json")
}

async function ensureDir(p: string): Promise<void> {
	await fsp.mkdir(p, { recursive: true }).catch(() => {})
}

async function readState(iceDirName: string): Promise<PocketIcStateFile | undefined> {
	const p = stateFilePath(iceDirName)
	try {
		const txt = await fsp.readFile(p, "utf8")
		return JSON.parse(txt) as PocketIcStateFile
	} catch {
		return undefined
	}
}

async function writeLease(iceDirName: string, leaseId: string, ttlMs = 5000): Promise<{
	readonly heartbeat: () => Promise<void>
	readonly remove: () => Promise<void>
	readonly path: string
}> {
	const dir = leaseDir(iceDirName)
	await ensureDir(dir)
	const leasePath = path.join(dir, `${leaseId}.json`)
	const now = Date.now()
	const payload: LeaseFile = {
		pid: process.pid,
		createdAt: now,
		heartbeatAt: now,
		ttlMs,
	}
	await fsp.writeFile(leasePath, JSON.stringify(payload, null, 2), "utf8")
	return {
		heartbeat: async () => {
			const next: LeaseFile = { ...payload, heartbeatAt: Date.now() }
			await fsp.writeFile(leasePath, JSON.stringify(next, null, 2), "utf8")
		},
		remove: async () => {
			await fsp.unlink(leasePath).catch(() => {})
		},
		path: leasePath,
	}
}

async function countActiveLeases(iceDirName: string): Promise<number> {
	const dir = leaseDir(iceDirName)
	try {
		const files = await fsp.readdir(dir)
		let active = 0
		for (const f of files) {
			if (!f.endsWith(".json")) continue
			try {
				const txt = await fsp.readFile(path.join(dir, f), "utf8")
				const j = JSON.parse(txt) as LeaseFile
				const alive = isPidAlive(j.pid)
				const fresh = Date.now() - j.heartbeatAt <= j.ttlMs
				if (alive && fresh) active++
			} catch {}
		}
		return active
	} catch {
		return 0
	}
}

async function spawnManualPocketIc(host: string, port: number, ttlSeconds: number): Promise<ChildProcess> {
	const child = spawn(pocketIcPath, ["-i", host, "-p", String(port), "--ttl", String(ttlSeconds)], {
		detached: true,
		stdio: "ignore",
	})
	try {
		child.unref()
	} catch {}
	await waitTcpReady(host, port, 20_000)
	return child
}

async function killTree(proc: ChildProcess | undefined): Promise<void> {
	if (!proc?.pid) return
	try {
		process.kill(proc.pid, "SIGINT")
		await sleep(100)
		process.kill(proc.pid, 0)
		process.kill(proc.pid, "SIGKILL")
	} catch {}
}

function makeCtx(iceDirName: string, background: boolean): ICEConfigContext {
	return {
		iceDirPath: iceDirName,
		network: "local",
		logLevel: "debug",
		background,
	}
}

function cmpCountToExpectation(actual: number, expectation: "1" | "2" | ">0" | "n/a"): boolean {
	if (expectation === "n/a") return true
	if (expectation === ">0") return actual > 0
	return actual === Number(expectation)
}

function boolOrUndefinedToMode(v: boolean | undefined): string | undefined {
	if (v === undefined) return undefined
	return v ? "TRUE" : "FALSE"
}

describe.sequential("Pocket-IC process monitor — decision table", () => {
	const scenarios = readCsv(CSV_PATH)

	it.each(
		scenarios.map((s, idx) => [idx + 1, s, s.lineNumber]) as Array<[
			number,
			Scenario,
			number,
		]>,
	)("scenario #%s (csv line %s): %o", async (idx, s, line) => {
    const iceDirName = `.ice_test/monitor_${idx}`
    const host = "0.0.0.0"
    const port = await getFreePort(host)
		const ttlSeconds = 9_999_999_999

		// clean slate
		try {
			fs.rmSync(path.resolve(process.cwd(), iceDirName), { recursive: true, force: true })
		} catch {}

		let existingManual: ChildProcess | undefined
		let currentMonitor: Monitor | undefined
		let beforeState: PocketIcStateFile | undefined
		let afterState: PocketIcStateFile | undefined
		const taskLeaseId = `task_${idx}`
		let taskLease: { heartbeat: () => Promise<void>; remove: () => Promise<void>; path: string } | undefined

		// Arrange: existing server state
		if (s.existingServer === "manual") {
			existingManual = await spawnManualPocketIc(host, port, ttlSeconds)
			// adoption of manual happens when monitor starts
		} else if (s.existingServer === "managed") {
			const ctxExisting = makeCtx(iceDirName, s.existingMode === "background")
			const m = await makeMonitor(ctxExisting, { host, port, ttlSeconds })
			// keep managed server alive
			// ensure state file exists for background; foreground may not have state file yet
			await waitTcpReady(host, port, 20_000)
		}

		// Seed active leases before
		if (s.activeLeasesBefore === "1") {
			await writeLease(iceDirName, `seed_${idx}_1`)
		} else if (s.activeLeasesBefore === ">0") {
			await writeLease(iceDirName, `seed_${idx}_1`)
			await writeLease(iceDirName, `seed_${idx}_2`)
		}

		beforeState = await readState(iceDirName)
		const beforePid = beforeState?.pid ?? null

		// Act: run the current task
		const ctxCurrent = makeCtx(iceDirName, s.modeRun === "background")
		const run = async () => {
			// acquire a lease for the current task
			taskLease = await writeLease(iceDirName, taskLeaseId)
			// minimal heartbeat once
			await taskLease.heartbeat()
			// start/coordinate via monitor
			currentMonitor = await makeMonitor(ctxCurrent, { host, port, ttlSeconds })
			await waitTcpReady(host, port, 20_000)
		}

		if (s.expectedError !== "—") {
			await expect(run()).rejects.toThrow()
			// No further asserts when expecting error
			// Cleanup
			await taskLease?.remove()
			await killTree(existingManual)
			return
		}

		await run()

		// Assert DURING
		const duringState = await readState(iceDirName)
		const duringPid = duringState?.pid ?? null
		if (s.expectServerRunningDuring) {
			await expect(waitTcpReady(host, port, 3_000)).resolves.toBeUndefined()
		} else {
			await expect(waitTcpReady(host, port, 1_000)).rejects.toBeTruthy()
		}
		const stateDuringExists = fs.existsSync(stateFilePath(iceDirName))
		expect(stateDuringExists).toBe(s.expectStateJsonPresentDuring)

		// Expected action heuristic: compare pid before/after
		if (s.expectedPidChange !== "n/a") {
			if (s.expectedPidChange === "same") {
				expect(duringPid).toBe(beforePid)
			} else {
				expect(duringPid && beforePid ? duringPid !== beforePid : true).toBe(true)
			}
		}

		if (s.expectedManagedAfter !== undefined) {
			expect(Boolean(duringState?.managed)).toBe(s.expectedManagedAfter)
		}
		if (s.expectedModeAfter !== "n/a" && s.expectedModeAfter !== "—") {
			expect(duringState?.mode ?? null).toBe(s.expectedModeAfter)
		}

		const activeDuring = await countActiveLeases(iceDirName)
		expect(cmpCountToExpectation(activeDuring, s.expectedLeasesAfter)).toBe(true)

		// Exit: release this task's lease; foreground semantics may stop the server when leases reach 0 per spec
		await taskLease?.remove()
		await sleep(200)

		afterState = await readState(iceDirName)
		const afterStateExists = fs.existsSync(stateFilePath(iceDirName))
		if (s.expectStateJsonPresentAfterExit) {
			expect(afterStateExists).toBe(true)
		} else {
			expect(afterStateExists).toBe(false)
		}

		if (s.expectServerRunningAfterExit) {
			await expect(waitTcpReady(host, port, 3_000)).resolves.toBeUndefined()
		} else {
			await expect(waitTcpReady(host, port, 1_000)).rejects.toBeTruthy()
		}

		// Cleanup manual server if any
		await killTree(existingManual)
	})
})


