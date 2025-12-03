# Pre-built Canisters

ICE simplifies using standard canisters by providing batteries-included builders in `@ice.ts/canisters`.

## Internet Identity

```typescript
import { InternetIdentity } from "@ice.ts/canisters";

export const ii = InternetIdentity()
  .installArgs(({ ctx }) => InternetIdentity.makeArgs({
    assignedUserNumberRange: [0n, 1000n]
  }))
  .make();
```

## NNS (Governance, Registry, etc.)

Deploy a local version of the NNS for testing governance proposals.

```typescript
import { NNS } from "@ice.ts/canisters";

export const nns = NNS().make();
```