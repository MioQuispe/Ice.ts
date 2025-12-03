# Recipes & Patterns

## Minting Tokens (ICRC1)

Deploying a standard Ledger canister and minting tokens in a single workflow.

```typescript
import { ICRC1Ledger } from '@ice.ts/canisters';
import { task } from '@ice.ts/runner';

// 1. Define the Ledger Canister
export const ledger = ICRC1Ledger()
  .installArgs(({ ctx }) => ICRC1Ledger.makeArgs({
     name: "My Token",
     symbol: "ICE",
     minting_account: ctx.users.default.principal,
     initial_balances: [],
     transfer_fee: 100n,
  }))
  .make();

// 2. Create a Mint Task
export const mint = task("Mint tokens to self")
  .deps({ ledger }) // Ensure ledger is deployed first
  .run(async ({ ctx, deps }) => {
     const { ledger } = deps;
     
     // The actor is automatically typed!
     const blockIndex = await ledger.actor.icrc1_transfer({
        to: { owner: ctx.users.default.principal, subaccount: [] },
        amount: 100_000n,
        fee: [],
        memo: [],
        from_subaccount: [],
        created_at_time: []
     });
     
     console.log(`Minted at block: ${blockIndex}`);
  })
  .make();
```

## Using Pre-built Canisters

ICE includes "Batteries-included" configurations for popular ecosystem canisters.

```typescript
import { 
  InternetIdentity, 
  NNS, 
  CandidUI 
} from '@ice.ts/canisters';

// Just export them to use them
export const ii = InternetIdentity().make();
export const nns = NNS().make();
export const ui = CandidUI().make();
```

## Deploying a Custom Motoko Canister

```typescript
import { canister } from '@ice.ts/runner';

export const my_dapp = canister.motoko({
  src: "src/main.mo"
})
.installArgs(({ ctx }) => ({
  // Typed arguments for your specific canister
  admin: ctx.users.default.principal
}))
.make();
```