Pocket-IC Process Orchestration — Unified Spec (FG + BG via Leases)

This document defines a complete, self-contained design for starting, adopting, monitoring, and stopping a local Pocket-IC replica across foreground (FG) and background (BG) usage. It assumes a single local “network” instance (single bind/port pair) managed by us, and supports manual instances started by users that we must not touch.

The core idea is simple: there is at most one monitor process per managed server, and leases determine the server’s lifetime. FG and BG are just different kinds of leases; the behavior otherwise is identical.

⸻
	1.	Components & Roles

	•	Runner (task launcher): the CLI/integration that needs a replica. It ensures a monitor/server exists (adopt or spawn), creates a lease for the duration of the task, and cleans the lease up when done.
	•	Monitor: a small companion process that owns state.json, watches leases, and controls the Pocket-IC server process. It stops the server when (and only when) the last lease disappears.
	•	Pocket-IC server: the third-party binary (pocket-ic) we don’t modify.
	•	Manual server: a Pocket-IC process started outside our system (no monitor, no state). We never modify/stop it.

⸻
	2.	Directory Layout (current tree respected; all new files live under pocketic-server/)

.ice/
  pocketic-server/
    state.json          # written & owned by the monitor (managed-only)
    leases/             # per-task lease files (created by runners)
      <uuid>.json
    spawn.lock          # best-effort lock to serialize spawn/adopt
  # (existing paths unchanged)
  pocket-ic.log
  replica-state/...
  canisters/...
  canister_ids.json
  logs/instrumentation.json
  cache/...

⸻
	3.	File Formats

3.1 state.json (authoritative, monitor-owned)

Written by the monitor on spawn or adopt. Deleted by the monitor when the last lease goes away and the server is stopped.

{
  "managed": true,
  "monitorPid": 12345,
  "serverPid": 23456,
  "binPath": "/abs/path/to/pocket-ic",
  "version": "10.0.0",
  "args": ["-i","0.0.0.0","-p","8081","--ttl","9999999999"],
  "config": { /* full resolved replica config incl. subnets, etc. */ },
  "configHash": "sha256:...",
  "bind": "0.0.0.0",
  "port": 8081,
  "startedAt": 1730000000000,
  "instanceRoot": "/abs/path/to/.ice/replica-state"
}

Invariant: If state.json exists, it describes a managed instance and must reflect live monitor and server PIDs (or we are in a recovery/adopt path).

3.2 Lease files (runner-created, one per task)

Stored under leases/<uuid>.json. The monitor never writes leases; it only reads and reaps them.

{
  "id": "uuid-4",
  "ownerPid": 56789,
  "mode": "foreground" | "background",
  "createdAt": 1730000000000,
  "expiresAt": null | 1730003600000,  // BG: null (persistent). FG: usually null; liveness is ownerPid.
  "policy": "reuse" | "restart",       // runner’s args-mismatch policy for this task (for audit)
  "configHash": "sha256:..."           // desired config hash (optional, for audits/debug)
}

3.3 spawn.lock (best-effort serialization)

A single file created exclusively by the first runner entering spawn/adopt. Contains { "pid": <runnerPid>, "createdAt": <ms> }. Runners that can’t acquire it immediately should retry briefly. If the lock holder process is dead, the next runner can safely remove the stale lock and proceed.

⸻
	4.	Global Invariants

	•	Single monitor per managed server (per bind/port).
	•	Server lifetime = number of active leases > 0.
	•	Monitor owns state.json (runners never write or delete it).
	•	Runners only create/remove their own lease.
	•	If a server is found without a monitor/state.json, it is manual; do not touch or adopt (unless there is a valid state.json recorded from a previous managed session and the server PID matches; see §6.2).

⸻
	5.	Modes and Policies

	•	FG task ⇒ creates a foreground lease. Ends when the task ends (lease file removed by runner; monitor reaps if the runner crashes).
	•	BG server ⇒ creates a background lease (persistent; no expiresAt). Stays until explicitly removed by an explicit “stop” command.
	•	Args mismatch policy (decided by the runner, not the monitor):
	•	reuse — use the existing managed server regardless of arg/config differences.
	•	restart — fail-fast if the server is in use by any lease not owned by the requester; otherwise replace with a new managed server (details in §8).
	•	Manual server — never stopped or modified by us. We do not spawn a monitor or create state.json or leases for manual servers.

⸻
	6.	Lifecycle Flows

6.1 Runner: “I need a replica” (FG or BG)

Input: desired { binPath, args, config, bind, port }, policy ∈ {reuse|restart}, mode ∈ {foreground|background}.

Pseudocode:

BEGIN RUNNER_SESSION
1) Attempt to acquire spawn.lock (exclusive open 'wx').
   - If taken, retry briefly.
   - If holder pid is dead, remove stale lock and retry.

2) Determine current state:
   a) If state.json exists:
        - Read state.
        - If monitorPid and serverPid are alive:
             -> Managed instance present.
             -> Compare desired configHash to state.configHash.
                * If policy = restart and hashes differ:
                     - Inspect active leases:
                       - If any lease exists that is NOT owned by this runner:
                           -> return error "in-use" (fail-fast). Do nothing.
                       - Else (no leases, or only runner-owned BG lease):
                           -> If runner owns any BG lease(s), remove them now.
                           -> Release spawn.lock.
                           -> Wait until state.json disappears (monitor stops server when leases drop to 0).
                           -> Re-acquire spawn.lock and go to step 3 (spawn fresh).
                * Else (policy = reuse OR hashes equal):
                     -> proceed to step 4 (leasing).
        - If monitorPid dead but serverPid alive:
             -> Stale managed state (monitor crash). Re-adopt is allowed.
             -> Spawn a new monitor in adopt mode (attach to serverPid).
             -> Proceed to step 4.
        - If serverPid dead (or both dead):
             -> Remove stale state.json (safe).
             -> Proceed to step 3 (spawn).

   b) If no state.json exists:
        - Check if a server is listening on (bind, port).
           * If yes => manual server. Do not spawn monitor. Do not write state.json.
             - Mark context="manual". Do NOT create leases. Release spawn.lock and go to step 5.
           * If no => proceed to step 3 (spawn).

3) Spawn managed server:
   - Start monitor in spawn mode with desired args/config.
   - Monitor launches pocket-ic, writes state.json, and begins its loop.

4) Create lease (managed only):
   - Create leases/<uuid>.json with ownerPid=this runner's pid, mode, policy, etc.

5) Release spawn.lock.

6) Run the task against the replica.

7) On task completion (or explicit stop):
   - If managed: delete this lease file.
   - Exit.
END RUNNER_SESSION

Note on manual servers: For a manual server, runners must not create leases (there is no monitor to observe them). They just connect and run. If args mismatch exists and policy=restart, the runner must fail fast with a clear error (“Manual server present on port; cannot restart. Stop it or change configuration.”).

6.2 Monitor: startup & loop

The monitor has two entry modes:
	•	Spawn mode (fresh managed server)
	1.	Launch Pocket-IC with provided args/config.
	2.	Record serverPid and full metadata to state.json.
	3.	Enter the loop.
	•	Adopt mode (recover stale managed state)
	1.	Validate serverPid from state.json is alive.
	2.	Write/refresh state.json with this monitorPid (leave other fields intact).
	3.	Enter the loop.

Monitor loop pseudocode:

WHILE true:
  - If serverPid is not alive:
       -> Remove state.json (best effort).
       -> Exit (nonzero exit ok; tasks will fail and re-init).

  - Scan leases dir:
       -> For each lease file:
            * If ownerPid is not alive => delete that lease (reap stale).
       -> Count remaining leases.

  - If lease count == 0:
       -> Gracefully stop the server (official mechanism if available, else TERM).
       -> Wait until server exits.
       -> Remove state.json.
       -> Exit (0).

  - Sleep small interval and repeat.

Ownership: Only the monitor writes/deletes state.json. Runners never modify it. Runners only add/remove leases. The monitor never modifies leases except to reap obviously stale ones (dead ownerPid).

⸻
	7.	Concurrency Guarantees

	•	Multiple tasks in parallel: each creates its own lease; none can accidentally tear down the server while others are running. The monitor stops the server only when the last lease disappears.
	•	FG + BG together: BG holds a persistent lease; FG tasks come and go. The server remains until the BG lease is removed (explicit stop).
	•	Race-free spawn/adopt: spawn.lock ensures only one runner at a time performs the spawn/adopt decision. Others either wait briefly or proceed directly to leasing once the first runner finishes spawning/adopting.

⸻
	8.	Args / Config Mismatch Behavior

	•	The runner compares desired.configHash vs state.configHash (managed only).
	•	If policy = reuse: proceed (create a lease, run work).
	•	If policy = restart and hashes differ:
	•	Fail-fast non-blocking rule:
If any active lease exists that is not owned by the requester, immediately return error “in-use”. The runner does not wait for other leases to end and does not modify the server.
	•	Allowed restart cases:
	•	No leases: spawn a new managed server immediately.
	•	Only requester-owned BG lease(s): the runner may delete its own BG lease(s), then wait for state.json to disappear (monitor stops the old server), re-acquire spawn.lock, and spawn a fresh managed server with the new args/config. This waiting is only for the effect of self lease removal, not for others.
	•	If manual server is present:
	•	We do not manage/stop it.
	•	policy = restart ⇒ error (“Manual server present on port; cannot restart.”).
	•	policy = reuse ⇒ attach and run (no leases).

⸻
	9.	Edge Cases & Recovery

	•	Runner crashes: its lease is reaped by the monitor (ownerPid not alive).
	•	Monitor crashes:
	•	If state.json exists and the server is still alive, the next runner can adopt (using the recorded serverPid).
	•	If both are gone, the next runner spawns fresh.
	•	Server crashes while leases exist: the monitor detects serverPid dead and exits after removing state.json. Tasks fail; subsequent runs spawn fresh.
	•	Stale spawn.lock: if lock holder pid is dead, the next runner removes the lock and proceeds.
	•	Manual server present: never touched. No monitor, no state.json, no leases. Runners can run against it but cannot orchestrate restart; mismatch with restart yields a clear error.

⸻
	10.	Health & Validation

	•	Liveness checks: use OS-level PID liveness (cross-platform best effort). For managed instances, state.json PIDs are the source of truth.
	•	Port binding check: before spawning, runners check if (bind, port) is already occupied; if so and no state.json exists → treat as manual.
	•	Sanity fields: startedAt, binPath, args, config are captured for audit and reproducibility.

⸻
	11.	Minimal External Interface (from the runner’s POV)

	•	Start (FG/BG): perform the Runner flow (§6.1) with policy ∈ {reuse|restart} and the desired config. Returns a “session” tied to the lease id (managed) or a manual context (no lease).
	•	Stop (BG): delete the BG lease. The monitor will stop the server once all other leases (if any) are gone.
	•	No server control from tasks: tasks never signal or kill the server. They only add/remove leases.

⸻
	12.	Why this model fixes concurrency tear-downs

	•	Shutdown is not tied to parent processes or terminal lifetimes.
	•	Only the monitor may stop the server, and it does so strictly when there are zero leases.
	•	FG and BG are unified by the same lease semantics; their difference is only the lease’s persistence.
	•	restart is fail-fast when other parties hold leases, preventing accidental disruption of concurrent work.

⸻
	13.	Pseudocode Summary (one place)

Runner (FG/BG):

startRunner(mode, policy, desiredConfig):
  acquireSpawnLock()
  try:
    if exists(state.json):
      st = read(state.json)
      if alive(st.monitorPid) and alive(st.serverPid):
        if policy == "restart" and hash(desiredConfig) != st.configHash:
          leases = listActiveLeases()
          if exists(lease not owned by me):
            error("in-use")   # fail-fast
          else:
            # only my own BG lease(s), or none
            removeMyBgLeasesIfAny()
            releaseSpawnLock()
            waitUntil(!exists(state.json))  # monitor stops server as leases -> 0
            acquireSpawnLock()
            spawnManaged(desiredConfig)
      else if !alive(st.monitorPid) and alive(st.serverPid):
        spawnMonitorInAdoptMode()
      else:
        remove(state.json)
        spawnManaged(desiredConfig)
    else:
      if portOccupied(bind, port):
        context = "manual"   # no leases for manual
      else:
        spawnManaged(desiredConfig)

    if context != "manual":
      createLease(mode, policy, ownerPid = thisPid)
  finally:
    releaseSpawnLock()

  runWorkAgainstReplica()

  if context != "manual":
    removeLease(ownLeaseId)

Monitor (spawn or adopt):

monitorMain(mode):
  if mode == "spawn":
    serverPid = launchPocketIc(args)
    writeStateJson(monitorPid, serverPid, args, config, ...)
  else if mode == "adopt":
    assert alive(serverPid from state.json)
    rewriteStateJsonWithNewMonitorPid()

  loop:
    if !alive(serverPid):
      remove(state.json)
      exit(1)

    reapStaleLeases()
    if countActiveLeases() == 0:
      stopServerGracefully(serverPid)
      remove(state.json)
      exit(0)

    sleepShort()

⸻

This spec keeps the system small and predictable:
	•	One monitor per managed instance.
	•	One state file (owned by the monitor).
	•	One concept (leases) to gate lifetime—for both FG and BG.
	•	Clear boundaries for manual vs managed scenarios.
	•	Deterministic behavior under concurrency, with fail-fast restarts to protect in-use servers.