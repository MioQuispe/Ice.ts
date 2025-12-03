# CLI Reference

Usage: `ice [OPTIONS] [COMMAND]`

## Global Options

* `--config <path>`: Path to the config file (default: `ice.config.ts`).
* `--logLevel <level>`: Set logging verbosity (`debug`, `info`, `error`).
* `--background`: Run the replica in the background (if supported).

## Commands

### `run`
Executes a task or a scope.

```bash
npx ice run <task-name>
npx ice run backend:deploy
```

### `task`
Opens an interactive picker to select a task to run.

```bash
npx ice task
```

### `clean`
Removes the `.ice` cache directory and artifacts.

```bash
npx ice clean
```

### `stop`
Stops the running background replica (if using PocketIC).

```bash
npx ice stop
```