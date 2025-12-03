import type {
	ICEConfig,
	ICEGlobalArgs,
} from "./types/types.js"

/**
 * Optional type wrapper, commonly used for Motoko optional values.
 * @internal
 */
export { Opt } from "./types/types.js"

/**
 * The entrypoint for defining canisters in your ICE configuration.
 * Provides a fluent API to configure Motoko, Rust, or Custom canisters.
 *
 * @returns A canister builder facade.
 *
 * @example
 * ```typescript
 * import { canister } from "@ice.ts/runner"
 *
 * // Define a Motoko canister
 * export const backend = canister.motoko({
 *   src: "canisters/backend/main.mo",
 * }).make()
 *
 * // Define a Rust canister
 * export const ledger = canister.rust({
 *   src: "canisters/ledger",
 *   candid: "canisters/ledger.did",
 * }).make()
 * ```
 *
 * @group Essentials
 */
export { canister } from "./builders/index.js"

/**
 * Creates a new task builder for defining automation scripts.
 * Tasks can have parameters, dependencies, and execution logic.
 *
 * @param name - Optional name for the task (useful for debugging).
 * @returns A {@link TaskBuilder} instance to configure the task.
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
export { task, TaskBuilder } from "./builders/index.js"

/**
 * Creates a logical grouping of tasks or canisters.
 * This is useful for organizing related functionality (e.g., `db.reset`, `db.seed`).
 *
 * @param tree - A record of tasks or other scopes.
 * @returns A {@link Scope} object containing the tree.
 *
 * @example
 * ```typescript
 * import { scope, task } from "@ice.ts/runner"
 *
 * export const db = scope({
 *   reset: task().run(() => console.log("Resetting...")).make(),
 *   seed: task().run(() => console.log("Seeding...")).make(),
 * })
 * // Usage via CLI: ice run db:reset
 * ```
 *
 * @group Essentials
 */
export { scope } from "./builders/index.js"

/**
 * @internal
 */
export type { CanisterScopeSimple } from "./builders/lib.js"
/**
 * @group Canister Definitions
 */
export type {
	CustomCanisterScope,
	CustomCanisterConfig,
	CustomCanisterBuilder,
} from "./builders/custom.js"
/**
 * @group Canister Definitions
 */
export type {
	MotokoCanisterBuilder,
	MotokoCanisterConfig,
	MotokoCanisterScope,
} from "./builders/motoko.js"
/**
 * @group Canister Definitions
 */
export type {
	RemoteCanisterScope,
	RemoteCanisterConfig,
	RemoteCanisterBuilder,
} from "./builders/remote.js"
/**
 * @group Canister Definitions
 */
export type {
	RustCanisterBuilder,
	RustCanisterConfig,
	RustCanisterScope,
} from "./builders/rust.js"

/**
 * Utilities for managing Internet Computer identities and principals.
 * Useful for loading PEM files and creating `ICEUser` objects.
 *
 * @example
 * ```typescript
 * import { Ids } from "@ice.ts/runner"
 * import fs from "node:fs/promises"
 *
 * const pem = await fs.readFile("./identity.pem", "utf8")
 * const user = await Ids.fromPem(pem)
 * ```
 *
 * @group Config & Environment
 */
export { Ids } from "./ids.js"

/**
 * @internal
 */
export type { InstallModes } from "./services/replica.js"
/**
 * Interface for module augmentation to extend TaskCtx with user-specific types.
 * @group Config & Environment
 */
export type { TaskCtxExtension } from "./services/taskRuntime.js"

/**
 * Deployment metadata for a canister.
 * @group Config & Environment
 */
export type { Deployment } from "./services/deployments.js"

/**
 * Represents a local PocketIC replica environment.
 * Used for fast local development and testing.
 *
 * @example
 * ```typescript
 * import { PICReplica } from "@ice.ts/runner"
 *
 * const pic = new PICReplica({
 *   host: "http://127.0.0.1",
 *   port: 8080,
 * })
 * ```
 *
 * @group Config & Environment
 */
export { PICReplica } from "./services/pic/pic.js"

/**
 * Represents a connection to the main Internet Computer network or a remote node.
 *
 * @example
 * ```typescript
 * import { ICReplica } from "@ice.ts/runner"
 *
 * const mainnet = new ICReplica({
 *   host: "https://icp-api.io",
 *   isDev: false,
 * })
 * ```
 *
 * @group Config & Environment
 */
export { ICReplica } from "./services/ic-replica.js"

/**
 * @hidden
 */
export { type StandardSchemaV1 } from "@standard-schema/spec"
export { type CreateInstanceOptions } from "@dfinity/pic"

// Export additional types for user configs
/**
 * @group Config & Environment
 */
export type {
	ICEConfig,
	ICEGlobalArgs,
	ICEEnvironment,
	TaskTree,
	TaskTreeNode,
	Scope,
	Task,
	ICEUser,
	InferIceConfig,
	IceTag,
} from "./types/types.js"

/**
 * Represents the interface for a replica (local or remote).
 * @group Config & Environment
 */
export type {
	Replica,
	InstallCodeParams,
	GetCanisterStatusParams,
	CreateCanisterParams,
	CreateActorParams,
	StopOptions,
	CanisterSettings,
} from "./services/replica.js"

/**
 * Task parameter types for defining CLI inputs.
 * @group Essentials
 */
export type {
	TaskParam,
	NamedParam,
	PositionalParam,
	BuiltInTaskType,
} from "./types/types.js"

/**
 * @internal
 */
export type { Principal } from "@dfinity/principal"
/**
 * @internal
 */
export type { Identity } from "@dfinity/agent"

// export const Ice = (
//     globalArgs: ICEGlobalArgs,
// ) => Promise<C> {
//     return async (globalArgs: ICEGlobalArgs) => {
//         const configResult =
//             typeof this.#config === "function"
//                 ? this.#config(globalArgs)
//                 : this.#config
//         const config =
//             configResult instanceof Promise
//                 ? await configResult
//                 : configResult
//
//         return { config, plugins: this.#plugins }
//     }
// }

/**
 * The primary configuration wrapper for an ICE environment.
 * In your `ice.config.ts`, you default export the result of calling this function.
 *
 * It allows you to define the network, replica connection, users (identities), and roles
 * available to your tasks and canisters.
 *
 * @template C - The generic type of the configuration object (automatically inferred).
 * @param configFn - A function (or object) that returns the {@link ICEConfig}.
 *                   Can be async to allow loading secrets or files.
 * @returns A function that resolves the configuration, used internally by the runner.
 *
 * @example
 * ```typescript
 * import { Ice, PICReplica, Ids } from "@ice.ts/runner"
 * import fs from "node:fs/promises"
 *
 * export default Ice(async (env) => {
 *   // Load an identity from a PEM file
 *   const pem = await fs.readFile("./admin.pem", "utf8")
 *   const admin = await Ids.fromPem(pem)
 *
 *   return {
 *     network: "local",
 *     replica: new PICReplica({ port: 8080 }),
 *     users: {
 *       admin
 *     },
 *     roles: {
 *       deployer: "admin"
 *     }
 *   }
 * })
 * ```
 *
 * @group Essentials
 */
export const Ice = <C extends ICEConfig>(
	configFn: (globalArgs: ICEGlobalArgs) => Promise<C> | C,
): IceConfigLoader<C> => {
	return async (globalArgs: ICEGlobalArgs) => {
		const configResult =
			typeof configFn === "function" ? configFn(globalArgs) : configFn
		const config =
			configResult instanceof Promise ? await configResult : configResult

		return config
	}
}

/**
 * The return type of the `Ice()` configuration wrapper.
 * A function that takes global arguments and returns a resolved configuration.
 * @group Config & Environment
 */
export type IceConfigLoader<C extends ICEConfig> = (
	globalArgs: ICEGlobalArgs,
) => Promise<C>
// TODO: figure out programmatic use & APIs
/**
 * Internal CLI runner entrypoint.
 * @internal
 */
export { runCli } from "./cli/index.js"
/**
 * The execution context passed to every task and canister hook.
 * Contains utilities for arguments, user access, and orchestrating other tasks.
 *
 * You can extend this interface via module augmentation to add typed users and roles.
 *
 * @example
 * ```typescript
 * // In your ice.config.ts or types.d.ts
 * declare module "@ice.ts/runner" {
 *   interface TaskCtxExtension extends InferIceConfig<typeof ice> {}
 * }
 * ```
 *
 * @group Essentials
 */
export type { TaskCtx } from "./services/taskRuntime.js"
