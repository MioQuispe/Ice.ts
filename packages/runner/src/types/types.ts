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
	ReplicaService,
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
import { type TaskCtxShape } from "../services/taskCtx.js"
import { LogLevel } from "effect/LogLevel"

export type CanisterActor = {
	actor: ActorSubclass<unknown>
	canisterId: string
	getControllers: () => Promise<void>
	addControllers: (controllers: string[]) => Promise<void>
	setControllers: (controllers: string[]) => Promise<void>
}

export type ManagementActor = import("@icp-sdk/core/agent").ActorSubclass<
	import("../canisters/management_latest/management.types.js")._SERVICE
>

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
			replica: ReplicaService
		}
	}
}

export type DefaultRoles = "deployer" | "minter" | "controller" | "treasury"

export type InitializedICEConfig = {
	users: {
		[key: string]: ICEUser
	}
	roles: {
		deployer: ICEUser
		minter: ICEUser
		controller: ICEUser
		treasury: ICEUser
		[key: string]: ICEUser
	}
	networks: {
		[key: string]: {
			replica: ReplicaService
			host: string
			port: number
		}
	}
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

export interface Task<
	out A = unknown,
	D extends Record<string, Task> = {},
	P extends Record<string, Task> = {},
> {
	_tag: "task"
	readonly id: symbol // assigned by the builder
	effect: (ctx: TaskCtxShape) => Promise<A | TaskCancelled>
	description: string
	tags: Array<string | symbol>
	dependsOn: D
	dependencies: P
	namedParams: Record<string, NamedParam>
	positionalParams: Array<PositionalParam>
	params: Record<string, NamedParam | PositionalParam>
}
// TODO: we only want the shape of the task here

export type Opt<T> = [T] | []
export const Opt = <T>(value?: T): Opt<T> => {
	return value || value === 0 ? [value] : []
}
const Fn = S.instanceOf(Function)
const CachedTaskSchema = S.Struct({
	computeCacheKey: Fn,
	input: Fn,
	encode: Fn,
	decode: Fn,
	encodingFormat: S.Union(S.Literal("string"), S.Literal("uint8array")),
})

// export const effectifyTaskFn = <T extends Task | CachedTask>(task: T) => {
//     return Effect.tryPromise({
//         try: () => fn,
//     })
// }

export type CachedTask<
	A = unknown,
	D extends Record<string, Task> = {},
	P extends Record<string, Task> = {},
	Input = Record<string, unknown>,
	// TODO:
	E = unknown,
	R = unknown,
> = Task<A, D, P> & {
	input: (taskCtx: TaskCtxShape) => Promise<Input | TaskCancelled> // optional input
	computeCacheKey: (input: Input) => string
	revalidate?: (
		taskCtx: TaskCtxShape,
		args: { input: Input },
	) => Promise<boolean>
	// TODO: rename to codec and create adapters for zod etc.
	encodingFormat: "string" | "uint8array"
	encode: (
		taskCtx: TaskCtxShape,
		value: A,
		input: Input,
	) => Promise<string | Uint8Array<ArrayBufferLike>>
	decode: (
		taskCtx: TaskCtxShape,
		value: string | Uint8Array<ArrayBufferLike>,
		input: Input,
	) => Promise<A>
}

// TODO: just use namespaces instead
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

export type TaskTreeNode = Task | Scope | BuilderResult

export type TaskTree = Record<string, TaskTreeNode>

// TODO: come up with a better name
export type ICEConfigContext = {
	network: string
	iceDirPath: string
	background: boolean
	logLevel: "debug" | "info" | "error"
}
// TODO: fix
export type ICEConfigFile = {
	default:
		| Partial<ICEConfig>
		| ((ctx: ICEConfigContext) => Promise<Partial<ICEConfig>> | Partial<ICEConfig>)
} & {
	[key: string]: TaskTreeNode
}
