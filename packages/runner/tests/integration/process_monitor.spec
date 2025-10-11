Pocket-IC Runner/Monitor — Functional Spec (rev)

1) Scope & goals
	•	Works on macOS/Linux/Windows using Node core only.
	•	Supports foreground, background, and manual (user-started) Pocket-IC.
	•	Prevents duplicate servers and monitors; tolerates concurrent tasks from multiple terminals/editors/CI.
	•	Uses file-based admin lock + per-task leases (with heartbeats) for safe coordination.
	•	Single state file (state.json) represents both managed and manual servers.
	•	Args mismatch is handled via a single flag: reuse or restart. (No interactive flow for now.)

2) Terminology
	•	Server: the pocket-ic process.
	•	Monitor: Node wrapper that spawns/adopts server and manages locks/leases/state.
	•	Managed server: started by our monitor; we control lifecycle.
	•	Manual server: user started it; we never stop it.
	•	Lease: a per-task file indicating “this task is using the server”.
	•	Config: normalized JSON of everything that affects server semantics (CLI args + instance create payload).

3) On-disk layout (no restructure; add only under .ice/pocketic-server/)

Existing (unchanged elsewhere):

.ice/cache/...
.ice/canisters/<name>/{did,wasm,...}
.ice/logs/instrumentation.json
.ice/replica-state/{topology.json, registry.proto, ...}
.ice/canister_ids.json
.ice/pocket-ic.log

Additions (all under .ice/pocketic-server/):

.ice/pocketic-server/
  state.json                 // authoritative state (managed OR manual)
  state.json.tmp             // for atomic writes
  locks/
    admin.lock               // admin lock (exclusive ops)
  leases/
    <leaseId>.json           // per-task lease files (+ heartbeat)
  .pid                       // monitor PID (present while FG monitor is alive; optional in BG)
  .server.pid                // server PID (best-effort; mirrors state.json.pid)

Atomic write rule: write *.tmp, fsync, rename to final, then fsync directory (where supported).

4) state.json schema (single file for both managed + manual)

{
  "schemaVersion": 1,
  "managed": true,                  // true if we spawned it; false if manual
  "mode": "foreground" | "background",  // only meaningful when managed=true
  "binPath": "<abs path to pocket-ic>" | null,
  "version": "10.0.0" | null,
  "pid": <server_pid or null>,      // null if unknown
  "monitorPid": <monitor_pid or null>,
  "port": <number>,
  "bind": "<ip or host>",
  "startedAt": <ms epoch>,
  "args": [ /* raw argv passed to pocket-ic, if known */ ] | null,
  "config": { /* normalized config object; see §5 */ } | null,
  "configHash": "<sha256 over normalized config>" | null,
  "instanceRoot": "<abs path to .ice/pocketic-server/>"
}

	•	Managed=true: we must populate binPath, pid, args, config, configHash, mode.
	•	Managed=false (manual): fill what we can (port/bind, maybe pid if we can detect); args/config may be null.

Foreground note: we also write state.json in FG. On a clean FG shutdown, we remove state.json only if no other leases remain (see §8).

5) Normalized config (for mismatch detection)

Normalized config is the canonical JSON we compare (stringified with sorted keys, absolute paths only):

{
  "pocketIcCli": {
    "bind": "0.0.0.0",
    "port": 8081,
    "ttl": 9999999999
  },
  "instance": {
    "stateDir": "<absolute path to .ice/replica-state>",
    "initialTime": { "AutoProgress": { "artificialDelayMs": 0 } },
    "topology": {
      "nns": {...}, "ii": {...}, "sns": {...}, "bitcoin": {...}, "application": [...]
    },
    "incompleteState": true | false,
    "nonmainnet": true | false,
    "verifiedApplication": 0 | 1 | <int>
  }
}

	•	Put this object in state.json.config when managed=true.
	•	Also compute configHash = SHA256 over the normalized JSON string (optional but recommended).
	•	Test matrix column: args_mismatch_selection ∈ {reuse|restart} controls the decision when mismatch is detected.

6) Admin lock (exclusive operations)

File: .ice/pocketic-server/locks/admin.lock
	•	Acquire by creating the file with flag: 'wx'. Contents:

{ "pid": <process.pid>, "acquiredAt": <ms epoch> }


	•	Release by unlinking the file.
	•	If it exists:
	•	Read PID; if not alive and modified time older than staleAdminMs (default 30s), we can steal the lock (unlink then acquire).
	•	All destructive or mutating ops require the admin lock:
	•	Spawn server, write/replace state.json
	•	Stop server, restart server
	•	Crash/stale cleanup of state.json, .server.pid, .pid
	•	Lease sweeping (you may also allow sweeping without the lock, but final removal of state requires the lock)

7) Leases (shared, per-task)

Dir: .ice/pocketic-server/leases/
	•	On task start, create leases/<leaseId>.json:

{
  "pid": <client_pid>,
  "createdAt": <ms>,
  "heartbeatAt": <ms>,
  "ttlMs": <int>        // default 5000 (see below)
}


	•	Heartbeat: update heartbeatAt at ~1–2s interval during long operations.
	•	A lease is active if pid is alive and (now - heartbeatAt) <= ttlMs.
	•	Defaults: leaseHeartbeatMs = 1500, leaseTtlMs = 5000.
	•	On normal task exit: delete its lease (best effort). If not, it will expire.
	•	FG auto-stop condition (managed only): When the last lease goes inactive/removed, FG instance may shut down (see §8).
	•	BG persistence: Background instances do not auto-stop just because leases drop to zero (they stay up until an explicit restart/stop is requested).

Heartbeats are made only by clients holding leases. Background mode is fine: if no tasks are running, there are simply no active leases; the server remains up until an operation needs to stop/restart it.

8) Lifecycle by mode

Foreground (managed=true, mode="foreground")
	1.	Acquire admin lock.
	2.	Discovery (§9).
	3.	If nothing running → spawn the server; write state.json.
	4.	If a managed server exists → compare configs:
	•	If mismatch:
	•	Apply args_mismatch_selection:
	•	reuse: keep running server as-is.
	•	restart: allowed only if active lease count == 0. Otherwise reject and report “in use”.
	•	If no mismatch: reuse.
	5.	If a manual server exists: mark managed=false in state.json and reuse only (we never restart/stop manual).
	6.	Release admin lock.
	7.	Create a lease for the current task.
	8.	On task end:
	•	Remove the lease.
	•	If managed=true and no active leases remain, perform a clean FG stop (see §10) and then remove state.json.
	•	If any lease remains, do not stop.

Background (managed=true, mode="background")
	•	Same as FG for startup decisions (including mismatch), but the monitor exits after initial coordination.
	•	The server stays up regardless of leases dropping to zero.
	•	Stop/restart occurs only when a later operation (with admin lock) requests it, and only if active leases == 0.

Manual (managed=false)
	•	We never spawn/stop.
	•	On discovery, write/update state.json with managed=false (fill what we can).
	•	Tasks still use leases for coordination among themselves, but lifecycle is not ours to control.
	•	If args_mismatch_selection=restart, we reject (cannot restart manual).

9) Discovery & adoption (single-file state)
	1.	If .ice/pocketic-server/state.json exists:
	•	Parse it; validate recorded PIDs.
	•	If managed=true and both pid(server) and monitorPid (if present) are dead → under admin lock, cleanup stale files (state.json, .server.pid, .pid) and treat as “nothing running”.
	•	If managed=false (manual) and the port still answers like Pocket-IC → keep state.json as is and treat as manual.
	2.	If state.json absent:
	•	Probe the configured port for a Pocket-IC response.
	•	If it responds: create state.json with managed=false (manual adoption).
	•	If not: treat as “nothing running”.

10) Stop / Restart (managed only)

Only when active leases == 0.

	•	Stop:
	1.	Acquire admin lock.
	2.	Verify active leases == 0; if not, reject with “in use”.
	3.	Send standard graceful termination (e.g., server’s own HTTP stop if available; else process.kill(pid, 'SIGTERM')).
	4.	Wait for exit in a bounded loop.
	5.	On exit, remove state.json, .server.pid, .pid.
	6.	Release admin lock.
	•	Restart:
	1.	Ensure active leases == 0. If not, reject.
	2.	Perform Stop → Start with the new config and update state.json.

11) Concurrency rules
	•	Every task must hold a lease while it interacts with the server.
	•	Admin operations (spawn/stop/restart/cleanup) require the admin lock.
	•	A FG task must not stop a server if any other lease is still active.
	•	BG instances persist; they are only stopped when a restart/stop is requested and leases are zero.

12) Cleanup & recovery (performed on any task start)

Under the admin lock:
	1.	Sweep leases/: remove those whose process is dead or heartbeatAt expired.
	2.	If state.json exists but the recorded pid is dead:
	•	If managed=true: remove state.json, .server.pid, .pid (stale crash).
	•	If managed=false: leave as-is (manual; lifecycle not ours).
	3.	Release admin lock.

13) Args mismatch logic (and test matrix column)
	•	Normalized config (§5) is compared to state.json.config if managed=true.
	•	If mismatch:
	•	args_mismatch_selection=reuse → keep the current server as-is.
	•	args_mismatch_selection=restart →
	•	If managed=false (manual) → reject (“cannot restart manual”).
	•	If managed=true and active leases == 0 → restart with new config.
	•	If managed=true and active leases > 0 → reject with “in use”.
	•	If no mismatch: reuse.

For your CSV: include a column args_mismatch_selection with values reuse or restart. Expected outcomes should assert:
	•	Whether a spawn occurs or not,
	•	Whether a stop/restart occurs or is rejected,
	•	Final managed value, server PID continuity (same/different), and lease counts.

14) Defaults
	•	leaseHeartbeatMs = 1500
	•	leaseTtlMs = 5000
	•	staleAdminMs = 30000
	•	args_mismatch_selection default: reuse (unless explicitly set to restart)

⸻

Notes that address your questions directly
	•	Single state file: yes—state.json covers both managed and manual. No separate adoption.json.
	•	Heartbeats and background: harmless—heartbeats are per-task; background servers persist even when leases drop to zero.
	•	Only two mismatch options: reuse or restart (no “fail”, no “new port”, no interactive UI in this spec).
	•	New files live under .ice/pocketic-server/ only (locks, leases, state, pids); no broader restructure now.
	•	Foreground vs background: FG cleans up the server when its own task finishes and leases are zero; BG never auto-stops.

This is the whole contract the Cursor agent can implement against, and it aligns with your test matrix knobs.

Column descriptions (For the test csv, process_monitor_table.csv, only where clarification helps)
	•	mode_run — Which mode the current task is requesting: foreground or background.
	•	existing_server — What already exists on the target port before the task starts:
	•	none: nothing bound to the port.
	•	managed: a server previously launched by our monitor (has state/lease tracking).
	•	manual: a server not launched by us (no state/lease tracking yet).
	•	existing_mode — The mode of the existing managed server (foreground or background). Use — when there’s no existing or it’s manual.
	•	active_leases_before — Number of active leases already held by other tasks when the current task begins (e.g., 0, 1, >0).
	•	args_mismatch — Whether the existing server’s recorded args/config differ from the task’s requested args/config.
	•	args_mismatch_selection — Policy to apply when args_mismatch=yes:
	•	reuse: use the existing server unchanged.
	•	restart: gracefully replace the existing managed server with a new one using the requested args. (Not allowed if existing_server=manual or if leases>0.)
	•	concurrency — Whether this scenario models a single task or a parallel pair: single or parallel.
	•	parallel_role — For parallel scenarios: is this the first task (the one that starts earlier) or the second task (arrives while the first is still running)?
	•	expected_action — What the orchestrator should do:
	•	spawn: start a new managed server.
	•	reuse: attach to an existing server and add a lease.
	•	restart: stop existing managed server (when safe) and start a new one with new args, transferring/maintaining appropriate lease.
	•	reject-in-use: refuse restart because another lease holds the server.
	•	adopt-manual: accept a manual server without managing its lifecycle.
	•	reject-cannot-restart-manual: refuse restart because the server is manual.
	•	expected_mode_after — Mode the server should be running in during the scenario after the action: foreground, background, or —/n/a when not applicable (e.g., purely manual adoption note).
	•	expected_pid_change — Whether the underlying process should be the same or different after the action (n/a when no server is present/managed semantics don’t apply).
	•	expected_leases_after — Expected lease count after the action (e.g., 1, 2, >0).