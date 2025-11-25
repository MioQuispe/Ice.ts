import { IDL } from "@icp-sdk/core/candid"
import { FileSystem, Path } from "@effect/platform"
import { sha256 } from "@noble/hashes/sha2"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils"
import { StandardSchemaV1 } from "@standard-schema/spec"
import { type } from "arktype"
import {
	Data,
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	Record,
	Logger,
	LogLevel,
	ConfigProvider,
	Context,
	Match,
} from "effect"
import { readFileSync, realpathSync } from "node:fs"
import { stat } from "node:fs/promises"
import { NodeContext } from "@effect/platform-node"
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
import { type TaskCtx, makeLoggerLayer } from "../services/taskRuntime.js"

export { makeLoggerLayer }
import { IceDir } from "../services/iceDir.js"
import { ConfigError } from "effect/ConfigError"
import { PlatformError } from "@effect/platform/Error"
import { layerFileSystem } from "@effect/platform/KeyValueStore"
import { DeploymentsService } from "../services/deployments.js"
import { confirm } from "@clack/prompts"
import { Schema } from "effect"
import { ClackLoggingLive } from "../services/logger.js"

// Schema.TaggedError

const baseLayer = Layer.mergeAll(
	NodeContext.layer,
	Moc.Live.pipe(Layer.provide(NodeContext.layer)),
	ClackLoggingLive,
	// Note: Logger.minimumLogLevel is provided at runtime via taskCtx.logLevel
)
export const defaultBuilderRuntime = ManagedRuntime.make(baseLayer)
type BuilderLayer = typeof baseLayer

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

export const loadCanisterId = (taskCtx: TaskCtx, taskPath: string) =>
	Effect.gen(function* () {
		const { network } = taskCtx
		const canisterName = taskPath.split(":").slice(0, -1).join(":")
		// const canisterIdsService = yield* CanisterIdsService
		const canisterIds = yield* Effect.tryPromise({
			try: () => taskCtx.canisterIds.getCanisterIds(),
			catch: (error) => {
				return new TaskError({ message: String(error) })
			},
		})
		const canisterId = canisterIds[canisterName]?.[network]
		if (canisterId) {
			return Option.some(canisterId as string)
		}
		return Option.none()
	})

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
	configOrFn:
		| ((args: { ctx: TaskCtx }) => Promise<Config>)
		| ((args: { ctx: TaskCtx }) => Config)
		| Config,
) => {
	const runtime = defaultBuilderRuntime
	return {
		_tag: "task",
		description: "Config task",
		tags: [Tags.CANISTER, Tags.CONFIG],
		dependsOn: {} as D,
		dependencies: {} as P,
		namedParams: {},
		params: {},
		positionalParams: [],
		effect: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_effect")(function* () {
					if (typeof configOrFn === "function") {
						const configFn = configOrFn as (args: {
							ctx: TaskCtx
						}) => Promise<Config> | Config
						const configResult = configFn({ ctx: taskCtx })
						if (configResult instanceof Promise) {
							return yield* Effect.tryPromise({
								try: () => configResult,
								catch: (error) => {
									return new TaskError({
										message: String(error),
									})
								},
							})
						}
						return configResult
					}
					return configOrFn
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
		id: Symbol("canister/config"),
		input: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_input")(function* () {
					const { depResults } = taskCtx
					const depCacheKeys = Record.map(
						depResults,
						(dep) => dep.cacheKey,
					)
					return {
						depCacheKeys,
					}
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".input"),
				),
			),
		encode: (taskCtx, value) =>
			runtime.runPromise(
				Effect.fn("task_encode")(function* () {
					return JSON.stringify(value)
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".encode"),
				),
			),
		encodingFormat: "string",
		decode: (taskCtx, value) =>
			runtime.runPromise(
				Effect.fn("task_decode")(function* () {
					return JSON.parse(value as string)
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".decode"),
				),
			),
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
	configTask: ConfigTask<Config>,
	tags: string[] = [],
): CreateTask => {
	const id = Symbol("canister/create")
	const runtime = defaultBuilderRuntime
	return {
		_tag: "task",
		id,
		dependsOn: {},
		dependencies: {
			config: configTask,
		},
		effect: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_effect")(function* () {
					const path = yield* Path.Path
					const fs = yield* FileSystem.FileSystem
					// const canisterIdsService = yield* CanisterIdsService
					const network = taskCtx.network
					const { taskPath } = taskCtx
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					const storedCanisterIds = yield* Effect.tryPromise({
						try: () => taskCtx.canisterIds.getCanisterIds(),
						catch: (error) => {
							return new TaskError({ message: String(error) })
						},
					})
					// const storedCanisterIds =
					// 	yield* canisterIdsService.getCanisterIds()
					const storedCanisterId =
						storedCanisterIds[canisterName]?.[network]
					yield* Effect.logDebug("makeCreateTask", {
						storedCanisterId,
					})
					const depResults = taskCtx.depResults
					const canisterConfig = depResults["config"]
						?.result as Config
					// const canisterConfig = yield* resolveConfig(
					// 	taskCtx,
					// 	canisterConfigOrFn,
					// )
					const configCanisterId = canisterConfig?.canisterId
					// TODO: handle all edge cases related to this. what happens
					// if the user provides a new canisterId in the config? and so on
					// and how about mainnet?
					const resolvedCanisterId =
						storedCanisterId ?? configCanisterId

					const {
						roles: {
							deployer: { identity },
						},
						replica,
					} = taskCtx
					yield* Effect.logDebug("resolvedCanisterId", {
						resolvedCanisterId,
					})
					const canisterInfo = resolvedCanisterId
						? yield* Effect.tryPromise<
								CanisterStatusResult,
								CanisterStatusError | AgentError
							>({
								try: () =>
									replica.getCanisterInfo({
										canisterId: resolvedCanisterId,
										identity,
									}),
								catch: (e) =>
									e instanceof CanisterStatusError ||
									e instanceof AgentError
										? e
										: new AgentError({
												message: String(e),
											}),
							}).pipe(
								Effect.catchTag("CanisterStatusError", () =>
									Effect.succeed({
										status: CanisterStatus.NOT_FOUND,
									} as const),
								),
							)
						: ({ status: CanisterStatus.NOT_FOUND } as const)
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

					yield* Effect.logDebug("makeCreateTask", {
						isAlreadyInstalled,
						resolvedCanisterId,
					})

					const canisterId = isAlreadyInstalled
						? resolvedCanisterId
						: // ⬇️ Replace the whole `canisterId = ...` ternary RHS with this:
							yield* Effect.tryPromise<
								string,
								| CanisterCreateError
								| CanisterCreateRangeError
								| CanisterStatusError
								| AgentError
							>({
								// IMPORTANT: do NOT wrap here — preserve the original tagged error
								try: () =>
									replica.createCanister({
										canisterId: resolvedCanisterId,
										identity,
									}),
								catch: (e) =>
									e as
										| CanisterCreateError
										| CanisterCreateRangeError
										| CanisterStatusError
										| AgentError,
							}).pipe(
								// Now the tag is preserved, so this branch actually triggers
								Effect.catchTag(
									"CanisterCreateRangeError",
									() => {
										return Effect.gen(function* () {
											const confirmResult =
												yield* Effect.tryPromise({
													try: () => {
														if (
															taskCtx.origin ===
															"extension"
														) {
															return Promise.resolve(
																true,
															)
														}
														return taskCtx.prompts.confirm(
															{
																message:
																	"Target canister id is not in subnet range. Do you want to create a new canister id for it?",
																initialValue: true,
															},
														)
													},
													catch: (error) =>
														new TaskError({
															message:
																String(error),
														}),
												})
											if (!confirmResult) {
												return yield* Effect.fail(
													new TaskCancelled({
														message:
															"Canister creation cancelled",
													}),
												)
											}
											// second attempt with a fresh canister id
											return yield* Effect.tryPromise<
												string,
												| CanisterCreateError
												| CanisterCreateRangeError
												| CanisterStatusError
												| AgentError
											>({
												try: () =>
													replica.createCanister({
														canisterId: undefined,
														identity,
													}),
												// again: don't wrap, preserve tag
												catch: (e) =>
													e as
														| CanisterCreateError
														| CanisterCreateRangeError
														| CanisterStatusError
														| AgentError,
											})
										})
									},
								),
								// Finally wrap truly-unknown errors as CanisterCreateError
								Effect.catchAll((e) => {
									const tag = (e as any)?._tag
									return tag === "CanisterCreateError" ||
										tag === "CanisterCreateRangeError" ||
										tag === "CanisterStatusError" ||
										tag === "AgentError"
										? Effect.fail(e as any)
										: Effect.fail(
												new CanisterCreateError({
													message: String(e),
													cause: e as any,
												}),
											)
								}),
							)
					const { appDir, iceDir } = taskCtx
					yield* Effect.logDebug(
						"create Task: setting canisterId",
						canisterId,
					)
					yield* Effect.tryPromise({
						try: () =>
							taskCtx.canisterIds.setCanisterId({
								canisterName,
								network: taskCtx.network,
								canisterId,
							}),
						catch: (error) => {
							return new TaskError({ message: String(error) })
						},
					})
					const outDir = path.join(iceDir, "canisters", canisterName)
					yield* fs.makeDirectory(outDir, { recursive: true })
					return canisterId
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
		encode: (taskCtx, value) =>
			runtime.runPromise(
				Effect.fn("task_encode")(function* () {
					return JSON.stringify(value)
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".encode"),
				),
			),
		decode: (taskCtx, value) =>
			runtime.runPromise(
				Effect.fn("task_decode")(function* () {
					return JSON.parse(value as string)
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".decode"),
				),
			),
		encodingFormat: "string",
		computeCacheKey: (input) => {
			return hashJson({
				canisterName: input.canisterName,
				// canisterId: input.canisterId,
				network: input.network,
			})
		},
		input: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_input")(function* () {
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
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".input"),
				),
			),
		revalidate: (taskCtx, { input }) =>
			runtime.runPromise(
				Effect.fn("task_revalidate")(function* () {
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
					// const canisterConfig = yield* resolveConfig(
					// 	taskCtx,
					// 	canisterConfigOrFn,
					// )
					const storedCanisterIds = yield* Effect.tryPromise({
						try: () => taskCtx.canisterIds.getCanisterIds(),
						catch: (error) => {
							return new TaskError({ message: String(error) })
						},
					})
					const configCanisterId = canisterConfig?.canisterId
					// const storedCanisterIds =
					// 	yield* canisterIdsService.getCanisterIds()
					const storedCanisterId =
						storedCanisterIds[canisterName]?.[network]
					// TODO: handle changes to configCanisterId
					// Prefer an existing/stored id; fallback to config-provided id; may be undefined on first run
					const resolvedCanisterId =
						storedCanisterId ?? configCanisterId

					if (!resolvedCanisterId) {
						return true
					}

					// 🔁 makeCanisterStatusTask.effect – wrap getCanisterInfo
					const info = yield* Effect.tryPromise<
						CanisterStatusResult,
						CanisterStatusError | AgentError
					>({
						try: () =>
							replica.getCanisterInfo({
								canisterId: resolvedCanisterId,
								identity: deployer.identity,
							}),
						catch: (e) =>
							e instanceof CanisterStatusError ||
							e instanceof AgentError
								? e
								: new AgentError({ message: String(e) }),
					})
					if (info.status === CanisterStatus.NOT_FOUND) {
						return true
					}
					const moduleHash = info.module_hash ?? []
					if (moduleHash.length === 0) {
						return true
					}

					return false
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs(
						"path",
						taskCtx.taskPath + ".revalidate",
					),
				),
			),
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

export const isArtifactCached = (
	path: string,
	prev: FileDigest | undefined, // last run (undefined = cache miss)
) =>
	Effect.gen(function* () {
		// No previous record – must rebuild
		if (!prev) {
			return { fresh: false, digest: yield* digestFileEffect(path) }
		}
		const fs = yield* FileSystem.FileSystem

		// 1️⃣ fast-path : stat only
		const stat = yield* fs.stat(path)
		const mtimeMs = Option.isSome(stat.mtime)
			? stat.mtime.value.getTime()
			: 0
		if (mtimeMs === prev.mtimeMs) {
			return { fresh: true, digest: prev } // timestamps match ⟹ assume fresh
		}

		// 2️⃣ slow-path : hash check
		const digest = yield* digestFileEffect(path)
		const fresh = digest.sha256 === prev.sha256
		return { fresh, digest }
	})

export const digestFileEffect = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const buf = yield* fs.readFile(path)
		const stat = yield* fs.stat(path)
		const mtimeMs = Option.isSome(stat.mtime)
			? stat.mtime.value.getTime()
			: 0
		return {
			path,
			mtimeMs,
			sha256: bytesToHex(sha256(buf)),
		}
	})

export const isArtifactCachedEffect = (
	path: string,
	prev: FileDigest | undefined, // last run (undefined = cache miss)
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem

		// No previous record – must rebuild
		if (!prev) {
			const digest = yield* digestFileEffect(path)
			return { fresh: false, digest }
		}

		// 1️⃣ fast-path : stat only
		const currentStat = yield* fs.stat(path)
		const mtimeMs = Option.isSome(currentStat.mtime)
			? currentStat.mtime.value.getTime()
			: 0
		if (mtimeMs === prev.mtimeMs) {
			return { fresh: true, digest: prev } // timestamps match ⟹ assume fresh
		}

		// 2️⃣ slow-path : hash check
		const digest = yield* digestFileEffect(path)
		const fresh = digest.sha256 === prev.sha256
		return { fresh, digest }
	})

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
			: JSON.stringify(config, (_, value) => {
					if (typeof value === "bigint") {
						return { __type__: "bigint", value: value.toString() }
					}
					return value
				})

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
	effect: Effect.Effect<infer S, any, any>
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
	effect: Effect.Effect<infer S, any, any>
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

export const makeStopTask = (): StopTask => {
	const runtime = defaultBuilderRuntime
	return {
		_tag: "task",
		id: Symbol("customCanister/stop"),
		dependsOn: {},
		dependencies: {},
		// TODO: do we allow a fn as args here?
		effect: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_effect")(function* () {
					const { taskPath } = taskCtx
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					// TODO: handle error
					const maybeCanisterId = yield* loadCanisterId(
						taskCtx,
						taskPath,
					)
					if (Option.isNone(maybeCanisterId)) {
						yield* Effect.logDebug(
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
					const status = yield* Effect.tryPromise<
						CanisterStatus,
						CanisterStatusError | AgentError
					>({
						try: () =>
							replica.getCanisterStatus({ canisterId, identity }),
						catch: (e) =>
							e instanceof CanisterStatusError ||
							e instanceof AgentError
								? e
								: new AgentError({ message: String(e) }),
					})

					if (status === CanisterStatus.STOPPED) {
						yield* Effect.logDebug(
							`Canister ${canisterName} is already stopped or not installed`,
							status,
						)
						return
					}
					yield* Effect.tryPromise<
						void,
						CanisterStopError | AgentError
					>({
						try: () =>
							replica.stopCanister({ canisterId, identity }),
						catch: (e) =>
							e instanceof CanisterStopError ||
							e instanceof AgentError
								? e
								: new AgentError({ message: String(e) }),
					})
					yield* Effect.logDebug(`Stopped canister ${canisterName}`)
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
		description: "Stop canister",
		// TODO: no tag custom
		tags: [Tags.CANISTER, Tags.STOP],
		namedParams: {},
		positionalParams: [],
		params: {},
	} satisfies Task<void>
}

export const makeRemoveTask = (): RemoveTask => {
	const runtime = defaultBuilderRuntime
	return {
		_tag: "task",
		id: Symbol("customCanister/remove"),
		dependsOn: {},
		dependencies: {},
		// TODO: do we allow a fn as args here?
		effect: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_effect")(function* () {
					const { taskPath } = taskCtx
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					// TODO: handle error
					const maybeCanisterId = yield* loadCanisterId(
						taskCtx,
						taskPath,
					)
					if (Option.isNone(maybeCanisterId)) {
						yield* Effect.logDebug(
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
					yield* Effect.tryPromise<
						void,
						CanisterDeleteError | AgentError
					>({
						try: () =>
							replica.removeCanister({ canisterId, identity }),
						catch: (e) =>
							e instanceof CanisterDeleteError ||
							e instanceof AgentError
								? e
								: new AgentError({ message: String(e) }),
					})
					yield* Effect.tryPromise({
						try: () =>
							taskCtx.canisterIds.removeCanisterId(canisterName),
						catch: (error) => {
							return new TaskError({ message: String(error) })
						},
					})
					// yield* canisterIdsService.removeCanisterId(canisterName)
					yield* Effect.logDebug(`Removed canister ${canisterName}`)
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
		description: "Remove canister",
		// TODO: no tag custom
		tags: [Tags.CANISTER, Tags.REMOVE],
		namedParams: {},
		positionalParams: [],
		params: {},
	} satisfies RemoveTask
}

export const makeCanisterStatusTask = (
	tags: string[],
): StatusTask => {
	const runtime = defaultBuilderRuntime
	return {
		_tag: "task",
		// TODO: change
		id: Symbol("canister/status"),
		dependsOn: {},
		// TODO: we only want to warn at a type level?
		// TODO: type Task
		dependencies: {},
		effect: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_effect")(function* () {
					// TODO:
					const { replica, network } = taskCtx
					const { taskPath } = taskCtx
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					const canisterIdsMap = yield* Effect.tryPromise({
						try: () => taskCtx.canisterIds.getCanisterIds(),
						catch: (error) => {
							return new TaskError({ message: String(error) })
						},
					})
					// const canisterIdsMap =
					// 	yield* canisterIdsService.getCanisterIds()
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
					const canisterInfo = yield* Effect.tryPromise<
						CanisterStatusResult,
						CanisterStatusError | AgentError
					>({
						try: () =>
							replica.getCanisterInfo({ canisterId, identity }),
						catch: (e) =>
							e instanceof CanisterStatusError ||
							e instanceof AgentError
								? e
								: new AgentError({ message: String(e) }),
					})
					const status = canisterInfo.status
					return {
						canisterName,
						canisterId,
						status,
						info: canisterInfo,
					}
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
		description: "Get canister status",
		tags: [Tags.CANISTER, Tags.STATUS, ...tags],
		namedParams: {},
		positionalParams: [],
		params: {},
	} satisfies StatusTask
}

export const resolveMode = (
	taskCtx: TaskCtx,
	configCanisterId: string | undefined,
	// TODO: REMOVE! temporary hack. clean up
	unCached: boolean = false,
) => {
	return Effect.gen(function* () {
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
		const canisterIdsMap = yield* Effect.tryPromise({
			try: () => taskCtx.canisterIds.getCanisterIds(),
			catch: (error) => {
				return new TaskError({ message: String(error) })
			},
		})
		// const canisterIdsMap = yield* canisterIdsService.getCanisterIds()
		const canisterId =
			canisterIdsMap[canisterName]?.[network] ?? configCanisterId
		// TODO: use Option.Option?
		// 🔁 resolveMode – wrap getCanisterInfo (+ keep your catchTag branch)
		const canisterInfo = canisterId
			? yield* Effect.tryPromise<
					CanisterStatusResult,
					CanisterStatusError | AgentError
				>({
					try: () =>
						replica.getCanisterInfo({
							canisterId,
							identity,
						}),
					catch: (e) =>
						e instanceof CanisterStatusError ||
						e instanceof AgentError
							? e
							: new AgentError({ message: String(e) }),
				}).pipe(
					Effect.catchTag("CanisterStatusError", () =>
						Effect.succeed({
							status: CanisterStatus.NOT_FOUND,
						} as const),
					),
				)
			: ({ status: CanisterStatus.NOT_FOUND } as const)

		const noModule =
			canisterInfo.status === CanisterStatus.NOT_FOUND ||
			canisterInfo.module_hash.length === 0

		const lastDeployment = Option.fromNullable(
			yield* Effect.tryPromise({
				try: () => taskCtx.deployments.get(canisterName, network),
				catch: (error) => {
					return new TaskError({ message: String(error) })
				},
			}),
		)
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
		yield* Effect.logDebug("resolveMode", {
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
	})
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
const encodeWithBigInt = (obj: unknown) =>
	Effect.try<string, TaskError>({
		try: () =>
			JSON.stringify(obj, (_, value) => {
				if (typeof value === "bigint") {
					return { __type__: "bigint", value: value.toString() }
				}
				return value
			}),
		catch: (e) =>
			new TaskError({
				message: "Encoding failed",
			}),
	})

// Decoding with type restoration
const decodeWithBigInt = (str: string) =>
	Effect.try<unknown, TaskError>({
		try: () =>
			JSON.parse(str, (_, value) => {
				if (
					value &&
					typeof value === "object" &&
					value.__type__ === "bigint"
				) {
					return BigInt(value.value)
				}
				return value
			}),
		catch: (e) =>
			new TaskError({
				message: "Decoding failed",
			}),
	})

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
		decode: (value: string) => value as InstallModes,
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
		decode: (value: string) => {
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
		decode: (value: string) => !!value as unknown as boolean,
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
		decode: (value: string) => value as string,
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
		decode: (value: string) => value as string,
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
		decode: (value: string) => value as string,
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
	// 	decode: (value: string) => value as InstallModes,
	// },
}

export const makeInstallArgsTask = <
	_SERVICE,
	I,
	U,
	D extends Record<string, Task>,
	P extends Record<string, Task>,
>(
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
	const runtime = defaultBuilderRuntime
	return {
		_tag: "task",
		id: Symbol("customCanister/install_args"),
		dependsOn: {} as D,
		dependencies,
		// TODO: allow passing in candid as a string from CLI
		namedParams: installArgsParams,
		positionalParams: [],
		params: installArgsParams,
		effect: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_effect")(function* () {
					yield* Effect.logDebug(
						"Starting custom canister installation",
					)
					const path = yield* Path.Path
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

					yield* Effect.logDebug("Starting install args generation")

					let initArgs = [] as unknown as I | U
					yield* Effect.logDebug("Executing install args function")

					// TODO: use params?
					const didJSPath = path.join(
						iceDir,
						"canisters",
						canisterName,
						`${canisterName}.did.js`,
					)

					// TODO: should it catch errors?
					// TODO: handle different modes
					const deps = Record.map(
						depResults,
						(dep) => dep.result,
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
						installArgsResult = yield* Effect.tryPromise<
							I,
							TaskError
						>({
							try: () => installFnResult,
							catch: (e) =>
								new TaskError({
									message: `Install args function failed for: ${canisterName},
						typeof installArgsFn: ${typeof installArgs.fn},
						 typeof installResult: ${typeof installFnResult}
						 error: ${e},
						 installArgsFn: ${installArgs.fn},
						 installResult: ${installFnResult},
						 `,
								}),
						})
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
						upgradeArgsResult = yield* Effect.tryPromise<
							U,
							TaskError
						>({
							try: () => upgradeFnResult,
							catch: (e) =>
								new TaskError({
									message: `Install args function failed for: ${canisterName},
						typeof installArgsFn: ${typeof upgradeArgs.fn},
						 typeof installResult: ${typeof upgradeFnResult}
						 error: ${e},
						 installArgsFn: ${upgradeArgs.fn},
						 installResult: ${upgradeFnResult},
						 `,
								}),
						})
					} else {
						upgradeArgsResult = upgradeFnResult
					}

					yield* Effect.logDebug(
						"Install args generated",
						//     {
						// 	installArgsResult,
						// 	upgradeArgsResult,
						// }
					)

					const canisterDID = yield* Effect.tryPromise({
						try: () =>
							import(didJSPath) as Promise<CanisterDidModule>,
						catch: (e) => {
							return new TaskError({
								message: "Failed to load canisterDID",
							})
						},
					})
					yield* Effect.logDebug(
						"Encoding args install args",
						//     {
						// 	installArgsResult,
						// 	canisterDID,
						// }
					)
					// TODO: do we accept simple objects as well?
					// let encodedArgs
					const encodedInstallArgs = installArgs.customEncode
						? yield* Effect.tryPromise({
								try: () =>
									installArgs.customEncode!(
										installArgsResult,
										"install",
									),
								catch: (error) => {
									return new TaskError({
										message: `customEncode failed, error: ${error}`,
									})
								},
							})
						: yield* encodeArgs(
								installArgsResult as unknown[],
								canisterDID,
							)

					const encodedUpgradeArgs = upgradeArgs.customEncode
						? yield* Effect.tryPromise({
								try: () =>
									upgradeArgs.customEncode!(
										upgradeArgsResult,
										"upgrade",
									), // typescript cant infer properly
								catch: (error) => {
									return new TaskError({
										message: `customEncode failed, error: ${error}`,
									})
								},
							})
						: yield* encodeArgs(
								upgradeArgsResult as unknown[],
								canisterDID,
							)

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
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
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
		input: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_input")(function* () {
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
					const depCacheKeys = Record.map(
						dependencies,
						(dep) => dep.cacheKey,
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
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".input"),
				),
			),
		encodingFormat: "string",

		encode: (taskCtx, result, input) =>
			runtime.runPromise(
				Effect.fn("task_encode")(function* () {
					yield* Effect.logDebug(
						"Encoding args for",
						result.canisterName,
					)
					return yield* encodeWithBigInt({
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
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".encode"),
				),
			),
		decode: (taskCtx, value, input) =>
			runtime.runPromise(
				Effect.fn("task_decode")(function* () {
					const {
						canisterName,
						installArgs: decodedInstallArgs,
						upgradeArgs: decodedUpgradeArgs,
					} = (yield* decodeWithBigInt(value as string)) as {
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
					const path = yield* Path.Path
					const didJSPath = path.join(
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
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".decode"),
				),
			),
	} satisfies InstallArgsTask<_SERVICE, I, U, D, P>
}

export const makeInstallTask = <_SERVICE, I, U>(
	installArgsTask: InstallArgsTask<_SERVICE, I, U>,
): InstallTask<_SERVICE, I, U> => {
	// TODO: canister installed, but cache deleted. should use reinstall, not install
	const runtime = defaultBuilderRuntime
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
		effect: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_effect")(function* () {
					yield* Effect.logDebug(
						"Starting custom canister installation",
					)
					const path = yield* Path.Path
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

					yield* Effect.logDebug("Starting install args generation")

					const { installArgs, upgradeArgs } = depResults[
						"install_args"
					]?.result as TaskSuccess<InstallArgsTask<_SERVICE, I, U>>

					// TODO: Clean up. temporary hack. also cache it?
					let mode = yield* resolveMode(taskCtx, canisterId, true)
					// TODO: returns install instead of reinstall....
					// slightly different from resolveMode in input??
					// if (mode === "install" && requestedMode === "auto" && !noModule) {
					//     mode = "reinstall"
					// }

					yield* Effect.logDebug("Resolved mode in install effect", {
						mode,
					})
					const initArgs =
						mode === "install" || mode === "reinstall"
							? installArgs
							: upgradeArgs
					yield* Effect.logDebug("Executing install args function")

					// TODO: use params
					const didJSPath = path.join(
						iceDir,
						"canisters",
						canisterName,
						`${canisterName}.did.js`,
					)

					const canisterDID = yield* Effect.tryPromise({
						try: () =>
							import(didJSPath) as Promise<CanisterDidModule>,
						catch: (e) => {
							return new TaskError({
								message: "Failed to load canisterDID",
							})
						},
					})
					yield* Effect.logDebug(
						"Loaded canisterDID",
						//     {
						// 	canisterDID,
						// }
					)
					const fs = yield* FileSystem.FileSystem

					// TODO:
					// they can return the values we need perhaps? instead of reading from fs
					// we need the wasm blob and candid DIDjs / idlFactory?
					const wasmContent = yield* fs.readFile(wasmPath)
					const wasm = new Uint8Array(wasmContent)
					const maxSize = 3670016
					// Enforce explicit mode preconditions
					const canisterInfo = yield* Effect.tryPromise<
						CanisterStatusResult,
						CanisterStatusError | AgentError
					>({
						try: () =>
							replica.getCanisterInfo({ canisterId, identity }),
						catch: (e) =>
							e instanceof CanisterStatusError ||
							e instanceof AgentError
								? e
								: new AgentError({ message: String(e) }),
					})
					const modulePresent =
						canisterInfo.status !== CanisterStatus.NOT_FOUND &&
						canisterInfo.module_hash.length > 0
					switch (mode) {
						case "install": {
							if (modulePresent) {
								return yield* Effect.fail(
									new TaskError({
										message:
											"Explicit install not allowed on non-empty canister. Use reinstall.",
									}),
								)
							}
							break
						}
						case "reinstall": {
							if (!modulePresent) {
								return yield* Effect.fail(
									new TaskError({
										message:
											"Explicit reinstall requires an existing non-empty canister.",
									}),
								)
							}
							break
						}
						case "upgrade": {
							if (!modulePresent) {
								return yield* Effect.fail(
									new TaskError({
										message:
											"Explicit upgrade requires an existing non-empty canister.",
									}),
								)
							}
							break
						}
					}
					yield* Effect.logDebug(
						`Installing code for ${canisterId} at ${wasmPath} with mode ${mode}`,
					)
					// 🔁 makeInstallTask.effect – wrap installCode
					yield* Effect.tryPromise<
						void,
						CanisterInstallError | CanisterStatusError | AgentError
					>({
						try: () =>
							replica.installCode({
								canisterId,
								wasm,
								encodedArgs: initArgs.encoded,
								identity,
								mode,
							}),
						catch: (e) =>
							e instanceof CanisterInstallError ||
							e instanceof CanisterStatusError ||
							e instanceof AgentError
								? e
								: new AgentError({ message: String(e) }),
					})
					// Get previous deployment to use cached digests for fast path
					const maybePrevDeployment = yield* Effect.tryPromise({
						try: () =>
							taskCtx.deployments.get(canisterName, taskCtx.network),
						catch: (error) => {
							return new TaskError({ message: String(error) })
						},
					})
					
					// Extract previous digests if available
					const prevWasmDigest = maybePrevDeployment?.wasmHash &&
						maybePrevDeployment.wasmMtimeMs
						? {
								path: wasmPath,
								mtimeMs: maybePrevDeployment.wasmMtimeMs,
								sha256: maybePrevDeployment.wasmHash,
							}
						: undefined
					
					const prevCandidDigest =
						maybePrevDeployment?.candidHash &&
						maybePrevDeployment.candidMtimeMs &&
						candid
							? {
									path: candid,
									mtimeMs: maybePrevDeployment.candidMtimeMs,
									sha256: maybePrevDeployment.candidHash,
								}
							: undefined
					
					// Get digests using cached fast path
					const { digest: wasmDigest } = yield* isArtifactCachedEffect(
						wasmPath,
						prevWasmDigest,
					)
					
					const candidDigest = candid
						? (yield* isArtifactCachedEffect(candid, prevCandidDigest))
								.digest
						: undefined
					
					// const Deployments = yield* DeploymentsService
					yield* Effect.tryPromise({
						try: () =>
							taskCtx.deployments.set({
								canisterName,
								network: taskCtx.network,
								deployment: {
									installArgsHash: hashConfig(installArgs.fn),
									upgradeArgsHash: hashConfig(upgradeArgs.fn),
									wasmHash: wasmDigest.sha256,
									wasmMtimeMs: wasmDigest.mtimeMs,
									...(candidDigest
										? {
												candidHash: candidDigest.sha256,
												candidMtimeMs: candidDigest.mtimeMs,
											}
										: {}),
									mode,
									updatedAt: Date.now(),
								},
							}),
						catch: (error) => {
							return new TaskError({ message: String(error) })
						},
					})
					yield* Effect.logDebug(`Code installed for ${canisterId}`)
					yield* Effect.logDebug(
						`Canister ${canisterName} installed successfully`,
					)
					const actor = yield* Effect.tryPromise({
						try: () =>
							replica.createActor<_SERVICE>({
								canisterId,
								canisterDID,
								identity,
							}),
						catch: (e) =>
							e instanceof AgentError
								? e
								: new AgentError({ message: String(e) }),
					})
					return {
						args: initArgs.raw,
						encodedArgs: initArgs.encoded,
						canisterId,
						canisterName,
						mode,
						// actor,
						// wasm,
						// TODO: plugin which transforms install tasks?
						actor: proxyActor(canisterName, actor),
					}
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
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
		input: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_input")(function* () {
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
					const filteredDeps = Record.filter(
						dependencies,
						(_dep, key) => key !== "install_args",
					)
					const depCacheKeys = Record.map(
						filteredDeps,
						(dep) => dep.cacheKey,
					)
					const maybeCanisterId = yield* loadCanisterId(
						taskCtx,
						taskPath,
					)
					if (Option.isNone(maybeCanisterId)) {
						yield* Effect.logDebug(
							`Canister ${canisterName} is not installed`,
							maybeCanisterId,
						)
						return yield* Effect.fail(
							new TaskError({
								message: `Canister ${canisterName} is not installed`,
							}),
						)
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
					
					// Get previous deployment to use cached digests for fast path
					const maybeDeployment = yield* Effect.tryPromise({
						try: () => taskCtx.deployments.get(canisterName, network),
						catch: (error) => {
							return new TaskError({ message: String(error) })
						},
					})
					
					// Extract previous digests if available
					const prevWasmDigest =
						maybeDeployment?.wasmHash && maybeDeployment.wasmMtimeMs
							? {
									path: taskArgs.wasm,
									mtimeMs: maybeDeployment.wasmMtimeMs,
									sha256: maybeDeployment.wasmHash,
								}
							: undefined
					
					const prevCandidDigest =
						maybeDeployment?.candidHash &&
						maybeDeployment.candidMtimeMs &&
						taskArgs.candid
							? {
									path: taskArgs.candid,
									mtimeMs: maybeDeployment.candidMtimeMs,
									sha256: maybeDeployment.candidHash,
								}
							: undefined
					
					// Use isArtifactCachedEffect with previous digests for fast path
					const { digest: wasmDigest } = yield* isArtifactCachedEffect(
						taskArgs.wasm,
						prevWasmDigest,
					)
					
					// TODO: customEncoding?
					const candidDigest = taskArgs.candid
						? (yield* isArtifactCachedEffect(
								taskArgs.candid,
								prevCandidDigest,
							)).digest
						: {
								path: "",
								mtimeMs: 0,
								sha256: "",
							}
					
					const resolvedMode = yield* resolveMode(taskCtx, canisterId)
					// const deploymentId = deployment?.updatedAt ?? Date.now()
					if (
						resolvedMode === "reinstall" &&
						!taskArgs.forceReinstall &&
						taskCtx.origin !== "extension"
						// TODO: check if running from extension
					) {
						const confirmResult = yield* Effect.tryPromise({
							try: () =>
								taskCtx.prompts.confirm({
									message: `Are you sure you want to reinstall the canister (${canisterName})? This will wipe all state.`,
									initialValue: false,
								}),
							catch: (error) => {
								return new TaskError({ message: String(error) })
							},
						})
						if (!confirmResult) {
							return new TaskCancelled({
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
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".input"),
				),
			),
		revalidate: (taskCtx, { input }) =>
			runtime.runPromise(
				Effect.fn("task_revalidate")(function* () {
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
					const lastDeployment = yield* Effect.tryPromise({
						try: () =>
							taskCtx.deployments.get(
								canisterName,
								taskCtx.network,
							),
						catch: (error) => {
							return new TaskError({ message: String(error) })
						},
					})
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
					const info = yield* Effect.tryPromise<
						CanisterStatusResult,
						CanisterStatusError | AgentError
					>({
						try: () =>
							replica.getCanisterInfo({
								canisterId: input.canisterId,
								identity: deployer.identity,
							}),
						catch: (e) =>
							e instanceof CanisterStatusError ||
							e instanceof AgentError
								? e
								: new AgentError({ message: String(e) }),
					})
					if (
						info.status === CanisterStatus.NOT_FOUND ||
						info.module_hash.length === 0
					) {
						return true
					}
					return false
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs(
						"path",
						taskCtx.taskPath + ".revalidate",
					),
				),
			),
		encodingFormat: "string",

		encode: (taskCtx, result, input) =>
			runtime.runPromise(
				Effect.fn("task_encode")(function* () {
					yield* Effect.logDebug(
						"encoding task result",
						//  result
					)
					return yield* encodeWithBigInt({
						canisterId: result.canisterId,
						canisterName: result.canisterName,
						mode: result.mode,
						encodedArgs: uint8ArrayToJsonString(result.encodedArgs),
						args: result.args,
					})
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".encode"),
				),
			),
		decode: (taskCtx, value, input) =>
			runtime.runPromise(
				Effect.fn("task_decode")(function* () {
					const {
						canisterId,
						canisterName,
						mode,
						encodedArgs: encodedArgsString,
						args: initArgs,
					} = (yield* decodeWithBigInt(value as string)) as {
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
					const path = yield* Path.Path
					const didJSPath = path.join(
						iceDir,
						"canisters",
						canisterName,
						`${canisterName}.did.js`,
					)
					// TODO: we should create a service that caches these?
					// expensive to import every time
					// or task? return from bindings task?
					const canisterDID = yield* Effect.tryPromise({
						try: () =>
							import(didJSPath) as Promise<CanisterDidModule>,
						catch: (e) =>
							new TaskError({
								message: "Failed to load canisterDID",
							}),
					})
					const actor = yield* Effect.tryPromise({
						try: () =>
							replica.createActor<_SERVICE>({
								canisterId,
								canisterDID,
								identity,
							}),
						catch: (e) =>
							e instanceof AgentError
								? e
								: new AgentError({ message: String(e) }),
					})
					// // Always reflect the CURRENT resolved mode rather than the cached one
					// const currentMode = input.mode
					const decoded = {
						// mode: currentMode,
						mode,
						canisterId,
						canisterName,
						// TODO: plugin which transforms upgrade tasks?
						actor: proxyActor(canisterName, actor),
						// actor,
						encodedArgs,
						args: initArgs,
					}
					return decoded
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".decode"),
				),
			),
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
