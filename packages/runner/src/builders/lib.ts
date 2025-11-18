import { IDL } from "@icp-sdk/core/candid"
import { sha256 } from "@noble/hashes/sha2"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils"
import { StandardSchemaV1 } from "@standard-schema/spec"
import { type } from "arktype"
import { Data, Schema, Match } from "effect"
import { readFileSync, realpathSync, mkdir, writeFile, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { encodeArgs, encodeUpgradeArgs } from "../canister.js"
import {
	CanisterStatus,
	type CanisterStatusResult,
	InstallModes,
	Replica,
	AgentError,
	CanisterStatusError,
	CanisterCreateError,
	CanisterCreateRangeError,
	CanisterStopError,
	CanisterDeleteError,
	CanisterInstallError,
} from "../services/replica.js"
import { TaskRegistry } from "../services/taskRegistry.js"
import type {
	ResolvedParamsToArgs,
	TaskParamsToArgs,
	TaskSuccess,
} from "../tasks/lib.js"
import { getNodeByPath } from "../tasks/lib.js"
import type { ActorSubclass } from "../types/actor.js"
import type { CachedTask, Task } from "../types/types.js"
import { proxyActor } from "../utils/extension.js"
import { CustomCanisterConfig, deployParams } from "./custom.js"
import { Moc, MocError } from "../services/moc.js"
import { type TaskCtx } from "../services/taskRuntime.js"
import { IceDir } from "../services/iceDir.js"
import { PlatformError } from "@effect/platform/Error"
import { DeploymentsService } from "../services/deployments.js"
import { confirm } from "@clack/prompts"
import { logger } from "./logger.js"

// Schema.TaggedError

// Simple Option helper for compatibility
export const Option = {
	some: <T>(value: T) => ({ _tag: "Some" as const, value }),
	none: () => ({ _tag: "None" as const }),
	isSome: <T>(option: { _tag: "Some" | "None"; value?: T }): option is { _tag: "Some"; value: T } => option._tag === "Some",
	isNone: (option: { _tag: "Some" | "None" }): option is { _tag: "None" } => option._tag === "None",
	match: <T, U>(option: { _tag: "Some" | "None"; value?: T }, matcher: { onSome: (value: T) => U; onNone: () => U }): U => {
		if (option._tag === "Some") {
			return matcher.onSome(option.value!)
		}
		return matcher.onNone()
	},
	fromNullable: <T>(value: T | null | undefined): { _tag: "Some"; value: T } | { _tag: "None" } => {
		return value == null ? Option.none() : Option.some(value)
	},
}

// BuilderLayer is no longer needed - kept for type compatibility
export type BuilderLayer = unknown

export class TaskError extends Data.TaggedError("TaskError")<{
	message?: string
	op?: string
}> {}

export class TaskCancelled extends Schema.TaggedError<TaskCancelled>()(
	"TaskCancelled",
	{
		message: Schema.optional(Schema.String),
	},
) {}
// Schema.tag
// const parsed = Schema.parse(t, error)
export const isTaskCancelled = Match.type<unknown>().pipe(
	Match.when(
		// fucking bullshit. shit library
		// Match.tag("TaskCancelled"),
		{ _tag: "TaskCancelled" },
		(taskCancelled) => {
			return taskCancelled as TaskCancelled
		},
	),
	Match.orElse(() => false as const),
)

export const loadCanisterId = async (taskCtx: TaskCtx, taskPath: string) => {
	const { network } = taskCtx
	const canisterName = taskPath.split(":").slice(0, -1).join(":")
	try {
		const canisterIds = await taskCtx.canisterIds.getCanisterIds()
		const canisterId = canisterIds[canisterName]?.[network]
		if (canisterId) {
			return Option.some(canisterId as string)
		}
		return Option.none()
	} catch (error) {
		throw new TaskError({ message: String(error) })
	}
}

export type ConfigTask<
	Config extends Record<string, unknown>,
	D extends Record<string, Task> = {},
	P extends Record<string, Task> = {},
> = CachedTask<
	Config,
	D,
	P,
	{
		depCacheKeys: Record<string, string | undefined>
	} // TODO: input
> & {
	params: {}
}

export const makeConfigTask = <
	Config extends Record<string, unknown>,
	D extends Record<string, Task> = {},
	P extends Record<string, Task> = {},
>(
	builderLayer: BuilderLayer,
	configOrFn:
		| ((args: { ctx: TaskCtx }) => Promise<Config>)
		| ((args: { ctx: TaskCtx }) => Config)
		| Config,
) => {
	return {
		_tag: "task",
		description: "Config task",
		tags: [Tags.CANISTER, Tags.CONFIG],
		dependsOn: {} as D,
		dependencies: {} as P,
		namedParams: {},
		params: {},
		positionalParams: [],
		effect: async (taskCtx) => {
			if (typeof configOrFn === "function") {
				const configFn = configOrFn as (args: {
					ctx: TaskCtx
				}) => Promise<Config> | Config
				const configResult = configFn({ ctx: taskCtx })
				if (configResult instanceof Promise) {
					try {
						return await configResult
					} catch (error) {
						throw new TaskError({
							message: String(error),
						})
					}
				}
				return configResult
			}
			return configOrFn
		},
		id: Symbol("canister/config"),
		input: async (taskCtx) => {
			const { depResults } = taskCtx
			const depCacheKeys = Object.fromEntries(
				Object.entries(depResults).map(([key, dep]) => [key, dep.cacheKey]),
			)
			return {
				depCacheKeys,
			}
		},
		encode: async (taskCtx, value) => {
			return JSON.stringify(value)
		},
		encodingFormat: "string",
		decode: async (taskCtx, value) => {
			return JSON.parse(value as string)
		},
		computeCacheKey: (input) => {
			return hashJson({
				configHash: hashConfig(configOrFn),
				depsHash: hashJson(Object.values(input.depCacheKeys)),
			})
		},
	} satisfies ConfigTask<Config, D, P>
}

// export const resolveConfig = <T, P extends Record<string, unknown>>(
// 	taskCtx: TaskCtxShape,
// 	configOrFn:
// 		| ((args: { ctx: TaskCtxShape; deps: P }) => Promise<T>)
// 		| ((args: { ctx: TaskCtxShape; deps: P }) => T)
// 		| T,
// ) =>
// 	Effect.gen(function* () {
// 		if (typeof configOrFn === "function") {
// 			const configFn = configOrFn as (args: {
// 				ctx: TaskCtxShape
// 			}) => Promise<T> | T
// 			const configResult = configFn({ ctx: taskCtx })
// 			if (configResult instanceof Promise) {
// 				return yield* Effect.tryPromise({
// 					try: () => configResult,
// 					catch: (error) => {
// 						return new TaskError({ message: String(error) })
// 					},
// 				})
// 			}
// 			return configResult
// 		}
// 		return configOrFn
// 	})

export type CreateConfig = {
	canisterId?: string
}

export const makeCreateTask = <Config extends CreateConfig>(
	builderLayer: BuilderLayer,
	configTask: ConfigTask<Config>,
	tags: string[] = [],
): CreateTask => {
	const id = Symbol("canister/create")
	return {
		_tag: "task",
		id,
		dependsOn: {},
		dependencies: {
			config: configTask,
		},
		effect: async (taskCtx) => {
			const network = taskCtx.network
			const { taskPath } = taskCtx
			const canisterName = taskPath
				.split(":")
				.slice(0, -1)
				.join(":")
			let storedCanisterIds
			try {
				storedCanisterIds = await taskCtx.canisterIds.getCanisterIds()
			} catch (error) {
				throw new TaskError({ message: String(error) })
			}
			const storedCanisterId =
				storedCanisterIds[canisterName]?.[network]
			logger.logDebug("makeCreateTask", {
				storedCanisterId,
			})
			const depResults = taskCtx.depResults
			const canisterConfig = depResults["config"]
				?.result as Config
			const configCanisterId = canisterConfig?.canisterId
			const resolvedCanisterId =
				storedCanisterId ?? configCanisterId

			const {
				roles: {
					deployer: { identity },
				},
				replica,
			} = taskCtx
			logger.logDebug("resolvedCanisterId", {
				resolvedCanisterId,
			})
			let canisterInfo
			if (resolvedCanisterId) {
				try {
					canisterInfo = await replica.getCanisterInfo({
						canisterId: resolvedCanisterId,
						identity,
					})
				} catch (e) {
					if (e instanceof CanisterStatusError || e instanceof AgentError) {
						if ((e as any)._tag === "CanisterStatusError") {
							canisterInfo = { status: CanisterStatus.NOT_FOUND } as const
						} else {
							throw e
						}
					} else {
						throw new AgentError({ message: String(e) })
					}
				}
			} else {
				canisterInfo = { status: CanisterStatus.NOT_FOUND } as const
			}
					// const canisterInfo = resolvedCanisterId
					// 	? yield* replica
					// 			.getCanisterInfo({
					// 				canisterId: resolvedCanisterId,
					// 				identity,
					// 			})
					// 			.pipe(
					// 				Effect.catchTag(
					// 					"CanisterStatusError",
					// 					(err) => {
					// 						return Effect.succeed({
					// 							status: CanisterStatus.NOT_FOUND,
					// 						})
					// 					},
					// 				),
					// 			)
					// 	: {
					// 			status: CanisterStatus.NOT_FOUND,
					// 		}
			const isAlreadyInstalled =
				resolvedCanisterId &&
				canisterInfo.status !== CanisterStatus.NOT_FOUND

			logger.logDebug("makeCreateTask", {
				isAlreadyInstalled,
				resolvedCanisterId,
			})

			let canisterId: string
			if (isAlreadyInstalled) {
				canisterId = resolvedCanisterId!
			} else {
				try {
					canisterId = await replica.createCanister({
						canisterId: resolvedCanisterId,
						identity,
					})
				} catch (e) {
					const error = e as any
					if (error?._tag === "CanisterCreateRangeError") {
						let confirmResult
						try {
							if (taskCtx.origin === "extension") {
								confirmResult = true
							} else {
								confirmResult = await taskCtx.prompts.confirm({
									message:
										"Target canister id is not in subnet range. Do you want to create a new canister id for it?",
									initialValue: true,
								})
							}
						} catch (error) {
							throw new TaskError({
								message: String(error),
							})
						}
						if (!confirmResult) {
							throw new TaskCancelled({
								message: "Canister creation cancelled",
							})
						}
						// second attempt with a fresh canister id
						try {
							canisterId = await replica.createCanister({
								canisterId: undefined,
								identity,
							})
						} catch (e2) {
							const error2 = e2 as any
							const tag = error2?._tag
							if (
								tag === "CanisterCreateError" ||
								tag === "CanisterCreateRangeError" ||
								tag === "CanisterStatusError" ||
								tag === "AgentError"
							) {
								throw error2
							}
							throw new CanisterCreateError({
								message: String(e2),
								cause: e2 as any,
							})
						}
					} else {
						const tag = error?._tag
						if (
							tag === "CanisterCreateError" ||
							tag === "CanisterCreateRangeError" ||
							tag === "CanisterStatusError" ||
							tag === "AgentError"
						) {
							throw error
						}
						throw new CanisterCreateError({
							message: String(e),
							cause: e as any,
						})
					}
				}
			}
			const { appDir, iceDir } = taskCtx
			logger.logDebug(
				"create Task: setting canisterId",
				canisterId,
			)
			try {
				await taskCtx.canisterIds.setCanisterId({
					canisterName,
					network: taskCtx.network,
					canisterId,
				})
			} catch (error) {
				throw new TaskError({ message: String(error) })
			}
			const outDir = join(iceDir, "canisters", canisterName)
			await mkdir(outDir, { recursive: true })
			return canisterId
		},
		encode: async (taskCtx, value) => {
			return JSON.stringify(value)
		},
		decode: async (taskCtx, value) => {
			return JSON.parse(value as string)
		},
		encodingFormat: "string",
		computeCacheKey: (input) => {
			return hashJson({
				canisterName: input.canisterName,
				// canisterId: input.canisterId,
				network: input.network,
			})
		},
		input: async (taskCtx) => {
			const {
				taskPath,
				roles: {
					deployer: { identity },
				},
			} = taskCtx
			const canisterName = taskPath
				.split(":")
				.slice(0, -1)
				.join(":")
			const input = {
				canisterName,
				network: taskCtx.network,
			}
			return input
		},
		revalidate: async (taskCtx, { input }) => {
			const {
				replica,
				roles: { deployer },
				network,
				taskPath,
			} = taskCtx
			const canisterName = taskPath
				.split(":")
				.slice(0, -1)
				.join(":")
			const depResults = taskCtx.depResults
			const canisterConfig = depResults["config"]
				?.result as Config
			let storedCanisterIds
			try {
				storedCanisterIds = await taskCtx.canisterIds.getCanisterIds()
			} catch (error) {
				throw new TaskError({ message: String(error) })
			}
			const configCanisterId = canisterConfig?.canisterId
			const storedCanisterId =
				storedCanisterIds[canisterName]?.[network]
			const resolvedCanisterId =
				storedCanisterId ?? configCanisterId

			if (!resolvedCanisterId) {
				return true
			}

			let info
			try {
				info = await replica.getCanisterInfo({
					canisterId: resolvedCanisterId,
					identity: deployer.identity,
				})
			} catch (e) {
				if (e instanceof CanisterStatusError || e instanceof AgentError) {
					throw e
				}
				throw new AgentError({ message: String(e) })
			}
			if (info.status === CanisterStatus.NOT_FOUND) {
				return true
			}
			const moduleHash = info.module_hash ?? []
			if (moduleHash.length === 0) {
				return true
			}

			return false
		},
		description: "Create custom canister",
		// TODO: caching? now task handles it already
		tags: [Tags.CANISTER, Tags.CREATE, ...tags],
		namedParams: {},
		positionalParams: [],
		params: {},
	} satisfies CreateTask
}

export function hashUint8(data: Uint8Array): string {
	// noble/sha256 is universal (no Buffer, no crypto module)
	return bytesToHex(sha256(data))
}

// ensure deterministic key order
function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, val) => {
		if (val && typeof val === "object" && !Array.isArray(val)) {
			// sort *all* object keys deterministically
			return Object.keys(val)
				.sort()
				.reduce<Record<string, unknown>>(
					(acc, k) => ((acc[k] = (val as any)[k]), acc),
					{},
				)
		}
		return val // primitives & arrays unchanged
	})
}

export function hashJson(value: unknown): string {
	const ordered = stableStringify(value)
	return hashUint8(utf8ToBytes(ordered))
}

export type FileDigest = {
	path: string
	mtimeMs: number
	sha256: string
}

export function digestFile(path: string): FileDigest {
	const buf = readFileSync(path)
	return {
		path,
		// mtimeMs: statSync(path).mtimeMs,
		// TODO:
		mtimeMs: 0,
		sha256: bytesToHex(sha256(buf)),
	}
}

export const isArtifactCached = async (
	path: string,
	prev: FileDigest | undefined, // last run (undefined = cache miss)
) => {
	// No previous record – must rebuild
	if (!prev) {
		return { fresh: false, digest: await digestFileEffect(path) }
	}

	// 1️⃣ fast-path : stat only
	const statResult = await stat(path)
	const mtimeMs = statResult.mtime ? statResult.mtime.getTime() : 0
	if (mtimeMs === prev.mtimeMs) {
		return { fresh: true, digest: prev } // timestamps match ⟹ assume fresh
	}

	// 2️⃣ slow-path : hash check
	const digest = await digestFileEffect(path)
	const fresh = digest.sha256 === prev.sha256
	return { fresh, digest }
}

export const digestFileEffect = async (path: string) => {
	const buf = await readFile(path)
	const statResult = await stat(path)
	const mtimeMs = statResult.mtime ? statResult.mtime.getTime() : 0
	return {
		path,
		mtimeMs,
		sha256: bytesToHex(sha256(buf)),
	}
}

export const isArtifactCachedEffect = async (
	path: string,
	prev: FileDigest | undefined, // last run (undefined = cache miss)
) => {
	// No previous record – must rebuild
	if (!prev) {
		const digest = await digestFileEffect(path)
		return { fresh: false, digest }
	}

	// 1️⃣ fast-path : stat only
	const currentStat = await stat(path)
	const mtimeMs = currentStat.mtime ? currentStat.mtime.getTime() : 0
	if (mtimeMs === prev.mtimeMs) {
		return { fresh: true, digest: prev } // timestamps match ⟹ assume fresh
	}

	// 2️⃣ slow-path : hash check
	const digest = await digestFileEffect(path)
	const fresh = digest.sha256 === prev.sha256
	return { fresh, digest }
}

/**
 * Hash the *transpiled* JS produced by tsx/ESBuild,
 * normalising obvious sources of noise (WS, CRLF).
 */
// TODO: support objects as well
export function hashConfig(config: Function | object): string {
	// 1. grab the transpiled source
	let txt =
		typeof config === "function"
			? config.toString()
			: JSON.stringify(config)

	// 2. normalise line-endings and strip leading WS
	txt = txt
		.replace(/\r\n/g, "\n") // CRLF ⇒ LF
		.replace(/^[\s\t]+/gm, "") // leading indent
		.replace(/\s+$/gm, "") // trailing WS

	// 3. hash
	return bytesToHex(sha256(utf8ToBytes(txt)))
}

export type MergeTaskDependsOn<
	T extends { dependsOn: Record<string, Task> },
	ND extends Record<string, Task>,
> = Omit<T, "dependsOn"> & {
	dependsOn: T["dependsOn"] & ND
}
// > = {
// 	[K in keyof T]: K extends "dependsOn" ? T[K] & ND : T[K]
// } & Partial<
// 	Pick<
// 		Task,
// 		"computeCacheKey" | "input" | "decode" | "encode" | "encodingFormat"
// 	>
// >

export type MergeTaskDependencies<
	T extends { dependencies: Record<string, Task> },
	P extends Record<string, Task>,
> = Omit<T, "dependencies"> & {
	dependencies: T["dependencies"] & P
}
// > = {
// 	[K in keyof T]: K extends "dependencies" ? T[K] & NP : T[K]
// } & Partial<
// 	Pick<
// 		Task,
// 		"computeCacheKey" | "input" | "decode" | "encode" | "encodingFormat"
// 	>
// >

export type MergeScopeDependsOn<
	S extends CanisterScopeSimple,
	D extends Record<string, Task>,
> = Omit<S, "children"> & {
	children: Omit<S["children"], "install"> & {
		install: MergeTaskDependsOn<S["children"]["install"], D>
	}
}

// export type MergeScopeDependencies<
// 	S extends CanisterScope,
// 	NP extends Record<string, Task>,
// > = Omit<S, "children"> & {
// 	children: MergeAllChildrenDependencies<S["children"], NP>
// }

export type MergeScopeDependencies<
	S extends CanisterScopeSimple,
	D extends Record<string, Task>,
> = Omit<S, "children"> & {
	children: Omit<S["children"], "install"> & {
		install: MergeTaskDependencies<S["children"]["install"], D>
	}
}

/**
 * Extracts the success type of the Effect from each Task in a Record<string, Task>.
 *
 * @template T - A record of tasks.
 */
export type ExtractScopeSuccesses<T extends Record<string, Task>> = {
	[K in keyof T]: TaskSuccess<T[K]>
}

// TODO: create types
export type CreateTask = CachedTask<
	string,
	{},
	{},
	{
		network: string
		canisterName: string
	}
>
export type BindingsTask = CachedTask<
	{
		didJSPath: string
		didTSPath: string
	},
	{},
	{},
	{
		taskPath: string
		depCacheKeys: Record<string, string | undefined>
	}
>
export type BuildTask = CachedTask<
	{
		wasmPath: string
		candidPath: string
	},
	{},
	{},
	{
		canisterName: string
		taskPath: string
		wasm: FileDigest
		candid: FileDigest
		depCacheKeys: Record<string, string | undefined>
	}
>

export type InstallArgsTask<
	_SERVICE = unknown,
	I = unknown,
	U = unknown,
	D extends Record<string, Task> = {},
	P extends Record<string, Task> = {},
> = Omit<
	CachedTask<
		{
			canisterName: string
			installArgs: {
				raw: I
				encoded: Uint8Array<ArrayBufferLike>
				fn: Function
			}
			upgradeArgs: {
				raw: U
				encoded: Uint8Array<ArrayBufferLike>
				fn: Function
			}
			// mode: InstallModes
			// encodedArgs: Uint8Array<ArrayBufferLike>
		},
		D,
		P,
		{
			network: string
			canisterName: string
			mode: InstallModes
			depCacheKeys: Record<string, string | undefined>
			installArgsFn: Function
			upgradeArgsFn: Function
		}
	>,
	"params"
> & {
	params: typeof installArgsParams
}

export type InstallTask<
	_SERVICE = unknown,
	I = unknown,
	U = unknown,
	D extends Record<string, Task> = {},
	P extends Record<string, Task> = {},
> = Omit<
	CachedTask<
		{
			canisterId: string
			canisterName: string
			actor: ActorSubclass<_SERVICE>
			mode: InstallModes
			args: I | U
			encodedArgs: Uint8Array<ArrayBufferLike>
		},
		D,
		P,
		{
			network: string
			canisterId: string
			// canisterName: string
			computedMode: "upgrade" | "install"
			resolvedMode: InstallModes
			// computeKeyMode?: "install" | "upgrade"
			depCacheKeys: Record<string, string | undefined>
			wasmDigest: FileDigest
			candidDigest: FileDigest
			installArgsDigest: string
			upgradeArgsDigest: string
			// deploymentId: number
			// installArgsFn: Function
			// upgradeArgsFn: Function
		}
	>,
	"params"
> & {
	params: typeof installParams
}

// export type UpgradeTask<
// 	_SERVICE = unknown,
// 	U = unknown,
// 	D extends Record<string, Task> = {},
// 	P extends Record<string, Task> = {},
// > = Omit<
// 	CachedTask<
// 		{
// 			canisterId: string
// 			canisterName: string
// 			actor: ActorSubclass<_SERVICE>
// 			mode: InstallModes
// 			args: U
// 			encodedArgs: Uint8Array<ArrayBufferLike>
// 		},
// 		D,
// 		P,
// 		{
// 			network: string
// 			canisterId: string
// 			canisterName: string
// 			taskPath: string
// 			depCacheKeys: Record<string, string | undefined>
// 			upgradeArgsFn: Function
// 		}
// 	>,
// 	"params"
// > & {
// 	params: typeof upgradeParams
// }

// D,
// P
export type StopTask = Task<void>
export type RemoveTask = Task<void>
export type DeployTask<
	_SERVICE = unknown,
	D extends Record<string, Task> = {},
	P extends Record<string, Task> = {},
> = Omit<
	Task<
		{
			canisterId: string
			canisterName: string
			actor: ActorSubclass<_SERVICE>
			mode: InstallModes
		},
		D,
		P
	>,
	"params"
> & {
	params: typeof deployParams
}

// InstallTask<_SERVICE>
export type StatusTask = Task<{
	canisterName: string
	canisterId: string | undefined
	status: CanisterStatus
	info: CanisterStatusResult | undefined
}>

// TODO: use Scope type
export type CanisterScopeSimple = {
	_tag: "scope"
	id: symbol
	tags: Array<string | symbol>
	description: string
	defaultTask: "deploy"
	// only limited to tasks
	// children: Record<string, Task>
	children: {
		// create: Task<string>
		config: Task
		create: Task
		bindings: Task
		build: Task
		install: Task
		install_args: Task
		stop: Task
		remove: Task
		deploy: Task
		status: Task
	}
}

export const Tags = {
	HIDDEN: "$$ice/hidden",

	CANISTER: "$$ice/canister",
	CUSTOM: "$$ice/canister/custom",
	MOTOKO: "$$ice/canister/motoko",
	RUST: "$$ice/canister/rust",
	AZLE: "$$ice/canister/azle",
	KYBRA: "$$ice/canister/kybra",
	REMOTE: "$$ice/canister/remote",

	CREATE: "$$ice/canister/create",
	STATUS: "$$ice/canister/status",
	BUILD: "$$ice/canister/build",
	INSTALL: "$$ice/canister/install",
	INSTALL_ARGS: "$$ice/canister/install_args",
	CONFIG: "$$ice/canister/config",
	// UPGRADE: "$$ice/canister/upgrade",
	BINDINGS: "$$ice/canister/bindings",
	DEPLOY: "$$ice/canister/deploy",
	STOP: "$$ice/canister/stop",
	REMOVE: "$$ice/canister/remove",
	UI: "$$ice/canister/ui",
}

// TODO: dont pass in tags, just make the effect

export type TaskReturnValue<T extends Task> = T extends {
	effect: (ctx: TaskCtx) => Promise<infer S>
}
	? S
	: never

export type CompareTaskEffects<
	D extends Record<string, Task>,
	P extends Record<string, Task>,
> = (keyof D extends keyof P ? true : false) extends true
	? {
			[K in keyof D & keyof P]: TaskReturnValue<
				D[K]
			> extends TaskReturnValue<P[K]>
				? never
				: K
		}[keyof D & keyof P] extends never
		? P
		: never
	: never

export type AllowedDep = Task | CanisterScopeSimple

/**
 * If T is already a Task, it stays the same.
 * If T is a CanisterScope, returns its provided Task (assumed to be under the "provides" property).
 */
export type NormalizeDep<T> = T extends Task
	? T
	: T extends CanisterScopeSimple
		? T["children"]["deploy"] extends Task
			? T["children"]["deploy"]
			: never
		: never

/**
 * Normalizes a record of dependencies.
 */
// export type NormalizeDeps<Deps extends Record<string, AllowedDep>> = {
// 	[K in keyof Deps]: NormalizeDep<Deps[K]> extends Task
// 		? NormalizeDep<Deps[K]>
// 		: never
// }

export type NormalizeDeps<Deps extends Record<string, AllowedDep>> = {
	[K in keyof Deps]: Deps[K] extends Task
		? Deps[K]
		: Deps[K] extends CanisterScopeSimple
			? Deps[K]["children"]["deploy"]
			: never
}

export type ValidProvidedDeps<
	D extends Record<string, AllowedDep>,
	P extends Record<string, AllowedDep>,
> =
	CompareTaskEffects<NormalizeDeps<D>, NormalizeDeps<P>> extends never
		? never
		: P

export type CompareTaskReturnValues<T extends Task> = T extends {
	effect: (ctx: TaskCtx) => Promise<infer S>
}
	? S
	: never

export type DependenciesOf<T> = T extends { dependsOn: infer D } ? D : never
export type ProvideOf<T> = T extends { dependencies: infer P } ? P : never

export type DependencyReturnValues<T> =
	DependenciesOf<T> extends Record<string, Task>
		? {
				[K in keyof DependenciesOf<T>]: CompareTaskReturnValues<
					DependenciesOf<T>[K]
				>
			}
		: never

export type ProvideReturnValues<T> =
	ProvideOf<T> extends Record<string, Task>
		? {
				[K in keyof ProvideOf<T>]: CompareTaskReturnValues<
					ProvideOf<T>[K]
				>
			}
		: never

export type DepBuilder<T> =
	Exclude<
		Extract<keyof DependencyReturnValues<T>, string>,
		keyof ProvideReturnValues<T>
	> extends never
		? DependencyReturnValues<T> extends Pick<
				ProvideReturnValues<T>,
				Extract<keyof DependencyReturnValues<T>, string>
			>
			? T
			: never
		: never

export type DependencyMismatchError<S extends CanisterScopeSimple> = {
	// This property key is your custom error message.
	"[ICE-ERROR: Dependency mismatch. Please provide all required dependencies.]": true
}

export type UniformScopeCheck<S extends CanisterScopeSimple> = S extends {
	children: {
		deploy: infer C
	}
}
	? C extends DepBuilder<C>
		? S
		: DependencyMismatchError<S>
	: DependencyMismatchError<S>

// Compute a boolean flag from our check.
export type IsValid<S extends CanisterScopeSimple> =
	UniformScopeCheck<S> extends DependencyMismatchError<S> ? false : true

//
// Helper Functions
//

// TODO: arktype match?
export function normalizeDep(dep: Task | CanisterScopeSimple): Task {
	if ("_tag" in dep && dep._tag === "task") return dep
	if ("_tag" in dep && dep._tag === "scope" && dep.children?.deploy)
		return dep.children.deploy as Task
	throw new Error("Invalid dependency type provided to normalizeDep")
}

/**
 * Normalizes a record of dependencies.
 */
export function normalizeDepsMap(
	dependencies: Record<string, AllowedDep>,
): Record<string, Task> {
	return Object.fromEntries(
		Object.entries(dependencies).map(([key, dep]) => [
			key,
			normalizeDep(dep),
		]),
	)
}

export const makeStopTask = (builderLayer: BuilderLayer): StopTask => {
	return {
		_tag: "task",
		id: Symbol("customCanister/stop"),
		dependsOn: {},
		dependencies: {},
		// TODO: do we allow a fn as args here?
		effect: async (taskCtx) => {
			const { taskPath } = taskCtx
			const canisterName = taskPath
				.split(":")
				.slice(0, -1)
				.join(":")
			// TODO: handle error
			const maybeCanisterId = await loadCanisterId(
				taskCtx,
				taskPath,
			)
			if (Option.isNone(maybeCanisterId)) {
				logger.logDebug(
					`Canister ${canisterName} is not installed`,
					maybeCanisterId,
				)
				return
			}
			const canisterId = maybeCanisterId.value
			const {
				roles: {
					deployer: { identity },
				},
				replica,
			} = taskCtx
			// TODO: check if canister is running / stopped
			// get status first
			// 🔁 makeStopTask.effect – wrap getCanisterStatus and stopCanister
			let status
			try {
				status = await replica.getCanisterStatus({ canisterId, identity })
			} catch (e) {
				if (e instanceof CanisterStatusError || e instanceof AgentError) {
					throw e
				}
				throw new AgentError({ message: String(e) })
			}

			if (status === CanisterStatus.STOPPED) {
				logger.logDebug(
					`Canister ${canisterName} is already stopped or not installed`,
					status,
				)
				return
			}
			try {
				await replica.stopCanister({ canisterId, identity })
			} catch (e) {
				if (e instanceof CanisterStopError || e instanceof AgentError) {
					throw e
				}
				throw new AgentError({ message: String(e) })
			}
			logger.logDebug(`Stopped canister ${canisterName}`)
		},
		description: "Stop canister",
		// TODO: no tag custom
		tags: [Tags.CANISTER, Tags.STOP],
		namedParams: {},
		positionalParams: [],
		params: {},
	} satisfies Task<void>
}

export const makeRemoveTask = (builderLayer: BuilderLayer): RemoveTask => {
	return {
		_tag: "task",
		id: Symbol("customCanister/remove"),
		dependsOn: {},
		dependencies: {},
		// TODO: do we allow a fn as args here?
		effect: async (taskCtx) => {
			const { taskPath } = taskCtx
			const canisterName = taskPath
				.split(":")
				.slice(0, -1)
				.join(":")
			// TODO: handle error
			const maybeCanisterId = await loadCanisterId(
				taskCtx,
				taskPath,
			)
			if (Option.isNone(maybeCanisterId)) {
				logger.logDebug(
					`Canister ${canisterName} is not installed`,
					maybeCanisterId,
				)
				return
			}
			const canisterId = maybeCanisterId.value
			const {
				roles: {
					deployer: { identity },
				},
				replica,
			} = taskCtx
			// 🔁 makeRemoveTask.effect – wrap removeCanister
			try {
				await replica.removeCanister({ canisterId, identity })
			} catch (e) {
				if (e instanceof CanisterDeleteError || e instanceof AgentError) {
					throw e
				}
				throw new AgentError({ message: String(e) })
			}
			try {
				await taskCtx.canisterIds.removeCanisterId(canisterName)
			} catch (error) {
				throw new TaskError({ message: String(error) })
			}
			// yield* canisterIdsService.removeCanisterId(canisterName)
			logger.logDebug(`Removed canister ${canisterName}`)
		},
		description: "Remove canister",
		// TODO: no tag custom
		tags: [Tags.CANISTER, Tags.REMOVE],
		namedParams: {},
		positionalParams: [],
		params: {},
	} satisfies RemoveTask
}

export const makeCanisterStatusTask = (
	builderLayer: BuilderLayer,
	tags: string[],
): StatusTask => {
	return {
		_tag: "task",
		// TODO: change
		id: Symbol("canister/status"),
		dependsOn: {},
		// TODO: we only want to warn at a type level?
		// TODO: type Task
		dependencies: {},
		effect: async (taskCtx) => {
			// TODO:
			const { replica, network } = taskCtx
			const { taskPath } = taskCtx
			const canisterName = taskPath
				.split(":")
				.slice(0, -1)
				.join(":")
			let canisterIdsMap
			try {
				canisterIdsMap = await taskCtx.canisterIds.getCanisterIds()
			} catch (error) {
				throw new TaskError({ message: String(error) })
			}
			// TODO: if deleted doesnt exist
			const canisterIds = canisterIdsMap[canisterName]
			if (!canisterIds) {
				return {
					canisterName,
					canisterId: undefined,
					status: CanisterStatus.NOT_FOUND,
					info: undefined,
				}
			}
			const canisterId = canisterIds[network]
			if (!canisterId) {
				// TODO: fix format
				return {
					canisterName,
					canisterId,
					status: CanisterStatus.NOT_FOUND,
					info: undefined,
				}
			}
			const {
				roles: {
					deployer: { identity },
				},
			} = taskCtx
			// 🔁 makeInstallTask.effect – wrap getCanisterInfo before precondition checks
			let canisterInfo
			try {
				canisterInfo = await replica.getCanisterInfo({ canisterId, identity })
			} catch (e) {
				if (e instanceof CanisterStatusError || e instanceof AgentError) {
					throw e
				}
				throw new AgentError({ message: String(e) })
			}
			const status = canisterInfo.status
			return {
				canisterName,
				canisterId,
				status,
				info: canisterInfo,
			}
		},
		description: "Get canister status",
		tags: [Tags.CANISTER, Tags.STATUS, ...tags],
		namedParams: {},
		positionalParams: [],
		params: {},
	} satisfies StatusTask
}

export const resolveMode = async (
	taskCtx: TaskCtx,
	configCanisterId: string | undefined,
	// TODO: REMOVE! temporary hack. clean up
	unCached: boolean = false,
): Promise<InstallModes> => {
	const {
		replica,
		args,
		network,
		roles: {
			deployer: { identity },
		},
		depResults,
	} = taskCtx
	const { taskPath } = taskCtx
	const taskArgs = args as InstallTaskArgs
	const requestedMode = taskArgs.mode
	const wasmPath = taskArgs.wasm
	const canisterName = taskPath.split(":").slice(0, -1).join(":")
	let canisterIdsMap
	try {
		canisterIdsMap = await taskCtx.canisterIds.getCanisterIds()
	} catch (error) {
		throw new TaskError({ message: String(error) })
	}
	// const canisterIdsMap = yield* canisterIdsService.getCanisterIds()
	const canisterId =
		canisterIdsMap[canisterName]?.[network] ?? configCanisterId
	// TODO: use Option.Option?
	// 🔁 resolveMode – wrap getCanisterInfo (+ keep your catchTag branch)
	let canisterInfo: CanisterStatusResult | { status: CanisterStatus.NOT_FOUND }
	if (canisterId) {
		try {
			canisterInfo = await replica.getCanisterInfo({
				canisterId,
				identity,
			})
		} catch (e) {
			if (e instanceof CanisterStatusError) {
				canisterInfo = { status: CanisterStatus.NOT_FOUND } as const
			} else if (e instanceof AgentError) {
				throw e
			} else {
				throw new AgentError({ message: String(e) })
			}
		}
	} else {
		canisterInfo = { status: CanisterStatus.NOT_FOUND } as const
	}

	const noModule =
		canisterInfo.status === CanisterStatus.NOT_FOUND ||
		("module_hash" in canisterInfo && canisterInfo.module_hash.length === 0)

	let lastDeployment
	try {
		const deployment = await taskCtx.deployments.get(canisterName, network)
		lastDeployment = Option.fromNullable(deployment)
	} catch (error) {
		throw new TaskError({ message: String(error) })
	}
	// // const lastDeployment = yield* Deployments.get(
	// 	canisterName,
	// 	currentNetwork,
	// )
	const { installArgs, upgradeArgs } = depResults["install_args"]
		?.result as TaskSuccess<InstallArgsTask>
	const installArgsHash = hashConfig(installArgs.fn)
	const upgradeArgsHash = hashConfig(upgradeArgs.fn)

	// // const mode =
	// // 	resolvedMode === "reinstall" ? "install" : resolvedMode
	logger.logDebug("resolveMode", {
		requestedMode,
		noModule,
		lastDeployment,
		installArgsHash,
		upgradeArgsHash,
	})

	let mode: InstallModes
	if (requestedMode === "auto") {
		if (noModule) {
			mode = "install"
		} else {
			mode = Option.match(lastDeployment, {
				onSome: (lastDeployment) => {
					// TODO: fix, this seems like a bad way to do it
					if (
						lastDeployment.installArgsHash !== installArgsHash
					) {
						if (taskCtx.origin === "extension") {
							// do not wipe canister state unless confirmed
							return "upgrade"
						}
						return "reinstall"
					}
					if (
						lastDeployment.upgradeArgsHash !== upgradeArgsHash
					) {
						return "upgrade"
					}
					// unchanged args: prefer upgrade over install (idempotent)
					// but this breaks second run where it should use install cache
					// return "upgrade"

					return lastDeployment.mode === "upgrade"
						? "upgrade"
						: // TODO: breaks on initial install. upgradeArgs may differ from installArgs
							// : (noModule ? "install" : "upgrade")
							unCached
							? "upgrade"
							: "install"
				},
				onNone: () => {
					// Module present but no history: if current funcs differ, treat as upgrade intent
					return upgradeArgsHash !== installArgsHash
						? "upgrade"
						: "reinstall"
					// return "reinstall"
				},
			})
		}
	} else {
		// TODO: why not working? still returning cached result?
		// maybe need to add mode to cache again?
		mode = requestedMode
	}

	return mode
}

// TODO: temporary hack!!!!!!
const uint8ArrayToJsonString = (uint8Array: Uint8Array) => {
	const jsonString = Array.from(uint8Array, (byte) =>
		String.fromCharCode(byte),
	).join("")
	// return JSON.parse(jsonString)
	return jsonString
}
// TODO: temporary hack!!!!!!
const jsonStringToUint8Array = (jsonString: string): Uint8Array => {
	return new Uint8Array(Array.from(jsonString, (char) => char.charCodeAt(0)))
}

export class InstallTaskError extends Data.TaggedError("InstallTaskError")<{
	message?: string
}> {}

// Encoding with type information
const encodeWithBigInt = async (obj: unknown): Promise<string> => {
	try {
		return JSON.stringify(obj, (_, value) => {
			if (typeof value === "bigint") {
				return { __type__: "bigint", value: value.toString() }
			}
			return value
		})
	} catch (e) {
		throw new TaskError({
			message: "Encoding failed",
		})
	}
}

// Decoding with type restoration
const decodeWithBigInt = async (str: string): Promise<unknown> => {
	try {
		return JSON.parse(str, (_, value) => {
			if (
				value &&
				typeof value === "object" &&
				value.__type__ === "bigint"
			) {
				return BigInt(value.value)
			}
			return value
		})
	} catch (e) {
		throw new TaskError({
			message: "Decoding failed",
		})
	}
}

export const installParams = {
	mode: {
		type: type("'install' | 'reinstall' | 'upgrade' | 'auto'"),
		description: "The mode to install the canister in",
		default: "install" as const,
		isFlag: true as const,
		isOptional: true as const,
		isVariadic: false as const,
		name: "mode",
		aliases: ["m"],
		parse: (value: string) => value as InstallModes,
	},
	args: {
		// TODO: maybe not Uint8Array?
		type: type("TypedArray.Uint8"),
		description: "The arguments to pass to the canister as a candid string",
		// default: undefined,
		isFlag: true as const,
		isOptional: true as const,
		isVariadic: false as const,
		name: "args",
		aliases: ["a"],
		parse: (value: string) => {
			// TODO: convert to candid string
			return new Uint8Array(Buffer.from(value))
		},
	},
	forceReinstall: {
		type: type("boolean"),
		description: "Force reinstall the canister",
		isFlag: true as const,
		isOptional: true as const,
		isVariadic: false as const,
		default: false as const,
		name: "forceReinstall",
		aliases: ["f"],
		parse: (value: string) => !!value as unknown as boolean,
	},
	// TODO: provide defaults. just read from fs by canister name
	// should we allow passing in wasm bytes?
	wasm: {
		type: type("string"),
		description: "The path to the wasm file",
		isFlag: true as const,
		isOptional: false as const,
		isVariadic: false as const,
		name: "wasm",
		aliases: ["w"],
		parse: (value: string) => value as string,
	},
	// TODO: provide defaults
	candid: {
		// TODO: should be encoded?
		type: type("string"),
		description: "The path to the candid file",
		isFlag: true as const,
		isOptional: true as const,
		isVariadic: false as const,
		name: "candid",
		aliases: ["c"],
		parse: (value: string) => value as string,
	},
	// TODO: provide defaults
	canisterId: {
		type: type("string"),
		description: "The canister ID to install the canister in",
		isFlag: true as const,
		default: "aaaaa-aa",
		isOptional: false as const,
		isVariadic: false as const,
		name: "canisterId",
		aliases: ["i"],
		parse: (value: string) => value as string,
	},
}

export type InstallTaskArgs = ResolvedParamsToArgs<typeof installParams>

export const makeInstallTaskParams = <T extends CustomCanisterConfig>(
	canisterConfig: T,
) => {
	return {
		...installParams,
		wasm: {
			...installParams.wasm,
			isOptional: true as const,
			default: canisterConfig.wasm,
		},
		canisterId: {
			...installParams.canisterId,
			isOptional: true as const,
			default: canisterConfig.canisterId,
		},
		candid: {
			...installParams.candid,
			isOptional: true as const,
			default: canisterConfig.candid,
		},
	}
}

export const installArgsParams = {
	// mode: {
	// 	// TODO: add "auto" ?
	// 	type: type("'install' | 'reinstall' | 'upgrade'"),
	// 	description: "The mode to generate install args for",
	// 	default: "install" as const,
	// 	isFlag: true as const,
	// 	isOptional: true as const,
	// 	isVariadic: false as const,
	// 	name: "mode",
	// 	aliases: ["m"],
	// 	parse: (value: string) => value as InstallModes,
	// },
}

export const makeInstallArgsTask = <
	_SERVICE,
	I,
	U,
	D extends Record<string, Task>,
	P extends Record<string, Task>,
>(
	builderLayer: BuilderLayer,
	installArgs: {
		fn: (args: {
			ctx: TaskCtx
			deps: ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>
		}) => Promise<I> | I
		customEncode:
			| undefined
			| ((
					args: I,
					mode: InstallModes,
			  ) => Promise<Uint8Array<ArrayBufferLike>>)
	},
	upgradeArgs: {
		fn: (args: {
			ctx: TaskCtx
			deps: ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>
		}) => Promise<U> | U
		customEncode:
			| undefined
			| ((
					args: U,
					mode: InstallModes,
			  ) => Promise<Uint8Array<ArrayBufferLike>>)
	},
	dependencies: P,
): InstallArgsTask<_SERVICE, I, U, D, P> => {
	return {
		_tag: "task",
		id: Symbol("customCanister/install_args"),
		dependsOn: {} as D,
		dependencies,
		// TODO: allow passing in candid as a string from CLI
		namedParams: installArgsParams,
		positionalParams: [],
		params: installArgsParams,
		effect: async (taskCtx) => {
			logger.logDebug(
				"Starting custom canister installation",
			)
			// TODO: can I pass in the task itself as a type parameter to get automatic type inference?
			// To avoid having to use "as"
			const { appDir, iceDir } = taskCtx
			const identity = taskCtx.roles.deployer.identity
			const { replica, args, depResults } = taskCtx
			const taskArgs = args as InstallTaskArgs
			const { taskPath } = taskCtx
			const canisterName = taskPath
				.split(":")
				.slice(0, -1)
				.join(":")

			const {
				wasm: wasmPath,
				// TODO: js or candid?
				candid,
				// TODO: support raw args
				args: rawInstallArgs,
				// mode,
			} = taskArgs

			logger.logDebug("Starting install args generation")

			let initArgs = [] as unknown as I | U
			logger.logDebug("Executing install args function")

			// TODO: use params?
			const didJSPath = join(
				iceDir,
				"canisters",
				canisterName,
				`${canisterName}.did.js`,
			)

			// TODO: should it catch errors?
			// TODO: handle different modes
			const deps = Object.fromEntries(
				Object.entries(depResults).map(([key, dep]) => [key, dep.result])
			) as ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>

			const installFnResult =
				typeof installArgs.fn === "function"
					? installArgs.fn({
							ctx: taskCtx,
							deps,
					  })
					: installArgs.fn
			let installArgsResult = [] as unknown as I
			if (installFnResult instanceof Promise) {
				try {
					installArgsResult = await installFnResult
				} catch (e) {
					throw new TaskError({
						message: `Install args function failed for: ${canisterName},
					typeof installArgsFn: ${typeof installArgs.fn},
					 typeof installResult: ${typeof installFnResult}
					 error: ${e},
					 installArgsFn: ${installArgs.fn},
					 installResult: ${installFnResult},
					 `,
					})
				}
			} else {
				installArgsResult = installFnResult
			}

			const upgradeFnResult =
				typeof upgradeArgs.fn === "function"
					? upgradeArgs.fn({
							ctx: taskCtx,
							deps,
					  })
					: upgradeArgs.fn

			let upgradeArgsResult = [] as unknown as U
			if (upgradeFnResult instanceof Promise) {
				try {
					upgradeArgsResult = await upgradeFnResult
				} catch (e) {
					throw new TaskError({
						message: `Install args function failed for: ${canisterName},
					typeof installArgsFn: ${typeof upgradeArgs.fn},
					 typeof installResult: ${typeof upgradeFnResult}
					 error: ${e},
					 installArgsFn: ${upgradeArgs.fn},
					 installResult: ${upgradeFnResult},
					 `,
					})
				}
			} else {
				upgradeArgsResult = upgradeFnResult
			}

			logger.logDebug(
				"Install args generated",
				//     {
				// 	installArgsResult,
				// 	upgradeArgsResult,
				// }
			)

			let canisterDID
			try {
				canisterDID = await import(didJSPath) as CanisterDidModule
			} catch (e) {
				throw new TaskError({
					message: "Failed to load canisterDID",
				})
			}
			logger.logDebug(
				"Encoding args install args",
				//     {
				// 	installArgsResult,
				// 	canisterDID,
				// }
			)
			// TODO: do we accept simple objects as well?
			// let encodedArgs
			let encodedInstallArgs
			if (installArgs.customEncode) {
				try {
					encodedInstallArgs = await installArgs.customEncode!(
						installArgsResult,
						"install",
					)
				} catch (error) {
					throw new TaskError({
						message: `customEncode failed, error: ${error}`,
					})
				}
			} else {
				encodedInstallArgs = await encodeArgs(
					installArgsResult as unknown[],
					canisterDID,
				)
			}

			let encodedUpgradeArgs
			if (upgradeArgs.customEncode) {
				try {
					encodedUpgradeArgs = await upgradeArgs.customEncode!(
						upgradeArgsResult,
						"upgrade",
					) // typescript cant infer properly
				} catch (error) {
					throw new TaskError({
						message: `customEncode failed, error: ${error}`,
					})
				}
			} else {
				encodedUpgradeArgs = await encodeArgs(
					upgradeArgsResult as unknown[],
					canisterDID,
				)
			}

			return {
				installArgs: {
					raw: installArgsResult,
					encoded: encodedInstallArgs,
					fn: installArgs.fn,
				},
				upgradeArgs: {
					raw: upgradeArgsResult,
					encoded: encodedUpgradeArgs,
					fn: upgradeArgs.fn,
				},
				// args: installArgs,
				// encodedArgs,
				// mode,
				canisterName,
			}
		},
		description: "Generate install args for canister",
		tags: [Tags.CANISTER, Tags.INSTALL_ARGS],
		// TODO: add network?
		// TODO: pocket-ic could be restarted?
		computeCacheKey: (input) => {
			// Only depend on the relevant args function by mode to avoid unrelated invalidations
			const argsFnHash =
				input.mode === "upgrade"
					? hashConfig(input.upgradeArgsFn)
					: hashConfig(input.installArgsFn)
			const keyInput = {
				argsFnHash,
				depsHash: hashJson(input.depCacheKeys),
				network: input.network,
			}
			return hashJson(keyInput)
		},
		input: async (taskCtx) => {
			const { args } = taskCtx
			const { taskPath, depResults } = taskCtx
			const taskArgs = args as {
				mode: "install" | "reinstall"
				args: string
			}
			const canisterName = taskPath
				.split(":")
				.slice(0, -1)
				.join(":")
			const dependencies = depResults as {
				[K in keyof P]: {
					result: TaskReturnValue<P[K]>
					cacheKey: string | undefined
				}
			}
			const depCacheKeys = Object.fromEntries(
				Object.entries(dependencies).map(([key, dep]) => [key, dep.cacheKey])
			)
			const { network } = taskCtx
			const mode = taskArgs.mode

			// const taskRegistry = yield* TaskRegistry
			// TODO: we need a separate cache for this?
			const input = {
				canisterName,
				network,
				mode,
				depCacheKeys,
				installArgsFn: installArgs.fn,
				upgradeArgsFn: upgradeArgs.fn,
			}
			return input
		},
		encodingFormat: "string",

		encode: async (taskCtx, result, input) => {
			logger.logDebug(
				"Encoding args for",
				result.canisterName,
			)
			return await encodeWithBigInt({
				canisterName: result.canisterName,
				installArgs: {
					raw: result.installArgs.raw,
					encoded: uint8ArrayToJsonString(
						result.installArgs.encoded,
					),
				},
				upgradeArgs: {
					raw: result.upgradeArgs.raw,
					encoded: uint8ArrayToJsonString(
						result.upgradeArgs.encoded,
					),
				},
			})
		},
		decode: async (taskCtx, value, input) => {
			const {
				canisterName,
				installArgs: decodedInstallArgs,
				upgradeArgs: decodedUpgradeArgs,
			} = (await decodeWithBigInt(value as string)) as {
				canisterName: string
				installArgs: {
					raw: I
					encoded: string
				}
				upgradeArgs: {
					raw: U
					encoded: string
				}
			}
			const encodedInstallArgs = jsonStringToUint8Array(
				decodedInstallArgs.encoded,
			)
			const encodedUpgradeArgs = jsonStringToUint8Array(
				decodedUpgradeArgs.encoded,
			)
			const {
				replica,
				roles: {
					deployer: { identity },
				},
			} = taskCtx
			const { appDir, iceDir, args } = taskCtx
			const taskArgs = args as InstallTaskArgs
			const didJSPath = join(
				iceDir,
				"canisters",
				canisterName,
				`${canisterName}.did.js`,
			)
			const decoded = {
				canisterName,
				installArgs: {
					raw: decodedInstallArgs.raw,
					encoded: encodedInstallArgs,
					fn: installArgs.fn,
				},
				upgradeArgs: {
					raw: decodedUpgradeArgs.raw,
					encoded: encodedUpgradeArgs,
					fn: upgradeArgs.fn,
				},
			}
			return decoded
		},
	} satisfies InstallArgsTask<_SERVICE, I, U, D, P>
}

export const makeInstallTask = <_SERVICE, I, U>(
	builderLayer: BuilderLayer,
	installArgsTask: InstallArgsTask<_SERVICE, I, U>,
): InstallTask<_SERVICE, I, U> => {
	// TODO: canister installed, but cache deleted. should use reinstall, not install
	return {
		_tag: "task",
		id: Symbol("customCanister/install"),
		dependsOn: {},
		dependencies: {
			install_args: installArgsTask,
		},
		// TODO: allow passing in candid as a string from CLI
		namedParams: installParams,
		positionalParams: [],
		params: installParams,
		effect: async (taskCtx) => {
			logger.logDebug(
				"Starting custom canister installation",
			)
			// TODO: can I pass in the task itself as a type parameter to get automatic type inference?
			// To avoid having to use "as"
			const { appDir, iceDir } = taskCtx
			const identity = taskCtx.roles.deployer.identity
			const { replica, args, depResults } = taskCtx
			const taskArgs = args as InstallTaskArgs
			const { taskPath } = taskCtx
			const canisterName = taskPath
				.split(":")
				.slice(0, -1)
				.join(":")

			const {
				canisterId,
				wasm: wasmPath,
				// TODO: js or candid?
				candid,
				// TODO: support raw args
				args: rawInstallArgs,
				mode: requestedMode,
			} = taskArgs

			logger.logDebug("Starting install args generation")

			const { installArgs, upgradeArgs } = depResults[
				"install_args"
			]?.result as TaskSuccess<InstallArgsTask<_SERVICE, I, U>>

			// TODO: Clean up. temporary hack. also cache it?
			let mode = await resolveMode(taskCtx, canisterId, true)
			// TODO: returns install instead of reinstall....
			// slightly different from resolveMode in input??
			// if (mode === "install" && requestedMode === "auto" && !noModule) {
			//     mode = "reinstall"
			// }

			logger.logDebug("Resolved mode in install effect", {
				mode,
			})
			const initArgs =
				mode === "install" || mode === "reinstall"
					? installArgs
					: upgradeArgs
			logger.logDebug("Executing install args function")

			// TODO: use params
			const didJSPath = join(
				iceDir,
				"canisters",
				canisterName,
				`${canisterName}.did.js`,
			)

			let canisterDID
			try {
				canisterDID = await import(didJSPath) as CanisterDidModule
			} catch (e) {
				throw new TaskError({
					message: "Failed to load canisterDID",
				})
			}
			logger.logDebug(
				"Loaded canisterDID",
				//     {
				// 	canisterDID,
				// }
			)

			// TODO:
			// they can return the values we need perhaps? instead of reading from fs
			// we need the wasm blob and candid DIDjs / idlFactory?
			const wasmContent = await readFile(wasmPath)
			const wasm = new Uint8Array(wasmContent)
			const maxSize = 3670016
			// Enforce explicit mode preconditions
			let canisterInfo
			try {
				canisterInfo = await replica.getCanisterInfo({ canisterId, identity })
			} catch (e) {
				if (e instanceof CanisterStatusError || e instanceof AgentError) {
					throw e
				}
				throw new AgentError({ message: String(e) })
			}
			const modulePresent =
				canisterInfo.status !== CanisterStatus.NOT_FOUND &&
				canisterInfo.module_hash.length > 0
			switch (mode) {
				case "install": {
					if (modulePresent) {
						throw new TaskError({
							message:
								"Explicit install not allowed on non-empty canister. Use reinstall.",
						})
					}
					break
				}
				case "reinstall": {
					if (!modulePresent) {
						throw new TaskError({
							message:
								"Explicit reinstall requires an existing non-empty canister.",
						})
					}
					break
				}
				case "upgrade": {
					if (!modulePresent) {
						throw new TaskError({
							message:
								"Explicit upgrade requires an existing non-empty canister.",
						})
					}
					break
				}
			}
			logger.logDebug(
				`Installing code for ${canisterId} at ${wasmPath} with mode ${mode}`,
			)
			// 🔁 makeInstallTask.effect – wrap installCode
			try {
				await replica.installCode({
					canisterId,
					wasm,
					encodedArgs: initArgs.encoded,
					identity,
					mode,
				})
			} catch (e) {
				if (e instanceof CanisterInstallError || e instanceof CanisterStatusError || e instanceof AgentError) {
					throw e
				}
				throw new AgentError({ message: String(e) })
			}
			// const Deployments = yield* DeploymentsService
			try {
				await taskCtx.deployments.set({
					canisterName,
					network: taskCtx.network,
					deployment: {
						installArgsHash: hashConfig(installArgs.fn),
						upgradeArgsHash: hashConfig(upgradeArgs.fn),
						wasmHash: hashUint8(wasm),
						mode,
						updatedAt: Date.now(),
					},
				})
			} catch (error) {
				throw new TaskError({ message: String(error) })
			}
			logger.logDebug(`Code installed for ${canisterId}`)
			logger.logDebug(
				`Canister ${canisterName} installed successfully`,
			)
			let actor
			try {
				actor = await replica.createActor<_SERVICE>({
					canisterId,
					canisterDID,
					identity,
				})
			} catch (e) {
				if (e instanceof AgentError) {
					throw e
				}
				throw new AgentError({ message: String(e) })
			}
			return {
				args: initArgs.raw,
				encodedArgs: initArgs.encoded,
				canisterId,
				canisterName,
				mode,
				actor,
				// wasm,
				// TODO: plugin which transforms install tasks?
				// actor: proxyActor(canisterName, actor),
			}
		},
		description: "Install canister code",
		tags: [Tags.CANISTER, Tags.CUSTOM, Tags.INSTALL],
		// TODO: add network?
		// TODO: pocket-ic could be restarted?
		computeCacheKey: (input) => {
			// // Mode-aware arg hashing to avoid invalidating cache on unrelated arg fns
			// // If upgrade and install digests are identical (no-op init changes), normalize to install
			// const sameArgs = input.upgradeArgsDigest === input.installArgsDigest
			// const argsDigest = sameArgs
			// ? ("install:" + input.installArgsDigest)
			// : (input.mode === "upgrade"
			// 	? "upgrade:" + input.upgradeArgsDigest
			// 	: "install:" + input.installArgsDigest)

			const argsDigest =
				input.computedMode === "upgrade"
					? input.upgradeArgsDigest
					: input.installArgsDigest
			const keyInput = {
				depsHash: hashJson(input.depCacheKeys),
				canisterId: input.canisterId,
				network: input.network,
				wasmDigest: hashJson(input.wasmDigest),
				candidDigest: hashJson(input.candidDigest),
				mode: input.computedMode,
				argsDigest,
			}
            const cacheKey = hashJson(keyInput)
			return cacheKey
			// return `${input.canisterId}:${input.computedMode}:${argsDigest}`
		},
		input: async (taskCtx) => {
			const { args } = taskCtx
			const { taskPath, depResults } = taskCtx
			const taskArgs = args as InstallTaskArgs
			const canisterName = taskPath
				.split(":")
				.slice(0, -1)
				.join(":")
			const dependencies = depResults as {
				[K in keyof {
					install_args: InstallArgsTask<_SERVICE, I, U>
				}]: {
					result: TaskReturnValue<
						InstallArgsTask<_SERVICE, I, U>
					>
					cacheKey: string | undefined
				}
			}
			const filteredDeps = Object.fromEntries(
				Object.entries(dependencies).filter(([key]) => key !== "install_args")
			)
			const depCacheKeys = Object.fromEntries(
				Object.entries(filteredDeps).map(([key, dep]) => [key, dep.cacheKey])
			)
			const maybeCanisterId = await loadCanisterId(
				taskCtx,
				taskPath,
			)
			if (Option.isNone(maybeCanisterId)) {
				logger.logDebug(
					`Canister ${canisterName} is not installed`,
					maybeCanisterId,
				)
				throw new TaskError({
					message: `Canister ${canisterName} is not installed`,
				})
			}
			const canisterId = maybeCanisterId.value

			const {
				network,
				// replica,
				// roles: {
				// 	deployer: { identity },
				// },
			} = taskCtx
			const { installArgs, upgradeArgs } = depResults[
				"install_args"
			]?.result as TaskSuccess<InstallArgsTask<_SERVICE, I, U>>

			const installArgsDigest = hashConfig(installArgs.fn)
			const upgradeArgsDigest = hashConfig(upgradeArgs.fn)
			const wasmDigest = await digestFileEffect(taskArgs.wasm)
			// TODO: customEncoding?
			const candidDigest = taskArgs.candid
				? await digestFileEffect(taskArgs.candid)
				: {
						path: "",
						mtimeMs: 0,
						sha256: "",
					}
			const resolvedMode = await resolveMode(taskCtx, canisterId)
			let deployment
			try {
				deployment = await taskCtx.deployments.get(
					canisterName,
					network,
				)
			} catch (error) {
				throw new TaskError({ message: String(error) })
			}
			// const deploymentId = deployment?.updatedAt ?? Date.now()
			if (
				resolvedMode === "reinstall" &&
				!taskArgs.forceReinstall &&
				taskCtx.origin !== "extension"
				// TODO: check if running from extension
			) {
				let confirmResult
				try {
					confirmResult = await taskCtx.prompts.confirm({
						message: `Are you sure you want to reinstall the canister (${canisterName})? This will wipe all state.`,
						initialValue: false,
					})
				} catch (error) {
					throw new TaskError({ message: String(error) })
				}
				if (!confirmResult) {
					throw new TaskCancelled({
						message: "Reinstall cancelled",
					})
				}
			}
			const computedMode =
				resolvedMode === "upgrade"
					? ("upgrade" as const)
					: ("install" as const)

			const input = {
				canisterId,
				// canisterName,
				network,
				computedMode,
				resolvedMode,
				wasmDigest,
				candidDigest,
				depCacheKeys,
				installArgsDigest,
				upgradeArgsDigest,
				// deploymentId,
			}
			return input
		},
		revalidate: async (taskCtx, { input }) => {
			const {
				replica,
				roles: { deployer },
				args,
			} = taskCtx
			if (input.resolvedMode === "reinstall") {
				return true
			}
			// const canisterName = taskCtx.taskPath.split(":")[0]!
			const canisterName = taskCtx.taskPath
				.split(":")
				.slice(0, -1)
				.join(":")
			// const lastDeployment = yield* DeploymentsService.get(input.canisterName, input.network)
			let lastDeployment
			try {
				lastDeployment = await taskCtx.deployments.get(
					canisterName,
					taskCtx.network,
				)
			} catch (error) {
				throw new TaskError({ message: String(error) })
			}
			const installArgsChanged =
				input.installArgsDigest !==
				lastDeployment?.installArgsHash
			const upgradeArgsChanged =
				input.upgradeArgsDigest !==
				lastDeployment?.upgradeArgsHash
			if (
				input.resolvedMode === "install" &&
				installArgsChanged
			) {
				return true
			}
			if (
				input.resolvedMode === "upgrade" &&
				upgradeArgsChanged
			) {
				return true
			}
			// const taskArgs = args as InstallTaskArgs
			// const requestedMode = taskArgs.mode
			let info
			try {
				info = await replica.getCanisterInfo({
					canisterId: input.canisterId,
					identity: deployer.identity,
				})
			} catch (e) {
				if (e instanceof CanisterStatusError || e instanceof AgentError) {
					throw e
				}
				throw new AgentError({ message: String(e) })
			}
			if (
				info.status === CanisterStatus.NOT_FOUND ||
				info.module_hash.length === 0
			) {
				return true
			}
			return false
		},
		encodingFormat: "string",

		encode: async (taskCtx, result, input) => {
			logger.logDebug(
				"encoding task result",
				//  result
			)
			return await encodeWithBigInt({
				canisterId: result.canisterId,
				canisterName: result.canisterName,
				mode: result.mode,
				encodedArgs: uint8ArrayToJsonString(result.encodedArgs),
				args: result.args,
			})
		},
		decode: async (taskCtx, value, input) => {
			const {
				canisterId,
				canisterName,
				mode,
				encodedArgs: encodedArgsString,
				args: initArgs,
			} = (await decodeWithBigInt(value as string)) as {
				canisterId: string
				canisterName: string
				mode: InstallModes
				encodedArgs: string
				args: I | U
			}
			const encodedArgs =
				jsonStringToUint8Array(encodedArgsString)
			const {
				replica,
				roles: {
					deployer: { identity },
				},
			} = taskCtx
			const { appDir, iceDir, args } = taskCtx
			const taskArgs = args as InstallTaskArgs
			const didJSPath = join(
				iceDir,
				"canisters",
				canisterName,
				`${canisterName}.did.js`,
			)
			// TODO: we should create a service that caches these?
			// expensive to import every time
			// or task? return from bindings task?
			let canisterDID
			try {
				canisterDID = await import(didJSPath) as CanisterDidModule
			} catch (e) {
				throw new TaskError({
					message: "Failed to load canisterDID",
				})
			}
			let actor
			try {
				actor = await replica.createActor<_SERVICE>({
					canisterId,
					canisterDID,
					identity,
				})
			} catch (e) {
				if (e instanceof AgentError) {
					throw e
				}
				throw new AgentError({ message: String(e) })
			}
			// // Always reflect the CURRENT resolved mode rather than the cached one
			// const currentMode = input.mode
			const decoded = {
				// mode: currentMode,
				mode,
				canisterId,
				canisterName,
				// TODO: plugin which transforms upgrade tasks?
				// actor: proxyActor(canisterName, actor),
				actor,
				encodedArgs,
				args: initArgs,
			}
			return decoded
		},
	} satisfies InstallTask<_SERVICE, I, U>
}

export const linkChildren = <A extends Record<string, Task>>(
	children: A,
): A => {
	// 1️⃣  fresh copies with new ids
	const fresh = Record.map(children, (task) => ({
		...task,
		id: Symbol("task"),
	})) as A

	// 2️⃣  start with fresh, then relink all edges to the final map
	const linked = { ...fresh } as A

	for (const k in linked) {
		const t = linked[k] as Task
		// @ts-ignore
		linked[k] = {
			...t,
			dependsOn: Record.map(t.dependsOn, (v, key) =>
				key in linked ? linked[key as keyof A] : v,
			),
			dependencies: Record.map(t.dependencies, (v, key) =>
				key in linked ? linked[key as keyof A] : v,
			),
		} as Task
	}

	return linked
}

/**
 * Represents the expected structure of a dynamically imported DID module.
 */
export interface CanisterDidModule {
	idlFactory: IDL.InterfaceFactory
	init: (args: { IDL: typeof IDL }) => IDL.Type[]
}
