# Canisters

In ICE, Canisters are treated as specialized Tasks. When you define a canister, ICE generates a **Scope** containing lifecycle tasks.

## Defining a Canister

Use the `canister` builder facade to define canisters.

```typescript
import { canister } from "@ice.ts/runner";

export const backend = canister.motoko({
  src: "canisters/backend/main.mo"
}).make();
```

## Generated Tasks

Defining the canister above automatically creates the following tasks:

* `backend:build`: Compiles the Wasm.
* `backend:install`: Installs the canister (initial).
* `backend:deploy`: Smart deploy (handles install vs upgrade).
* `backend:status`: Checks if the canister is running.

## Arguments

You can define typed installation and upgrade arguments using the builder.

```typescript
export const backend = canister.motoko({ src: "..." })
  .installArgs(({ ctx }) => ({
     admin: ctx.users.default.principal
  }))
  .make();
```

## Canister Types

1.  **Motoko**: Compiles Motoko source code.
2.  **Rust**: Compiles Rust projects (requires `Cargo.toml`).
3.  **Custom**: Uses pre-compiled Wasm and Candid files.
4.  **Remote**: Connects to an existing canister on the network (useful for integration testing against live services).