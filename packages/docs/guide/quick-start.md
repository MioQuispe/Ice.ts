# Quick Start

ICE is a task runner and CLI tool designed to replace `dfx.json` scripts and Makefiles with composable TypeScript.

## Installation

Install the runner and the canisters package in your project:

```bash
npm i -S @ice.ts/runner @ice.ts/canisters
```

## Setup

Create an `ice.config.ts` file in your project root. This is the entry point for your environment configuration.

```typescript
import { Ice, PICReplica } from '@ice.ts/runner';

// The configuration wrapper
export default Ice(async (env) => {
  return {
    // 1. Define your network (logical name)
    network: 'local',

    // 2. Define the replica (PocketIC or Mainnet)
    replica: new PICReplica({ port: 8080 }),

    // 3. Define users/identities
    users: {
       // You can load these from PEM files or use default dfx identities
       default: { principal: "...", ... } 
    }
  };
});
```

## Your First Task

In the same file (or imported), define a task using the `task()` builder.

```typescript
import { task } from '@ice.ts/runner';

// Define the task
export const hello = task("My first task")
  .run(async ({ ctx }) => {
    console.log("Hello from ICE 🧊");
  })
  .make();
```

## Running Tasks

You can run tasks using the CLI:

```bash
# Run the specific task
npx ice run hello

# List all available tasks
npx ice
```

## VS Code Extension

For the best experience, install the [ICE VS Code Extension](https://marketplace.visualstudio.com/items?itemName=MioQuispe.vscode-ice-extension). It allows you to:
- Run tasks by clicking a "Run" button directly in your code.
- See execution results inline.