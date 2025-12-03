# Common Errors

### `Connection Refused`
**Cause:** The replica is not running or the port in `ice.config.ts` does not match.
**Fix:** If using `ICReplica`, ensure `dfx start` is running. If using `PICReplica`, ICE should start it automatically, but check for port conflicts.

### `Canister not found` in Task
**Cause:** You are trying to access `deps.my_canister` but did not declare it in `.deps()`.
**Fix:** Add `.deps({ my_canister })` to your task builder.

### `Type Mismatch` in Arguments
**Cause:** TypeScript validation failed for canister arguments.
**Fix:** Check the `installArgs` in your canister definition. ICE uses the Candid interface to validate inputs.