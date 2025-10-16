Pocket-IC Process Orchestration — Unified Spec (FG + BG via Leases)

Single managed instance per bind/port. Manual instances (no state) are never modified. One monitor owns the managed instance; leases gate lifetime. No TTLs/heartbeats.

⸻

1) Components & Roles
	•	Runner (task launcher): ensures a managed instance exists (adopt or spawn), creates/removes a lease around its work.
	•	Monitor: owns state.json, watches leases, controls the server’s lifetime. Stops the server when the last lease disappears.
	•	Pocket-IC server: third-party binary we launch.
	•	Manual server: user-started, no state; we never modify/stop it.

⸻

2) Directory Layout

.ice/
  pocketic-server/
    state.json          # monitor-owned (managed only)
    leases/             # per-task lease files (runner-owned)
      <uuid>.json
    spawn.lock          # best-effort mutex for spawn/adopt
  pocket-ic.log
  replica-state/...
  canisters/...
  canister_ids.json
  logs/instrumentation.json
  cache/...


⸻

3) File Formats

3.1 state.json (authoritative, monitor-owned)

Written on spawn/adopt; removed when the server is stopped after the last lease is gone.

{
  "managed": true,
  "mode": "foreground" | "background" | null,   // mode chosen when monitor started
  "monitorPid": 12345,
  "binPath": "/abs/path/to/pocket-ic",
  "version": "10.0.0",
  "args": ["-i","0.0.0.0","-p","8081"],
  "config": { /* resolved replica config */ },
  "bind": "0.0.0.0",
  "port": 8081,
  "startedAt": 1730000000000,                    // per-instance identity token
  "instanceRoot": "/abs/path/to/.ice/replica-state"
}

Identity token: startedAt uniquely identifies the running instance and only changes when the server is restarted.

3.2 Lease files (runner-created, one per task)

pocketic-server/leases/<uuid>.json

{
  "mode": "foreground" | "background",
  "pid": 56789,   
  "startedAt": 1730000000000  // copy of state.startedAt at creation
}

	•	No TTLs, no heartbeats.
	•	FG lease is active while pid is alive AND startedAt === state.startedAt.
	•	BG lease is active while startedAt === state.startedAt.

3.3 spawn.lock

Exclusive-create (wx) file with { "pid": <runnerPid>, "createdAt": <ms> }. If the holder PID is dead, the next runner may remove it and proceed.

⸻

4) Global Invariants
	•	One monitor per managed server (per bind/port).
	•	Server lifetime = (FG lease count > 0) OR (BG lease present).
	•	Only the monitor writes/deletes state.json. Runners never touch it.
	•	Runners only add/remove their own leases.
	•	If the port is occupied and no state.json exists → manual; never adopt/manage it.

⸻

5) Modes & Policies
	•	FG task: creates an FG lease; removed when task ends (or reaped if process died).
	•	BG server: creates a persistent BG lease; remains until explicit “stop”.
	•	Runner policy:
	•	reuse: keep using the existing managed instance.
	•	restart: allowed only if no active lease exists that isn’t owned by the requester; else fail fast (“in use”).
	•	Manual server: never modified; no state, no leases.

⸻

6) Lifecycle Flows

6.1 Runner: “I need a replica” (FG or BG)

Inputs: { binPath, args, bind, port }, policy ∈ {reuse|restart}, mode ∈ {foreground|background}.
	1.	Acquire spawn.lock. Retry briefly; if owner PID is dead, remove and retry.
	2.	Determine current state:
	•	If state.json exists:
	•	If monitorPid is alive and (bind,port) is listening → managed.
	•	If policy=restart and desired.config !== state.config:
	•	List active leases:
	•	If any active lease not owned by this runner → error: in use (fail fast).
	•	Else (no active leases, or only this runner’s BG lease):
	•	Remove this runner’s BG lease if present.
	•	Release spawn.lock.
	•	Wait until state.json disappears (monitor stops when leases → 0).
	•	Re-acquire spawn.lock, then spawn fresh (step 3).
	•	Else (reuse or hashes equal) → step 4.
	•	If monitorPid is dead:
	•	If (bind,port) is listening → adopt: start a new monitor that rewrites monitorPid (preserving startedAt, mode, etc.), then step 4.
	•	Else (not listening) → remove stale state.json, then step 3 (spawn).
	•	If no state.json:
	•	If (bind,port) is listening → manual; release spawn.lock; do not create leases; connect and run.
	•	Else → step 3 (spawn).
	3.	Spawn managed: start monitor in spawn mode; it launches Pocket-IC, writes state.json, and enters its loop.
	4.	Create lease (managed only):
	•	Read state.startedAt.
	•	FG: write lease with pid=thisPid, mode:"foreground", startedAt=state.startedAt.
	•	BG: write lease with pid=thisPid, mode:"background", startedAt=state.startedAt.
	5.	Release spawn.lock.
	6.	Run work.
	7.	On completion (managed): delete your lease (monitor reaps FG lease if you crash).

6.2 Monitor: startup & loop

Spawn mode
	•	Launch Pocket-IC.
	•	Write state.json with managed:true, chosen mode, monitorPid, startedAt, config metadata, etc.
	•	Keep an internal handle to the child process (implementation detail; not exposed).

Adopt mode
	•	Assume the server is the one listening on state.bind:state.port.
	•	Rewrite state.json with the new monitorPid (preserving startedAt, mode, etc.).
	•	Enter loop.

Loop (repeat):
	1.	Server liveness: If (bind,port) is not listening (or repeated health checks fail):
	•	Remove state.json.
	•	Exit (non-zero is fine).
	2.	Reap leases:
	•	Delete any lease whose startedAt !== state.startedAt.
	•	For remaining FG leases, if pid is not alive → delete that lease.
	•	BG leases persist.
	3.	Decide lifetime:
	•	fgCount = number of FG leases
	•	hasBg = exists BG lease
	•	If fgCount === 0 && !hasBg:
	•	Stop the server gracefully (implementation-defined; use child handle when spawned).
	•	Remove state.json.
	•	Exit(0).
	4.	Sleep briefly and repeat.

⸻

7) Concurrency Guarantees
	•	Parallel FG tasks: each gets an FG lease; none can tear the server down while others run.
	•	BG + FG: BG lease pins the server; FG leases can come and go.
	•	spawn.lock serializes spawn/adopt decisions.

⸻

8) Args / Config Mismatch
	•	Runner compares desired.config vs state.config (managed only).
	•	reuse → proceed (create lease).
	•	restart:
	•	If any active lease exists that isn’t owned by the requester → fail fast (“in use”).
	•	If none:
	•	Remove requester’s BG lease if present.
	•	Let monitor shut down (leases → 0), then spawn fresh.

Manual server present:
	•	restart → error (“manual present; cannot restart”).
	•	reuse → attach and run (no leases).

⸻

9) Edge Cases & Recovery
	•	Runner crash → monitor reaps the FG lease (PID dead).
	•	Monitor crash while server keeps running:
	•	Next runner adopts (port listening & state.json exists with dead monitorPid).
	•	Server crash with leases → monitor removes state.json and exits; next run spawns fresh.
	•	Stale spawn.lock → if lock owner PID dead, next runner removes it.

⸻

10) Health & Validation
	•	Liveness: only PID liveness of lease owners is used;
	•	Identity: state.startedAt binds leases to the current instance; mismatches are reaped.
	•	Port check: used for managed/manual detection and server liveness.

⸻

11) Minimal External Interface (runner POV)
	•	Start (FG/BG): perform the flow above; returns a session (managed: lease id; manual: no lease).
	•	Stop (BG): delete the BG lease; monitor stops server when all leases are gone.
	•	Tasks never signal the server; they only manage their lease.

⸻

12) Why this works
	•	Server lifetime is strictly tied to leases; no timers, no parent coupling.
	•	Restart protection is deterministic and race-free.
	•	Manual vs managed is unambiguous via state.json + port liveness.

⸻

13) Pseudocode (reference)

Runner

startRunner(mode, policy, desired):
  acquireSpawnLock()
  try:
    if exists(state.json):
      st = read(state.json)
      if alive(st.monitorPid) and portListening(st.bind, st.port):
        if policy == "restart" and desired.config != st.config:
          leases = activeLeasesFor(st.startedAt)
          if exists(lease not owned by me): error("in use")
          removeMyBgLeasesIfAny()
          releaseSpawnLock()
          waitUntil(!exists(state.json))
          acquireSpawnLock()
          spawnManaged(desired)
      else if !alive(st.monitorPid) and portListening(st.bind, st.port):
        adoptManaged()                # rewrites monitorPid; preserves startedAt
      else:
        remove(state.json) if exists
        spawnManaged(desired)
    else:
      if portListening(desired.bind, desired.port): context = "manual"
      else: spawnManaged(desired)

    if context != "manual":
      st = read(state.json)           # get startedAt
      createLease({
        mode,
        pid: thisPid,
        startedAt: st.startedAt,
      })
  finally:
    releaseSpawnLock()

  runWork()

  if context != "manual":
    removeLease(id)

Monitor

monitorMain(spawnOrAdopt):
  if spawn:
    launchPocketIc(args)              # keep internal handle (not exposed)
    writeState({ managed:true, mode, monitorPid, startedAt: now(), ... })
  else:
    rewriteState({ monitorPid })      # keep startedAt/mode/etc.

  loop:
    if !portListening(state.bind, state.port):
      remove(state.json); exit(1)

    reap leases where lease.startedAt != state.startedAt
    reap FG leases where !alive(lease.pid)

    fgCount = count(FG leases)
    hasBg  = exists(BG lease)

    if fgCount == 0 and !hasBg:
      stopServerGracefully()          # impl-defined; uses child handle if spawned
      remove(state.json)
      exit(0)

    sleep(short)

⸻

14) Snapshot / Test Expectations

What the test harness should derive from disk + liveness:
	•	Kinds
	•	none: port not occupied AND no state.json.
	•	manual: port occupied AND no state.json.
	•	managed: state.json present and port occupied (treat as ours).
	•	Mode classification for managed
	•	managed_fg if state.json.mode === "foreground".
	•	managed_bg if state.json.mode === "background".
	•	Ephemeral (FG) lease count
	•	Number of lease files with:
	•	lease.mode:"foreground",
	•	lease.startedAt === state.startedAt,
	•	lease.pid liveness = alive.
	•	BG lease presence
	•	hasBgLease = exists lease with mode:"background" and startedAt === state.startedAt.