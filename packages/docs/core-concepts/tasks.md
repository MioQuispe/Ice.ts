# Tasks & Dependencies

Tasks are the fundamental unit of execution in ICE. A task is an atomic, asynchronous operation that can depend on other tasks.

## Anatomy of a Task

Tasks are created using the `task()` builder pattern.

```typescript
import { task } from "@ice.ts/runner";

export const mint = task("Mint tokens")
  // 1. Declare Dependencies
  .deps({ ledger: ledgerCanister })
  
  // 2. Execution Logic
  .run(async ({ ctx, deps }) => {
    const { ledger } = deps;
    console.log(`Minting on ledger: ${ledger.canisterId}`);
  })
  
  // 3. Finalize
  .make();
```

## Dependencies vs. `dependsOn`

ICE distinguishes between functional dependencies and execution order.

* **.deps()**: Declares a dependency that you need to *use* inside your task. The return value of the dependency is injected into `ctx.deps`.
* **.dependsOn()**: Declares that a task must run *before* this one, but you don't need its return value.

## Task Context (`ctx`)

The `ctx` object is passed to every task. It contains:

* `ctx.users`: The identities defined in your config.
* `ctx.replica`: The active connection to the IC or PocketIC.
* `ctx.roles`: Helper mapping for roles (e.g., `ctx.roles.deployer`).