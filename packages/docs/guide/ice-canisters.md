# @ice/canisters

A collection of pre-configured, ready-to-deploy canisters for common Internet Computer use cases.

## Overview

`@ice/canisters` provides battle-tested canister configurations that integrate seamlessly with ICE. Instead of manually configuring complex canisters like ICRC-1 ledgers or NFT collections, simply import and customize them.

## Installation

```bash
npm install @ice/canisters
```

## Available Canisters

### ICRC-1 Ledger

A fully compliant ICRC-1 token ledger with support for transfers, approvals, and metadata.

```typescript
import { ICRC1Ledger } from "@ice/canisters"

export const ledger = ICRC1Ledger()
  .installArgs(({ ctx }) => ({
    token_name: "My Token",
    token_symbol: "MTK",
    minting_account: { owner: ctx.users.default.principal, subaccount: [] },
    initial_balances: [],
    transfer_fee: 10_000n,
    decimals: 8,
  }))
  .make()
```

### ICRC-7 NFT Collection

An ICRC-7 compliant NFT collection canister.

```typescript
import { ICRC7Collection } from "@ice/canisters"

export const nfts = ICRC7Collection()
  .installArgs(({ ctx }) => ({
    name: "My NFT Collection",
    symbol: "MNFT",
    minting_authority: ctx.users.default.principal,
  }))
  .make()
```

### Internet Identity

Local Internet Identity canister for authentication testing.

```typescript
import { InternetIdentity } from "@ice/canisters"

export const ii = InternetIdentity().make()
```

## Customization

All canisters from `@ice/canisters` return standard ICE canister builders, so you can use the full builder API:

```typescript
import { ICRC1Ledger } from "@ice/canisters"

export const ledger = ICRC1Ledger()
  .installArgs(({ ctx }) => ({ /* ... */ }))
  .deps({ someOtherCanister })
  .make()
```

## Links

- **npm**: [@ice/canisters](https://www.npmjs.com/package/@ice/canisters)
- **GitHub**: [MioQuispe/ICE - packages/canisters](https://github.com/MioQuispe/ICE/tree/main/packages/canisters)

