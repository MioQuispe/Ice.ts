import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Replica } from "../services/replica.js"
import { TaskCancelled } from "../builders/lib.js"
import { type TaskCtx } from "../services/taskRuntime.js"
import type { Identity } from "@icp-sdk/core/agent"

export type ReplicaConfig = {
	// TODO: use pocket-ic subnet config
	subnet: "system" | "application" | "verified_application"
	// type?: "ephemeral" | "persistent"
	bitcoin?: boolean
	canister_http?: boolean
	type: "pocketic" | "dfx"
}

/**
 * Represents a user identity in the ICE environment.
 * @group Config & Environment
 */
export type ICEUser = {
	/**
	 * The cryptographic identity (signer).
	 */
	identity: Identity
	/**
	 * The principal ID as a string (e.g. "aaaaa-aa").
	 */
	principal: string
	/**
	 * The account ID (hex string) derived from the principal.
	 */
	accountId: string
	// agent: Agent
}

export type ICEUsers = Record<string, ICEUser>

export type ICERoles<U extends ICEUsers = ICEUsers> = Record<string, keyof U> // or string, depending on how you normalize it

/**
 * The core configuration object for an ICE environment.
 *
 * @group Config & Environment
 */
export type ICEConfig<
	U extends ICEUsers = ICEUsers,
	R extends ICERoles<U> = ICERoles<U>,
> = {
	/**
	 * A logical name for the network (e.g. "local", "ic", "staging").
	 * Used for caching and state isolation.
	 */
	network: string
	/**
	 * The replica instance to connect to.
	 */
	replica?: Replica
	/**
	 * A map of named users/identities available in this environment.
	 */
	users?: U
	/**
	 * A map of role names to user keys.
	 * Common roles: "deployer", "minter", "controller", "treasury".
	 */
	roles?: R
}

export type ICEEnvironment = {
	config: ICEConfig
	tasks: TaskTree
}

/**
 * Built-in parameter types that can be used without a schema.
 * @group Essentials
 */
export type BuiltInTaskType = "string" | "number" | "boolean"

/**
 * Base interface for task parameters.
 * Parameters define the inputs a task can accept from the CLI or programmatically.
 *
 * @typeParam T - The type of the parameter value.
 * @typeParam O - Whether the parameter is optional.
 *
 * @group Essentials
 */
export interface TaskParam<T = unknown, O extends boolean = boolean> {
	/** The type or schema for validation and parsing. */
	type: StandardSchemaV1<T> | BuiltInTaskType
	/** The parameter name (used in CLI as --name or positionally). */
	name: string
	/** Human-readable description for help text. */
	description?: string
	/** Default value if not provided. */
	default?: T
	/** Function to decode CLI string input to the target type. */
	decode: (value: string) => T
	/** Whether this parameter is optional. */
	isOptional: O
	/** Whether this parameter accepts multiple values. */
	isVariadic: boolean
}

/**
 * Input format for defining task parameters before normalization.
 * @internal
 */
export interface InputTaskParam<T = unknown> {
	type: StandardSchemaV1<T> | BuiltInTaskType
	description?: string
	default?: T
	decode?: (value: string) => T
	isOptional?: boolean
	isVariadic?: boolean
	isPositional?: boolean
}

/**
 * @internal
 */
export interface InputNamedParam<T = unknown> extends InputTaskParam<T> {
	aliases?: Array<string>
}

/**
 * @internal
 */
export interface InputPositionalParam<T = unknown> extends InputTaskParam<T> {
	// Marker interface
}

/**
 * A named parameter (flag) for a task.
 * Named parameters are passed as `--name value` or `-n value` on the CLI.
 *
 * @typeParam T - The type of the parameter value.
 *
 * @example
 * ```typescript
 * task("greet")
 *   .params({
 *     name: { type: "string", description: "Who to greet" },
 *     loud: { type: "boolean", isFlag: true, default: false }
 *   })
 * ```
 *
 * @group Essentials
 */
export interface NamedParam<T = unknown> extends TaskParam<T> {
	/** Alternative short names (e.g., `-n` for `--name`). */
	aliases?: Array<string>
	/** Always true for named parameters. */
	isFlag: true
}

/**
 * A positional parameter for a task.
 * Positional parameters are passed in order without flags on the CLI.
 *
 * @typeParam T - The type of the parameter value.
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
export interface PositionalParam<T = unknown> extends TaskParam<T> {
	/** Always false for positional parameters. */
	isFlag: false
}

// TODO: we only want the shape of the task here

/**
 * @internal
 */
export type Opt<T> = [T] | []
/**
 * @internal
 */
export const Opt = <T>(value?: T): Opt<T> => {
	return value || value === 0 ? [value] : []
}

/**
 * A tag for categorizing tasks and scopes.
 * Can be a string (user-defined) or a symbol (internal).
 * @group Essentials
 */
export type IceTag = string

/**
 * Represents an executable task.
 * @group Essentials
 */
export type Task<
	out A = unknown,
	D extends Record<string, Task> = {},
	P extends Record<string, Task> = {},
> = {
	_tag: "task"
	readonly id: symbol // assigned by the builder
	effect: (ctx: TaskCtx) => Promise<A | TaskCancelled>
	description: string
	tags: IceTag[]
	dependsOn: D
	dependencies: P
	namedParams: Record<string, NamedParam>
	positionalParams: Array<PositionalParam>
	params: Record<string, TaskParam>
}

/**
 * A task that caches its output based on inputs and dependencies.
 */
export type CachedTask<
	A = unknown,
	D extends Record<string, Task> = {},
	P extends Record<string, Task> = {},
	Input = Record<string, unknown>,
	// TODO:
	E = unknown,
	R = unknown,
> = Task<A, D, P> & {
	input: (taskCtx: TaskCtx) => Promise<Input | TaskCancelled> // optional input
	computeCacheKey: (input: Input) => string
	revalidate?: (taskCtx: TaskCtx, args: { input: Input }) => Promise<boolean>
	// TODO: rename to codec and create adapters for zod etc.
	encodingFormat: "string" | "uint8array"
	encode: (
		taskCtx: TaskCtx,
		value: A,
		input: Input,
	) => Promise<string | Uint8Array<ArrayBufferLike>>
	decode: (
		taskCtx: TaskCtx,
		value: string | Uint8Array<ArrayBufferLike>,
		input: Input,
	) => Promise<A>
}

/**
 * A logical grouping of tasks and other scopes.
 * @group Essentials
 */
export type Scope = {
	_tag: "scope"
	readonly id: symbol
	// TODO: hmm do we need this?
	tags: IceTag[]
	description: string
	children: Record<string, TaskTreeNode>
	// this is just the modules default export
	defaultTask?: string
}

export type BuilderResult = {
	_tag: "builder"
	make: () => Task | Scope
	[key: string]: any
}

export type TaskTreeNode = Task | Scope

export type TaskTree = Record<string, TaskTreeNode>

export type ICEGlobalArgs = {
	iceDirPath: string
	background: boolean
	policy: "reuse" | "restart"
	logLevel: "debug" | "info" | "error"
}

export type ICEConfigFile = {
	default: (globalArgs: ICEGlobalArgs) => Promise<ICEConfig>
} & {
	[key: string]: TaskTreeNode
}

/**
 * Helper type to infer the configuration type from an `Ice` config function.
 * @group Config & Environment
 */
export type InferIceConfig<T> = T extends (
	env: ICEGlobalArgs,
) => Promise<infer Config>
	? Config
	: never
