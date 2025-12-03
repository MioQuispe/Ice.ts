/**
 * Complete API documentation for `@ice.ts/runner`.
 *
 * - **Essentials** — Core functions: `task()`, `scope()`, `Ice()`, `canister`, and the `TaskCtx` execution context.
 * - **Canister Definitions** — Builders and configs for Motoko, Rust, Custom, and Remote canisters.
 * - **Config & Environment** — Configuration types, replica interfaces, and identity utilities.
 *
 * @module
 */

// Re-export everything from the main index
export * from "./index.js"

// Override specific exports with documentation-friendly types
import type { TaskTree, Task, ICEUser, Scope } from "./types/types.js"
import type { Replica } from "./services/replica.js"
import type { CanisterIds } from "./services/canisterIds.js"
import type { Deployment } from "./services/deployments.js"
import type { ConfirmOptions } from "@clack/prompts"

// ============================================================================
// CANISTER BUILDERS - Simplified documentation interfaces
// ============================================================================

/**
 * Configuration for a Motoko canister.
 * @group Canister Definitions
 */
export interface MotokoCanisterConfig {
	/**
	 * Path to the main Motoko source file (e.g. "canisters/main.mo").
	 */
	src: string
	/**
	 * Optional specific canister ID. If not provided, one will be generated/managed automatically.
	 */
	canisterId?: string
	/**
	 * Initial canister settings (cycles, controllers, etc.).
	 */
	settings?: CanisterSettings
}

/**
 * Configuration for a Rust canister.
 * @group Canister Definitions
 */
export interface RustCanisterConfig {
	/**
	 * Path to the Rust crate directory containing Cargo.toml.
	 */
	src: string
	/**
	 * Path to the Candid interface file (.did).
	 */
	candid: string
	/**
	 * Optional specific canister ID.
	 */
	canisterId?: string
	/**
	 * Initial canister settings.
	 */
	settings?: CanisterSettings
}

/**
 * Configuration for a Custom (pre-compiled Wasm) canister.
 * @group Canister Definitions
 */
export interface CustomCanisterConfig {
	/**
	 * Path to the pre-compiled Wasm file.
	 */
	wasm: string
	/**
	 * Path to the Candid interface file (.did).
	 */
	candid: string
	/**
	 * Optional specific canister ID.
	 */
	canisterId?: string
	/**
	 * Initial canister settings.
	 */
	settings?: CanisterSettings
}

/**
 * Configuration for a Remote canister (already deployed elsewhere).
 * @group Canister Definitions
 */
export interface RemoteCanisterConfig {
	/**
	 * The canister ID of the remote canister.
	 */
	canisterId: string
	/**
	 * Path to the Candid interface file (.did).
	 */
	candid: string
}

/**
 * Settings for creating or updating a canister.
 * Used in {@link CreateCanisterParams} and canister configurations.
 *
 * @example
 * ```typescript
 * const settings: CanisterSettings = {
 *   controllers: ["aaaaa-aa", "bbbbb-bb"],
 *   compute_allocation: 10n,
 *   memory_allocation: 1_000_000_000n,
 *   freezing_threshold: 2_592_000n, // 30 days
 * }
 * ```
 *
 * @group Config & Environment
 */
export interface CanisterSettings {
	/** Array of principal IDs that can control this canister. */
	controllers?: string[]
	/** Freezing threshold in seconds. Canister freezes if cycles drop below this. */
	freezing_threshold?: bigint
	/** Memory allocation in bytes. Reserves memory for the canister. */
	memory_allocation?: bigint
	/** Compute allocation percentage (0-100). Higher means more execution priority. */
	compute_allocation?: bigint
	/** Maximum reserved cycles limit. */
	reserved_cycles_limit?: bigint
	/** Maximum Wasm memory limit in bytes. */
	wasm_memory_limit?: bigint
	/** Initial cycles to add to the canister. */
	cycles?: bigint
}

// ============================================================================
// TASK PARAMETER TYPES
// ============================================================================

/**
 * Built-in parameter types that can be used without a schema.
 * @group Essentials
 */
export type BuiltInTaskType = "string" | "number" | "boolean"

/**
 * Base interface for task parameters.
 * Parameters define the inputs a task can accept from the CLI or programmatically.
 *
 * @example
 * ```typescript
 * task("greet")
 *   .params({
 *     name: { type: "string", description: "Who to greet" },
 *     count: { type: "number", default: 1 }
 *   })
 *   .run(async ({ args }) => {
 *     for (let i = 0; i < args.count; i++) {
 *       console.log(`Hello, ${args.name}!`)
 *     }
 *   })
 *   .make()
 * ```
 *
 * @group Essentials
 */
export interface TaskParam {
	/** The type or schema for validation and parsing. */
	type: BuiltInTaskType | object
	/** The parameter name (used in CLI as --name or positionally). */
	name: string
	/** Human-readable description for help text. */
	description?: string
	/** Default value if not provided. */
	default?: unknown
	/** Whether this parameter is optional. */
	isOptional: boolean
	/** Whether this parameter accepts multiple values. */
	isVariadic: boolean
}

/**
 * A named parameter (flag) for a task.
 * Named parameters are passed as `--name value` or `-n value` on the CLI.
 *
 * @example
 * ```typescript
 * task("greet")
 *   .params({
 *     name: { type: "string", description: "Who to greet" },
 *     loud: { type: "boolean", default: false }
 *   })
 * // CLI: ice run greet --name Alice --loud
 * ```
 *
 * @group Essentials
 */
export interface NamedParam extends TaskParam {
	/** Alternative short names (e.g., `-n` for `--name`). */
	aliases?: string[]
	/** Always true for named parameters. */
	isFlag: true
}

/**
 * A positional parameter for a task.
 * Positional parameters are passed in order without flags on the CLI.
 *
 * @example
 * ```typescript
 * task("copy")
 *   .params({
 *     source: { type: "string", isPositional: true },
 *     dest: { type: "string", isPositional: true }
 *   })
 * // CLI: ice run copy ./src ./dest
 * ```
 *
 * @group Essentials
 */
export interface PositionalParam extends TaskParam {
	/** Always false for positional parameters. */
	isFlag: false
}

/**
 * A builder for defining ICE tasks with typed parameters, dependencies, and execution logic.
 *
 * Use the {@link task} function to create a TaskBuilder instance.
 *
 * @example
 * ```typescript
 * import { task } from "@ice.ts/runner"
 *
 * export const greet = task("greet")
 *   .params({
 *     name: { type: "string", default: "World" }
 *   })
 *   .run(async ({ args }) => {
 *     console.log(`Hello, ${args.name}!`)
 *   })
 *   .make()
 * ```
 *
 * @group Essentials
 */
export interface TaskBuilder {
	/**
	 * Defines the parameters that this task accepts.
	 * @param params - An object defining the parameters.
	 * @returns The builder for chaining.
	 */
	params(params: Record<string, object>): TaskBuilder

	/**
	 * Declares dependencies on other tasks or canisters.
	 * Dependencies are executed before this task and their results are available in `run`.
	 * @param deps - Record of tasks or canister scopes.
	 * @returns The builder for chaining.
	 */
	deps(deps: Record<string, Scope | Task>): TaskBuilder

	/**
	 * Declares the execution dependencies required by this task.
	 * Used primarily by third-party tasks to declare what must be provided.
	 * @param deps - Record of required dependency shapes.
	 * @returns The builder for chaining.
	 * @internal
	 */
	dependsOn(deps: Record<string, Scope | Task>): TaskBuilder

	/**
	 * Defines the execution logic for the task.
	 * @param fn - The async function to execute.
	 * @returns The builder for chaining.
	 */
	run(fn: (ctx: TaskCtx) => Promise<unknown>): TaskBuilder

	/**
	 * Finalizes and creates the Task.
	 * @returns The configured Task.
	 */
	make(): Task
}

/**
 * A builder for configuring Motoko canisters.
 * Provides a fluent API to set installation arguments, upgrade arguments, and dependencies.
 *
 * ## Configuration
 *
 * Pass a {@link MotokoCanisterConfig} to `canister.motoko()`:
 *
 * | Property | Type | Description |
 * |----------|------|-------------|
 * | `src` | `string` | Path to the main Motoko source file |
 * | `canisterId` | `string?` | Optional specific canister ID |
 * | `settings` | `CanisterSettings?` | Initial canister settings |
 *
 * @example
 * ```typescript
 * export const backend = canister.motoko({
 *   src: "canisters/backend/main.mo"
 * }).installArgs(({ ctx }) => [])
 *   .make()
 * ```
 *
 * @group Canister Definitions
 */
export interface MotokoCanisterBuilder {
	/**
	 * Override the canister's service type for typed actor calls.
	 * @typeParam T - The service interface type.
	 * @returns The builder for chaining.
	 */
	as<T>(): MotokoCanisterBuilder

	/**
	 * Set the canister installation arguments.
	 * Accepts a plain value, a sync function, or an async function.
	 *
	 * @param argsOrFn - The install arguments, or a function that returns them.
	 * @returns The builder for chaining.
	 *
	 * @example
	 * ```typescript
	 * // Plain value
	 * canister.motoko({ src: "main.mo" })
	 *   .installArgs([])
	 *   .make()
	 *
	 * // Function with context
	 * canister.motoko({ src: "main.mo" })
	 *   .installArgs(({ ctx }) => [ctx.roles.deployer.principal])
	 *   .make()
	 *
	 * // Async function
	 * canister.motoko({ src: "main.mo" })
	 *   .installArgs(async ({ ctx }) => {
	 *     const data = await fetchSomeData()
	 *     return [data]
	 *   })
	 *   .make()
	 * ```
	 */
	installArgs(argsOrFn: unknown[] | ((args: { ctx: TaskCtx; deps: Record<string, string> }) => unknown[] | Promise<unknown[]>)): MotokoCanisterBuilder

	/**
	 * Set the canister upgrade arguments.
	 * Accepts a plain value, a sync function, or an async function.
	 *
	 * @param argsOrFn - The upgrade arguments, or a function that returns them.
	 * @returns The builder for chaining.
	 */
	upgradeArgs(argsOrFn: unknown[] | ((args: { ctx: TaskCtx; deps: Record<string, string> }) => unknown[] | Promise<unknown[]>)): MotokoCanisterBuilder

	/**
	 * Declare dependencies on other canisters or tasks.
	 * Dependencies are executed before this canister and their results are available in `installArgs`.
	 *
	 * - **CanisterScope**: Uses its `deploy` task. Result contains `{ canisterId, actor }`.
	 * - **Task**: Uses the task directly. Result is whatever the task returns.
	 *
	 * @param deps - Record of canister scopes or tasks this canister depends on.
	 * @returns The builder for chaining.
	 *
	 * @example
	 * ```typescript
	 * // Depending on a canister
	 * export const app = canister.motoko({ src: "app/main.mo" })
	 *   .deps({ ledger })
	 *   .installArgs(({ deps }) => [deps.ledger.canisterId])
	 *   .make()
	 *
	 * // Depending on a task
	 * const fetchConfig = task("Fetch Config")
	 *   .run(async () => ({ adminId: "aaaaa-aa" }))
	 *   .make()
	 *
	 * export const backend = canister.motoko({ src: "backend/main.mo" })
	 *   .deps({ fetchConfig })
	 *   .installArgs(({ deps }) => [deps.fetchConfig.adminId])
	 *   .make()
	 * ```
	 */
	deps<D extends Record<string, Scope | Task>>(deps: D): MotokoCanisterBuilder

	/**
	 * Type-level declaration of required dependency shape.
	 * Used by third-party canisters to declare dependencies that users must provide.
	 * For regular use, prefer `.deps()` instead.
	 * @internal
	 */
	dependsOn<D extends Record<string, Scope | Task>>(deps: D): MotokoCanisterBuilder

	/**
	 * Finalize and create the canister scope.
	 * @returns The canister scope with all configured tasks (deploy, build, install, etc.).
	 */
	make(): MotokoCanisterScope
}

/**
 * A builder for configuring Rust canisters.
 * Provides a fluent API to set installation arguments, upgrade arguments, and dependencies.
 *
 * ## Configuration
 *
 * Pass a {@link RustCanisterConfig} to `canister.rust()`:
 *
 * | Property | Type | Description |
 * |----------|------|-------------|
 * | `src` | `string` | Path to the Rust crate directory |
 * | `candid` | `string` | Path to the Candid interface file |
 * | `canisterId` | `string?` | Optional specific canister ID |
 * | `settings` | `CanisterSettings?` | Initial canister settings |
 *
 * @example
 * ```typescript
 * export const ledger = canister.rust({
 *   src: "canisters/ledger",
 *   candid: "canisters/ledger.did"
 * }).make()
 * ```
 *
 * @group Canister Definitions
 */
export interface RustCanisterBuilder {
	/**
	 * Override the canister's service type for typed actor calls.
	 * @typeParam T - The service interface type.
	 * @returns The builder for chaining.
	 */
	as<T>(): RustCanisterBuilder

	/**
	 * Set the canister installation arguments.
	 * Accepts a plain value, a sync function, or an async function.
	 *
	 * @param argsOrFn - The install arguments, or a function that returns them.
	 * @returns The builder for chaining.
	 */
	installArgs(argsOrFn: unknown[] | ((args: { ctx: TaskCtx; deps: Record<string, string> }) => unknown[] | Promise<unknown[]>)): RustCanisterBuilder

	/**
	 * Set the canister upgrade arguments.
	 * Accepts a plain value, a sync function, or an async function.
	 *
	 * @param argsOrFn - The upgrade arguments, or a function that returns them.
	 * @returns The builder for chaining.
	 */
	upgradeArgs(argsOrFn: unknown[] | ((args: { ctx: TaskCtx; deps: Record<string, string> }) => unknown[] | Promise<unknown[]>)): RustCanisterBuilder

	/**
	 * Declare dependencies on other canisters or tasks.
	 * Dependencies are executed before this canister and their results are available in `installArgs`.
	 *
	 * - **CanisterScope**: Uses its `deploy` task. Result contains `{ canisterId, actor }`.
	 * - **Task**: Uses the task directly. Result is whatever the task returns.
	 *
	 * @param deps - Record of canister scopes or tasks this canister depends on.
	 * @returns The builder for chaining.
	 */
	deps<D extends Record<string, Scope | Task>>(deps: D): RustCanisterBuilder

	/**
	 * Type-level declaration of required dependency shape. For regular use, prefer `.deps()`.
	 * @internal
	 */
	dependsOn<D extends Record<string, Scope | Task>>(deps: D): RustCanisterBuilder

	/**
	 * Finalize and create the canister scope.
	 * @returns The canister scope with all configured tasks (deploy, build, install, etc.).
	 */
	make(): RustCanisterScope
}

/**
 * A builder for configuring Custom (pre-compiled Wasm) canisters.
 * Provides a fluent API to set installation arguments, upgrade arguments, and dependencies.
 *
 * ## Configuration
 *
 * Pass a {@link CustomCanisterConfig} to `canister.custom()`:
 *
 * | Property | Type | Description |
 * |----------|------|-------------|
 * | `wasm` | `string` | Path to the pre-compiled Wasm file |
 * | `candid` | `string` | Path to the Candid interface file |
 * | `canisterId` | `string?` | Optional specific canister ID |
 * | `settings` | `CanisterSettings?` | Initial canister settings |
 *
 * @example
 * ```typescript
 * export const token = canister.custom({
 *   wasm: "canisters/token.wasm",
 *   candid: "canisters/token.did"
 * }).make()
 * ```
 *
 * @group Canister Definitions
 */
export interface CustomCanisterBuilder {
	/**
	 * Override the canister's service type for typed actor calls.
	 * @typeParam T - The service interface type.
	 * @returns The builder for chaining.
	 */
	as<T>(): CustomCanisterBuilder

	/**
	 * Set the canister installation arguments.
	 * Accepts a plain value, a sync function, or an async function.
	 *
	 * @param argsOrFn - The install arguments, or a function that returns them.
	 * @returns The builder for chaining.
	 */
	installArgs(argsOrFn: unknown[] | ((args: { ctx: TaskCtx; deps: Record<string, string> }) => unknown[] | Promise<unknown[]>)): CustomCanisterBuilder

	/**
	 * Set the canister upgrade arguments.
	 * Accepts a plain value, a sync function, or an async function.
	 *
	 * @param argsOrFn - The upgrade arguments, or a function that returns them.
	 * @returns The builder for chaining.
	 */
	upgradeArgs(argsOrFn: unknown[] | ((args: { ctx: TaskCtx; deps: Record<string, string> }) => unknown[] | Promise<unknown[]>)): CustomCanisterBuilder

	/**
	 * Declare dependencies on other canisters or tasks.
	 * Dependencies are executed before this canister and their results are available in `installArgs`.
	 *
	 * - **CanisterScope**: Uses its `deploy` task. Result contains `{ canisterId, actor }`.
	 * - **Task**: Uses the task directly. Result is whatever the task returns.
	 *
	 * @param deps - Record of canister scopes or tasks this canister depends on.
	 * @returns The builder for chaining.
	 */
	deps<D extends Record<string, Scope | Task>>(deps: D): CustomCanisterBuilder

	/**
	 * Type-level declaration of required dependency shape. For regular use, prefer `.deps()`.
	 * @internal
	 */
	dependsOn<D extends Record<string, Scope | Task>>(deps: D): CustomCanisterBuilder

	/**
	 * Finalize and create the canister scope.
	 * @returns The canister scope with all configured tasks (deploy, build, install, etc.).
	 */
	make(): CustomCanisterScope
}

/**
 * A builder for configuring Remote canisters (already deployed elsewhere).
 * Use this to reference canisters that are deployed on mainnet or another network.
 *
 * ## Configuration
 *
 * Pass a {@link RemoteCanisterConfig} to `canister.remote()`:
 *
 * | Property | Type | Description |
 * |----------|------|-------------|
 * | `canisterId` | `string` | The canister ID of the remote canister |
 * | `candid` | `string` | Path to the Candid interface file |
 *
 * @example
 * ```typescript
 * export const nns = canister.remote({
 *   canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
 *   candid: "nns.did"
 * }).make()
 * ```
 *
 * @group Canister Definitions
 */
export interface RemoteCanisterBuilder {
	/**
	 * Override the canister's service type for typed actor calls.
	 * @typeParam T - The service interface type.
	 * @returns The builder for chaining.
	 */
	as<T>(): RemoteCanisterBuilder

	/**
	 * Finalize and create the canister scope.
	 * @returns The canister scope with the remote reference.
	 */
	make(): RemoteCanisterScope
}

// ============================================================================
// CANISTER SCOPES - Simplified documentation interfaces
// ============================================================================

/**
 * A Motoko canister scope containing all available tasks.
 * Created by calling `.make()` on a {@link MotokoCanisterBuilder}.
 *
 * ## Available Tasks
 *
 * | Task | Description |
 * |------|-------------|
 * | `deploy` | Smart deployment: creates, builds, and installs in one step |
 * | `build` | Compiles the Motoko source to Wasm |
 * | `install` | Installs or upgrades the Wasm code |
 * | `create` | Creates the canister on the replica |
 * | `bindings` | Generates TypeScript/JavaScript bindings |
 * | `status` | Returns the current canister status |
 * | `stop` | Stops the canister |
 * | `remove` | Removes/deletes the canister |
 *
 * @example
 * ```typescript
 * // Run a specific task
 * await ctx.runTask(backend.children.deploy)
 *
 * // Access task results
 * const result = await ctx.runTask(backend.children.build)
 * ```
 *
 * @group Canister Definitions
 */
export interface MotokoCanisterScope {
	_tag: "scope"
	children: {
		/** Smart deployment: creates, builds, and installs in one step. */
		deploy: Task
		/** Compiles the Motoko source to Wasm. */
		build: Task
		/** Installs or upgrades the Wasm code on the canister. */
		install: Task
		/** Creates the canister on the replica (allocates canister ID). */
		create: Task
		/** Generates TypeScript/JavaScript bindings from the Candid file. */
		bindings: Task
		/** Returns the current canister status (running, stopped, etc.). */
		status: Task
		/** Stops the canister. */
		stop: Task
		/** Removes/deletes the canister from the replica. */
		remove: Task
		/** Returns the canister configuration. */
		config: Task
		/** Computes and returns the install arguments. */
		install_args: Task
	}
}

/**
 * A Rust canister scope containing all available tasks.
 * Created by calling `.make()` on a {@link RustCanisterBuilder}.
 *
 * @group Canister Definitions
 */
export interface RustCanisterScope {
	_tag: "scope"
	children: {
		/** Smart deployment: creates, builds, and installs in one step. */
		deploy: Task
		/** Compiles the Rust crate to Wasm using cargo. */
		build: Task
		/** Installs or upgrades the Wasm code on the canister. */
		install: Task
		/** Creates the canister on the replica (allocates canister ID). */
		create: Task
		/** Generates TypeScript/JavaScript bindings from the Candid file. */
		bindings: Task
		/** Returns the current canister status (running, stopped, etc.). */
		status: Task
		/** Stops the canister. */
		stop: Task
		/** Removes/deletes the canister from the replica. */
		remove: Task
		/** Returns the canister configuration. */
		config: Task
		/** Computes and returns the install arguments. */
		install_args: Task
	}
}

/**
 * A Custom (pre-compiled Wasm) canister scope containing all available tasks.
 * Created by calling `.make()` on a {@link CustomCanisterBuilder}.
 *
 * @group Canister Definitions
 */
export interface CustomCanisterScope {
	_tag: "scope"
	children: {
		/** Smart deployment: creates and installs in one step. */
		deploy: Task
		/** Validates the Wasm file exists (no compilation needed). */
		build: Task
		/** Installs or upgrades the Wasm code on the canister. */
		install: Task
		/** Creates the canister on the replica (allocates canister ID). */
		create: Task
		/** Generates TypeScript/JavaScript bindings from the Candid file. */
		bindings: Task
		/** Returns the current canister status (running, stopped, etc.). */
		status: Task
		/** Stops the canister. */
		stop: Task
		/** Removes/deletes the canister from the replica. */
		remove: Task
		/** Returns the canister configuration. */
		config: Task
		/** Computes and returns the install arguments. */
		install_args: Task
	}
}

/**
 * A Remote canister scope for canisters already deployed elsewhere.
 * Created by calling `.make()` on a {@link RemoteCanisterBuilder}.
 *
 * @group Canister Definitions
 */
export interface RemoteCanisterScope {
	_tag: "scope"
	children: {
		/** Resolves the canister ID and creates an actor for interaction. */
		deploy: Task
	}
}

// ============================================================================
// CANISTER FACTORY
// ============================================================================

/*
 * The entrypoint for defining canisters in your ICE configuration.
 * Provides factory methods to create builders for different canister types.
 *
 * ## Available Builders
 *
 * | Method | Description |
 * |--------|-------------|
 * | `canister.motoko(config)` | Create a Motoko canister from source |
 * | `canister.rust(config)` | Create a Rust canister from source |
 * | `canister.custom(config)` | Create a canister from pre-compiled Wasm |
 * | `canister.remote(config)` | Reference an already-deployed canister |
 *
 * @example
 * ```typescript
 * import { canister } from "@ice.ts/runner"
 *
 * // Motoko canister
 * export const backend = canister.motoko({
 *   src: "canisters/backend/main.mo"
 * }).make()
 *
 * // Rust canister
 * export const ledger = canister.rust({
 *   src: "canisters/ledger",
 *   candid: "canisters/ledger.did"
 * }).make()
 *
 * // Custom canister (pre-compiled)
 * export const token = canister.custom({
 *   wasm: "canisters/token.wasm",
 *   candid: "canisters/token.did"
 * }).make()
 *
 * // Remote canister
 * export const nns = canister.remote({
 *   canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
 *   candid: "nns.did"
 * }).make()
 * ```
 *
 * @group Essentials
 */
export declare const canister: {
	/**
	 * Creates a builder for Motoko canisters.
	 * @param config - The Motoko canister configuration.
	 * @see {@link MotokoCanisterBuilder} for builder methods.
	 * @see {@link MotokoCanisterConfig} for configuration options.
	 */
	motoko(config: MotokoCanisterConfig): MotokoCanisterBuilder

	/**
	 * Creates a builder for Rust canisters.
	 * @param config - The Rust canister configuration.
	 * @see {@link RustCanisterBuilder} for builder methods.
	 * @see {@link RustCanisterConfig} for configuration options.
	 */
	rust(config: RustCanisterConfig): RustCanisterBuilder

	/**
	 * Creates a builder for Custom (pre-compiled Wasm) canisters.
	 * @param config - The custom canister configuration.
	 * @see {@link CustomCanisterBuilder} for builder methods.
	 * @see {@link CustomCanisterConfig} for configuration options.
	 */
	custom(config: CustomCanisterConfig): CustomCanisterBuilder

	/**
	 * Creates a builder for Remote canisters.
	 * @param config - The remote canister configuration.
	 * @see {@link RemoteCanisterBuilder} for builder methods.
	 * @see {@link RemoteCanisterConfig} for configuration options.
	 */
	remote(config: RemoteCanisterConfig): RemoteCanisterBuilder
}

// ============================================================================
// TASK CONTEXT - Flattened for documentation
// ============================================================================

/**
 * The execution context passed to every task's `run` function and canister builder hooks.
 * Provides access to configuration, users, roles, replica, and utilities for orchestrating tasks.
 *
 * @example
 * **Accessing TaskCtx in a task:**
 * ```typescript
 * import { task } from "@ice.ts/runner"
 *
 * export const deploy = task()
 *   .run(async (ctx) => {
 *     // Access network and replica
 *     console.log(`Deploying to ${ctx.network}`)
 *
 *     // Access configured users and roles
 *     const deployer = ctx.roles.deployer
 *     console.log(`Deployer principal: ${deployer.principal}`)
 *
 *     // Access paths
 *     console.log(`App directory: ${ctx.appDir}`)
 *   })
 *   .make()
 * ```
 *
 * @example
 * **Accessing TaskCtx in canister installArgs:**
 * ```typescript
 * import { canister } from "@ice.ts/runner"
 *
 * export const backend = canister.motoko({
 *   src: "canisters/backend/main.mo"
 * }).installArgs(({ ctx }) => {
 *   // Use roles to set the admin
 *   const admin = ctx.roles.deployer.principal
 *   return [admin]
 * }).make()
 * ```
 *
 * @group Essentials
 */
export interface TaskCtx {
	// ---- From InitializedICEConfig ----

	/**
	 * The configured users/identities available in this environment.
	 * Keys are user names, values are ICEUser objects with identity, principal, and accountId.
	 */
	readonly users: Record<string, ICEUser>

	/**
	 * The resolved roles mapped to their corresponding ICEUser.
	 * Common roles: "deployer", "minter", "controller", "treasury".
	 */
	readonly roles: Record<string, ICEUser>

	// ---- Network & Replica ----

	/**
	 * The logical name of the current network (e.g. "local", "ic", "staging").
	 */
	readonly network: string

	/**
	 * The replica instance to interact with (PocketIC or IC mainnet).
	 */
	readonly replica: Replica

	// ---- Task Tree ----

	/**
	 * The full tree of tasks and scopes defined in the config.
	 */
	readonly taskTree: TaskTree

	/**
	 * Helper to run another task from within a task.
	 * Automatically handles dependencies and caching.
	 *
	 * @typeParam T - The task type being run.
	 * @param task - The task to run.
	 * @param args - Optional arguments to pass to the task.
	 * @returns A promise resolving to the task's return value.
	 *
	 * @example
	 * **Running a task without arguments:**
	 * ```typescript
	 * export const deployAll = task()
	 *   .run(async (ctx) => {
	 *     // Run the backend deploy task
	 *     const result = await ctx.runTask(backend.children.deploy)
	 *     console.log(`Deployed to: ${result.canisterId}`)
	 *   })
	 *   .make()
	 * ```
	 *
	 * @example
	 * **Running a task with arguments:**
	 * ```typescript
	 * export const greet = task()
	 *   .params({ name: { type: "string" } })
	 *   .run(async (ctx) => {
	 *     console.log(`Hello, ${ctx.args.name}!`)
	 *   })
	 *   .make()
	 *
	 * export const greetEveryone = task()
	 *   .run(async (ctx) => {
	 *     await ctx.runTask(greet, { name: "Alice" })
	 *     await ctx.runTask(greet, { name: "Bob" })
	 *   })
	 *   .make()
	 * ```
	 */
	readonly runTask: {
		<T extends Task>(task: T): Promise<TaskResult<T>>
		<T extends Task>(task: T, args: Record<string, unknown>): Promise<TaskResult<T>>
	}

	// ---- Current Task Info ----

	/**
	 * The parsed arguments for the current task.
	 */
	readonly args: Record<string, unknown>

	/**
	 * The logical path of the current task (e.g. "backend:deploy").
	 */
	readonly taskPath: string

	/**
	 * Results of dependency tasks that have already run.
	 */
	readonly depResults: Record<string, { cacheKey?: string; result: unknown }>

	// ---- Paths ----

	/**
	 * Absolute path to the application root (where ice.config.ts lives).
	 */
	readonly appDir: string

	/**
	 * Absolute path to the .ice directory.
	 */
	readonly iceDir: string

	// ---- Logging ----

	/**
	 * The current log level.
	 */
	readonly logLevel: "debug" | "info" | "error"

	// ---- Deployments API ----

	/**
	 * API to manage deployment metadata.
	 */
	readonly deployments: {
		/**
		 * Retrieves deployment info for a canister on a specific network.
		 */
		get(canisterName: string, network: string): Promise<Deployment | undefined>
		/**
		 * Updates deployment info for a canister.
		 */
		set(params: {
			canisterName: string
			network: string
			deployment: Omit<Deployment, "id">
		}): Promise<void>
	}

	// ---- Canister IDs API ----

	/**
	 * API to manage canister IDs (canister_ids.json).
	 */
	readonly canisterIds: {
		/**
		 * Retrieves all canister IDs.
		 */
		getCanisterIds(): Promise<CanisterIds>
		/**
		 * Updates the canister ID for a specific canister and network.
		 */
		setCanisterId(params: {
			canisterName: string
			network: string
			canisterId: string
		}): Promise<void>
		/**
		 * Removes the canister ID for the given canister name.
		 */
		removeCanisterId(canisterName: string): Promise<void>
	}

	// ---- Prompts API ----

	/**
	 * Interactive prompts for user input.
	 */
	readonly prompts: {
		/**
		 * Shows a confirmation prompt.
		 */
		confirm(options: ConfirmOptions): Promise<boolean>
	}

	// ---- Origin ----

	/**
	 * Where the task was invoked from: "cli" or "extension".
	 */
	readonly origin: "extension" | "cli"
}

/**
 * The return type of a task execution.
 * @typeParam T - The task type.
 * @internal
 */
export type TaskResult<T extends Task> = T extends Task<infer A> ? A : never
