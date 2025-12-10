
# Ice.ts

Typescript-native tooling & deployments for the Internet Computer. A task runner like hardhat.

```bash
npm i -S @ice.ts/runner @ice.ts/canisters
````

![image](https://github.com/user-attachments/assets/90c9aaeb-8421-4595-bd29-89b046636dda)

## Why Ice?

- **Npm install canister**: Install & distribute canisters via npm, leverage the ecosystem of node.js in your tasks

- **Web2-style DX**: No global dependencies. Just `npm install` and run. Everything stays local to the project.

- **Convenient APIs**: Access to users & replica inside tasks via `ctx`. Access dependencies inside `installArgs()`.

- **Type-safe**:  No manual candid strings. Catch errors in your editor with full autocomplete for canister methods.

- **Composable**: Easily combine multiple project setups without conflicts. Just import like normally.

- **Simple yet Extensible**: A small but powerful API-surface. Easy to learn, yet fully programmable for more advanced use cases.

---

## Documentation
For full documentation, visit [ice-ts.github.io/docs](https://ice-ts.github.io/docs)

### Example repo
Clone this repo to try it out quickly [github.com/MioQuispe/ice-demo](https://github.com/MioQuispe/ice-demo)
## Quick Start

### 1. Install

```bash
npm i -S @ice.ts/runner @ice.ts/canisters
````

### 2\. Configure (`ice.config.ts`)

Create an `ice.config.ts` file. This is the entry point for your environment.

```typescript
import { Ice, PICReplica, Ids } from '@ice.ts/runner';

export default Ice(async () => ({
  network: 'local',
  replica: new PICReplica({ port: 8080 }),
  users: {
    // Optional, use an existing identity:
    default: await Ids.fromDfx("default"),
    // Or:
    // default: await Ids.fromPem("....")
  }
}));
```

### 3\. Define a Canister

Export your canister definitions using the builder API.

```typescript
import { canister } from '@ice.ts/runner';

export const backend = canister.motoko({
  src: 'canisters/backend/main.mo',
}).make();
```

### 4\. Run

Ice automatically generates lifecycle tasks (create, build, bindings, install...) for your exported canisters.

```bash
# Deploy a specific canister
npx ice run backend:deploy

# Or deploy everything
npx ice
```

-----

# Core Concepts

## Tasks

Tasks are the main building block of Ice. They are composable, type-safe and can depend on other tasks.

In this example, Ice ensures the `ledger` is deployed before running the minting logic.

```typescript
import { task } from "@ice.ts/runner";

export const mint_tokens = task("Mint tokens to admin")
  .deps({ ledger }) // Declare dependency
  .run(async ({ ctx, deps }) => {
     // deps.ledger is fully typed!
     const { ledger } = deps;
     
     const result = await ledger.actor.icrc1_transfer({
        to: { 
            owner: Principal.from(ctx.users.admin.principal), 
            subaccount: [] 
        },
        amount: 100_000n,
        // ... types are checked here
     });
     if ("Ok" in result) {
        console.log(`Minted at block: ${result.Ok}`);
     }
  }).make();
```

## Dependencies

Define inter-canister dependencies easily.

```typescript
import { canister } from "@ice.ts/runner";

// 1. The independent canister
export const ledger = canister.rust({ /* ... */ }).make();

// 2. The dependent canister
export const dex = canister.motoko({ src: "..." })
  .deps({ ledger }).make(); // Ensures ledger exists before dex deploys
```

## Typed Install & Upgrade Arguments

Stop wrangling manual Candid strings. Ice allows you to pass fully typed arguments based on your canister's interface.

```typescript
import { canister } from "@ice.ts/runner";

export const backend = canister.motoko({ src: "..." })
  .deps({ ledger })
  .installArgs(async ({ ctx, deps }) => {
     // TypeScript ensures you return the correct types
     return [
       ctx.users.admin.principal, // Arg 1: Admin
       deps.ledger.canisterId     // Arg 2: Ledger ID
     ];
  })
  .upgradeArgs(({ ctx, deps }) => [])
  .make();
```

## Context (`ctx`)

Every task receives a shared context containing the environment state.

```typescript
export const check_balance = task("Check Balance")
  .run(async ({ ctx }) => {
    // Access identities
    console.log(ctx.users.default.principal);
    console.log(ctx.users.default.accountId);
    
    // Interact with the Replica
    const status = 
        await ctx.replica.getCanisterStatus({ 
            canisterId: "some-principal", 
            identity: ctx.users.default.identity 
        });
    
    // Run other tasks dynamically
    await ctx.runTask(some_other_task);

    // and more...
  }).make();
```

## Scopes

Group tasks into namespaces for better organization.

```typescript
import { scope } from "@ice.ts/runner";
import { NNSDapp, NNSGovernance } from "@ice.ts/canisters";

export const nns = scope({
   dapp: NNSDapp().make(),
   governance: NNSGovernance().make(),
}).make();
```

Usage:

```bash
npx ice run nns:governance:deploy
```

-----

## Npm install canister

Use popular ecosystem canisters with a single line of code. Ice provides ready-to-use builders.

```typescript
import {
  InternetIdentity,
  ICRC1Ledger,
  NNS,
  NFID,
  CyclesWallet
} from "@ice.ts/canisters";

// Just export them to use them
export const ii = InternetIdentity().make();
export const ledger = ICRC1Ledger().installArgs(() => [
    // custom args, fully type-checked
]).make();
export const nfid = NFID().make();
```

-----

## 🔌 VS Code Extension

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=MioQuispe.vscode-ice-extension).

- **Inline CodeLens:** Quickly execute tasks directly from your source code.
- **Inline Results:** See execution output without switching context.
-----
![Kapture 2025-02-23 at 22 16 11](https://github.com/user-attachments/assets/66bfbea1-ca18-4b1e-8b91-a16bf37d7aea)


## Resources

  - [Discord](https://discord.gg/SdeC8PF69M)
  - [Twitter](https://twitter.com/antimaximal)
