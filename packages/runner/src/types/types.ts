import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { ReplicaServiceClass } from "../services/replica.js"
import { TaskCancelled } from "../builders/lib.js"
import { type TaskCtx } from "../services/taskRuntime.js"
import type { Identity } from "@icp-sdk/core/agent"
import { IceBuilder } from "../index.js"

export type ReplicaConfig = {
	// TODO: use pocket-ic subnet config
	subnet: "system" | "application" | "verified_application"
	// type?: "ephemeral" | "persistent"
	bitcoin?: boolean
	canister_http?: boolean
	type: "pocketic" | "dfx"
}

// const t = Identity

export type ICEUser = {
	identity: Identity
	principal: string
	accountId: string
	// agent: Agent
}

export type ICEUsers = Record<string, ICEUser>

export type ICERoles<U extends ICEUsers = ICEUsers> = Record<string, keyof U> // or string, depending on how you normalize it

export type ICENetworks = {
	[key: string]: {
		replica: ReplicaServiceClass
	}
}

export type ICEConfig<
	U extends ICEUsers = ICEUsers,
	R extends ICERoles<U> = ICERoles<U>,
	N extends ICENetworks = ICENetworks,
> = {
	users: U
	roles: R
	networks: N
}

export type ICEEnvironment = {
	config: Partial<ICEConfig>
	tasks: TaskTree
	plugins: Array<ICEPlugin>
}

export interface TaskParam<T = unknown, O extends boolean = boolean> {
	type: StandardSchemaV1<T> // TODO: ship built in types like "string" | "number" etc.
    name: string
	description?: string
	default?: T
	decode: (value: string) => T // supply default codec if not provided
	isOptional: O // preserves literal types
	isVariadic: boolean // false by default
}

export interface InputTaskParam<T = unknown> {
	type: StandardSchemaV1<T>
	description?: string
	default?: T
	decode?: (value: string) => T
	isOptional?: boolean
	isVariadic?: boolean
	isPositional?: boolean
}

export interface InputNamedParam<T = unknown> extends InputTaskParam<T> {
	aliases?: Array<string>
}

export interface InputPositionalParam<T = unknown> extends InputTaskParam<T> {
	// Marker interface
}

export interface NamedParam<T = unknown> extends TaskParam<T> {
	aliases?: Array<string>
	isFlag: true
}

export interface PositionalParam<T = unknown> extends TaskParam<T> {
	isFlag: false
}

// TODO: we only want the shape of the task here

export type Opt<T> = [T] | []
export const Opt = <T>(value?: T): Opt<T> => {
	return value || value === 0 ? [value] : []
}

export type Task<
	out A = unknown,
	D extends Record<string, Task> = {},
	P extends Record<string, Task> = {},
> = {
	_tag: "task"
	readonly id: symbol // assigned by the builder
	effect: (ctx: TaskCtx) => Promise<A | TaskCancelled>
	description: string
	tags: Array<string | symbol>
	dependsOn: D
	dependencies: P
	namedParams: Record<string, NamedParam>
	positionalParams: Array<PositionalParam>
	params: Record<string, TaskParam>
}

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

export type Scope = {
	_tag: "scope"
	readonly id: symbol
	// TODO: hmm do we need this?
	tags: Array<string | symbol>
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
	network: string
	iceDirPath: string
	background: boolean
	policy: "reuse" | "restart"
	logLevel: "debug" | "info" | "error"
}

export type ICEConfigFile = {
	default: (
		globalArgs: ICEGlobalArgs,
	) => Promise<{ config: Partial<ICEConfig>; plugins: ICEPlugin[] }>
} & {
	[key: string]: TaskTreeNode
}

export type ICEPlugin = (
	env: Omit<ICEEnvironment, "plugins"> & { args: ICEGlobalArgs },
) => Promise<Omit<ICEEnvironment, "plugins">> | Omit<ICEEnvironment, "plugins">

type ICEDefault<C extends Partial<ICEConfig>> = (
	globalArgs: ICEGlobalArgs,
) => Promise<{ config: C; plugins: ICEPlugin[] }>

type ICEDefaultOmit<C extends Partial<ICEConfig>> = (
	globalArgs: ICEGlobalArgs,
) => Promise<{ config: C }>

export type InferIceConfig<T> = T extends IceBuilder<infer Config> ? Config : never
// export type InferIceConfig<T> = T extends ICEDefaultOmit<infer I> ? I : never
