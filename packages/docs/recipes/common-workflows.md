# Common Workflows

## Minting Tokens

A classic workflow: Deploy a Ledger, then mint tokens to a specific user.

```typescript
import { ICRC1Ledger } from '@ice.ts/canisters';
import { task } from '@ice.ts/runner';

// 1. Define Ledger with initialization args
export const ledger = ICRC1Ledger()
  .installArgs(({ ctx }) => [{
    token_name: "My Token",
    token_symbol: "MTK",
    decimals: 8,
    initial_balances: [],
    minting_account: {
      owner: ctx.roles.minter.principal,
      subaccount: []
    },
    transfer_fee: 10_000n,
    metadata: [],
    feature_flags: [],
    maximum_number_of_accounts: [],
    accounts_overflow_trim_quantity: [],
    fee_collector_account: [],
    archive_options: {
      num_blocks_to_archive: 1000n,
      trigger_threshold: 2000n,
      max_message_size_bytes: [],
      cycles_for_archive_creation: [],
      node_max_memory_size_bytes: [],
      controller_id: ctx.roles.deployer.principal
    },
    max_memo_length: [],
  }])
  .make();

// 2. Mint Task - transfer tokens from minting account
export const mint_tokens = task("Mint Tokens")
  .deps({ ledger })
  .run(async ({ ctx, deps }) => {
    const { ledger } = deps;
    const recipient = ctx.users.default;
    
    const result = await ledger.actor.icrc1_transfer({
      to: {
        owner: recipient.principal,
        subaccount: []
      },
      amount: 100_000_000n, // 1 token with 8 decimals
      fee: [],
      memo: [],
      from_subaccount: [],
      created_at_time: []
    });
    
    if ('Err' in result) {
      throw new Error(`Transfer failed: ${JSON.stringify(result.Err)}`);
    }
    
    console.log(`Minted tokens! Block index: ${result.Ok}`);
    return result.Ok;
  })
  .make();
```

## Seeding a Database

Populate your backend with test data after deployment.

```typescript
import { canister, task } from '@ice.ts/runner';

// Assume backend is defined elsewhere
export const backend = canister.motoko({
  src: "canisters/backend/main.mo"
}).make();

export const seed_db = task("Seed Database")
  .deps({ backend })
  .run(async ({ deps }) => {
    const { backend } = deps;
    
    // Create multiple posts
    const posts = [
      { title: "Hello World", content: "Welcome to our platform!" },
      { title: "Getting Started", content: "Here's how to use the app." },
      { title: "Tips & Tricks", content: "Advanced features you should know." }
    ];
    
    for (const post of posts) {
      await backend.actor.create_post(post.title, post.content);
    }
    
    console.log(`Database seeded with ${posts.length} posts!`);
  })
  .make();
```

## Multi-Canister Deployment with Dependencies

Deploy multiple canisters where one depends on another.

```typescript
import { canister, task, Ice, PICReplica, Ids } from '@ice.ts/runner';

// Backend canister
export const backend = canister.motoko({
  src: "canisters/backend/main.mo"
}).make();

// App canister that depends on backend
export const app = canister.motoko({
  src: "canisters/app/main.mo"
})
  .deps({ backend })
  .installArgs(({ deps }) => [deps.backend.canisterId])
  .make();

// Deploy everything - dependencies are resolved automatically
export const deploy_all = task("Deploy All")
  .deps({ backend, app })
  .run(async ({ deps }) => {
    console.log(`Backend deployed: ${deps.backend.canisterId}`);
    console.log(`App deployed: ${deps.app.canisterId}`);
  })
  .make();
```

## Checking Canister Status

Query and display the status of deployed canisters.

```typescript
import { canister, task } from '@ice.ts/runner';

export const backend = canister.motoko({
  src: "canisters/backend/main.mo"
}).make();

export const check_status = task("Check Status")
  .deps({ backend })
  .run(async ({ ctx, deps }) => {
    const { canisterId } = deps.backend;
    
    const status = await ctx.replica.getCanisterStatus({
      canisterId,
      identity: ctx.roles.deployer.identity
    });
    
    console.log(`Canister ${canisterId} status: ${status}`);
    return status;
  })
  .make();
```

## Running Tasks Programmatically

Run other tasks from within a task.

```typescript
import { task } from '@ice.ts/runner';

export const greet = task("Greet")
  .params({ name: { type: "string" } })
  .run(async ({ ctx }) => {
    console.log(`Hello, ${ctx.args.name}!`);
    return ctx.args.name;
  })
  .make();

export const greet_everyone = task("Greet Everyone")
  .run(async ({ ctx }) => {
    // Run the greet task with different arguments
    await ctx.runTask(greet, { name: "Alice" });
    await ctx.runTask(greet, { name: "Bob" });
    await ctx.runTask(greet, { name: "Charlie" });
    
    console.log("Greeted everyone!");
  })
  .make();
```
