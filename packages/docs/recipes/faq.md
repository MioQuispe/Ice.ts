# FAQ

### Where does ICE store its state?
ICE creates a `.ice` directory in your project root. This contains:
* `.ice/cache`: Wasm download cache.
* `.ice/state`: Replica state (if using PocketIC with persistence).

### Can I use `dfx` commands alongside ICE?
Yes. ICE does not interfere with `dfx`. However, if you are using `PICReplica` (PocketIC), `dfx` will not know about that local network. If you use `ICReplica` (connected to `http://localhost:8000`), you can interact with ICE-deployed canisters using `dfx canister call`.

### Why does my task fail with "Dependency not found"?
Ensure you have included the task in `.deps()` or `.dependsOn()`. ICE only executes tasks that are explicitly part of the dependency graph of the command you ran.