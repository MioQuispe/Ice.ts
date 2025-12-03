# Managing Identities

## Loading from Environment Variables

In CI/CD or production, you should pass private keys via environment variables.

```typescript
import { Ice, Ids } from "@ice.ts/runner";

export default Ice(async () => {
  // Use a helper to load from ENV or fallback to local file
  const deployer = process.env.DEPLOYER_PEM 
    ? await Ids.fromPem(process.env.DEPLOYER_PEM)
    : await Ids.fromPemFile("./secrets/deployer.pem");

  return {
    // ...
    users: { default: deployer }
  };
});
```

## Using Hardware Wallets / HSM

*Coming soon.*