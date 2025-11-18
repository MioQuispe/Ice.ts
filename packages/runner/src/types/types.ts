import type { ActorSubclass, SignIdentity } from "@icp-sdk/core/agent"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { ConfigError } from "effect"
import { ICEConfigError } from "../services/iceConfig.js"
import { MocError } from "../services/moc.js"
import type {
	AgentError,
	CanisterCreateError,
	CanisterDeleteError,
	CanisterInstallError,
	CanisterStatusError,
	CanisterStopError,
	ReplicaServiceClass,
} from "../services/replica.js"
import {
	type TaskArgsParseError,
	type TaskNotFoundError,
	type TaskRuntimeError,
} from "../tasks/lib.js"
import { TaskCancelled, TaskError } from "../builders/lib.js"
import { PlatformError } from "@effect/platform/Error"
import { DeploymentError } from "../canister.js"
import { Schema as S } from "effect"
import { type TaskCtx } from "../services/taskRuntime.js"
import { LogLevel } from "effect/LogLevel"

export type ReplicaConfig = {
	// TODO: use pocket-ic subnet config
	subnet: "system" | "application" | "verified_application"
	// type?: "ephemeral" | "persistent"
	bitcoin?: boolean
	canister_http?: boolean
	type: "pocketic" | "dfx"
}

export type ICEUser = {
	identity: SignIdentity
	principal: string
	accountId: string
	// agent: Agent
}

// TODO: create service? dependencies?
export type ICEConfig = {
	users: {
		[key: string]: ICEUser
	}
	roles: {
		[key: string]: string
	}
	networks: {
		[key: string]: {
			replica: ReplicaServiceClass
		}
	}
}

export type ICEEnvironment = {
	config: Partial<ICEConfig>
	tasks: TaskTree
	plugins: Array<
		(
			env: ICEEnvironment & { args: ICEGlobalArgs },
		) => Promise<ICEEnvironment> | ICEEnvironment
	>
}

export interface TaskParam<T = unknown> {
	type: StandardSchemaV1<T> // TODO: ship built in types like "string" | "number" etc.
	description?: string
	default?: T
	parse: (value: string) => T
	isOptional: boolean
	isVariadic: boolean
	// isFlag: boolean
}

export interface InputNamedParam<T = unknown> extends TaskParam<T> {
	aliases?: Array<string>
	isFlag: true
	// TODO: means it shouldnt appear in the help. not sure if we need this
	// hidden: boolean;
}

export interface InputPositionalParam<T = unknown> extends TaskParam<T> {
	isFlag: false
}

export interface NamedParam<T = unknown> extends TaskParam<T> {
	name: string
	aliases?: Array<string>
	isFlag: true
}

export interface PositionalParam<T = unknown> extends TaskParam<T> {
	name: string
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
	params: Record<string, NamedParam | PositionalParam>
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
// export type ICEConfigFile = {
//     [key: string]: TaskTreeNode,
// 	default: (
// 		globalArgs: ICEGlobalArgs,
// 	) => Promise<ICEConfig> | ICEConfig
// }

type ICEConfigFn = (globalArgs: ICEGlobalArgs) => Promise<ICEConfig>

export type ICEConfigFile = {
	default: (
		globalArgs: ICEGlobalArgs,
	) => Promise<{ config: Partial<ICEConfig>; plugins: ICEPlugin[] }>
} & {
	[key: string]: TaskTreeNode
}

export type ICEPlugin = (
	env: ICEEnvironment & { args: ICEGlobalArgs },
) => Promise<ICEEnvironment> | ICEEnvironment

// export type ScopeEval = {
// 	_tag: "scope"
// 	readonly id: symbol
// 	// TODO: hmm do we need this?
// 	tags: Array<string | symbol>
// 	description: string
// 	children: (ctx: TaskCtx) => Record<string, TaskTreeNodeEval>
// 	// this is just the modules default export
// 	defaultTask?: string
// }

// export type TaskTreeNodeEval = Task | Scope | BuilderResult
// export type TaskTreeEval = Record<string, TaskTreeNodeEval>

// Helper to grab the config type from an Ice instance

type ICEDefault<C extends Partial<ICEConfig>> = (
    globalArgs: ICEGlobalArgs,
) => Promise<{ config: C; plugins: ICEPlugin[] }>
export type InferIceConfig<T> = T extends ICEDefault<infer I> ? I : never
