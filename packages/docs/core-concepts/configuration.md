# Configuration

The `ice.config.ts` file defines your environment.

## One Process = One Replica

Unlike generic tools that manage multiple networks in one file, ICE adheres to a strict mental model: **One Config File represents One Environment.**

* `ice.config.ts` → Local Development (PocketIC)
* `ice.config.ic.ts` → Mainnet Deployment

To switch environments, you use the `--config` flag:

```bash
npx ice --config ice.config.ic.ts run deploy_all
```

## The `Ice` Wrapper

The configuration must be wrapped in the `Ice` function. This can be asynchronous, allowing you to fetch secrets or read files before starting.

```typescript
import { Ice, PICReplica } from "@ice.ts/runner";

export default Ice(async () => {
  // Perform async work here
  const apiKey = process.env.API_KEY;

  return {
    network: "local",
    replica: new PICReplica({ port: 8080 }),
    // ...
  };
});
```