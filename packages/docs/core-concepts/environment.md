# Environment & Identity

## Replicas

ICE supports two types of Replicas:

1.  **PICReplica (PocketIC):** A lightweight, fast, local replica for testing. It supports time manipulation and instant state resets.
2.  **ICReplica (Mainnet/dfx):** Connects to the real Internet Computer or a standard `dfx start` instance.

```typescript
// Local
replica: new PICReplica({ port: 8080 })

// Mainnet
replica: new ICReplica({ host: "[https://icp-api.io](https://icp-api.io)", isDev: false })
```

## Identities (`users`)

You define users in the config, and ICE ensures they are available in every task.

```typescript
import { Ids } from "@ice.ts/runner";

// ... inside config
users: {
  // From a PEM file
  deployer: await Ids.fromPem(process.env.DEPLOYER_PEM),
  
  // From local dfx identity
  alice: await Ids.fromDfx("alice")
}
```

These are accessible in tasks via `ctx.users.deployer`.