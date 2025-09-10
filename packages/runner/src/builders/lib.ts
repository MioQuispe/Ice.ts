import { IDL } from "@dfinity/candid"
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
} from "effect"
import { readFileSync, realpathSync } from "node:fs"
import { stat } from "node:fs/promises"
import { NodeContext } from "@effect/platform-node"
import { encodeArgs, encodeUpgradeArgs } from "../canister.js"
import { CanisterIdsService } from "../services/canisterIds.js"
import {
	CanisterStatus,
	type CanisterStatusResult,
	InstallModes,
	Replica,
} from "../services/replica.js"
import { TaskRegistry } from "../services/taskRegistry.js"
import type {
	ParamsToArgs,
	TaskParamsToArgs,
	TaskSuccess,
} from "../tasks/lib.js"
import { getNodeByPath } from "../tasks/lib.js"
import type { ActorSubclass } from "../types/actor.js"
import type { CachedTask, Task } from "../types/types.js"
import { proxyActor } from "../utils/extension.js"
import { ExtractArgsFromTaskParams } from "./task.js"
import { CustomCanisterConfig, deployParams } from "./custom.js"
import { Moc, MocError } from "../services/moc.js"
import { type TaskCtxShape } from "../services/taskCtx.js"
import { configLayer } from "../services/config.js"
import { IceDir } from "../services/iceDir.js"
import { ConfigError } from "effect/ConfigError"
import { PlatformError } from "@effect/platform/Error"
import { DeploymentsService } from "../services/deployments.js"
import { layerFileSystem } from "@effect/platform/KeyValueStore"

const IceDirLayer = IceDir.Live({ iceDirName: ".ice" }).pipe(
	Layer.provide(NodeContext.layer),
	Layer.provide(configLayer),
)
const baseLayer = Layer.mergeAll(
	NodeContext.layer,
	Moc.Live.pipe(Layer.provide(NodeContext.layer)),
	// taskLayer,
	// TODO: generic storage?
	CanisterIdsService.Live.pipe(
		Layer.provide(NodeContext.layer),
		Layer.provide(configLayer),
		Layer.provide(IceDirLayer),
	),
	DeploymentsService.Live.pipe(
		Layer.provide(
			layerFileSystem(".ice/deployments").pipe(
				Layer.provide(NodeContext.layer),
			),
		),
	),
	// CanisterIdsService.Test,
	configLayer,
	// telemetryLayer,
	// DefaultsLayer,
	// TaskArgsLayer,
	// ICEConfigLayer,
	// TaskCtxLayer,
	Logger.pretty,
	Logger.minimumLogLevel(LogLevel.Debug),
)
export const defaultBuilderRuntime = ManagedRuntime.make(baseLayer)

export class TaskError extends Data.TaggedError("TaskError")<{
	message?: string
	op?: string
}> {}

export const loadCanisterId = (taskCtx: TaskCtxShape, taskPath: string) =>
	Effect.gen(function* () {
		const { currentNetwork } = taskCtx
		const canisterName = taskPath.split(":").slice(0, -1).join(":")
		const canisterIdsService = yield* CanisterIdsService
		const canisterIds = yield* canisterIdsService.getCanisterIds()
		const canisterId = canisterIds[canisterName]?.[currentNetwork]
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
	builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
	configOrFn:
		| ((args: { ctx: TaskCtxShape }) => Promise<Config>)
		| ((args: { ctx: TaskCtxShape }) => Config)
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
		effect: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.fn("task_effect")(function* () {
					if (typeof configOrFn === "function") {
						const configFn = configOrFn as (args: {
							ctx: TaskCtxShape
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
				})(),
			),
		id: Symbol("canister/config"),
		input: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.fn("task_input")(function* () {
					const { depResults } = taskCtx
					const depCacheKeys = Record.map(
						depResults,
						(dep) => dep.cacheKey,
					)
					return {
						depCacheKeys,
					}
				})(),
			),
		encode: (taskCtx, value) =>
			builderRuntime.runPromise(
				Effect.fn("task_encode")(function* () {
					return JSON.stringify(value)
				})(),
			),
		encodingFormat: "string",
		decode: (taskCtx, value) =>
			builderRuntime.runPromise(
				Effect.fn("task_decode")(function* () {
					return JSON.parse(value as string)
				})(),
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
	runtime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
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
		effect: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_effect")(function* () {
					const path = yield* Path.Path
					const fs = yield* FileSystem.FileSystem
					const canisterIdsService = yield* CanisterIdsService
					const currentNetwork = taskCtx.currentNetwork
					const { taskPath } = taskCtx
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					const storedCanisterIds =
						yield* canisterIdsService.getCanisterIds()
					const storedCanisterId =
						storedCanisterIds[canisterName]?.[currentNetwork]
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
						? yield* replica
								.getCanisterInfo({
									canisterId: resolvedCanisterId,
									identity,
								})
								.pipe(
									Effect.catchTag(
										"CanisterStatusError",
										(err) => {
											return Effect.succeed({
												status: CanisterStatus.NOT_FOUND,
											})
										},
									),
								)
						: {
								status: CanisterStatus.NOT_FOUND,
							}
					const isAlreadyInstalled =
						resolvedCanisterId &&
						canisterInfo.status !== CanisterStatus.NOT_FOUND

					yield* Effect.logDebug("makeCreateTask", {
						isAlreadyInstalled,
						resolvedCanisterId,
					})

					const canisterId = isAlreadyInstalled
						? resolvedCanisterId
						: yield* replica.createCanister({
								canisterId: resolvedCanisterId,
								identity,
							})
					const { appDir, iceDir } = taskCtx
					yield* Effect.logDebug(
						"create Task: setting canisterId",
						canisterId,
					)
					// TODO: integrate with cache?
					yield* canisterIdsService.setCanisterId({
						canisterName,
						network: taskCtx.currentNetwork,
						canisterId,
					})
					const outDir = path.join(iceDir, "canisters", canisterName)
					yield* fs.makeDirectory(outDir, { recursive: true })
					return canisterId
				})(),
			),
		encode: (taskCtx, value) =>
			runtime.runPromise(
				Effect.fn("task_encode")(function* () {
					return JSON.stringify(value)
				})(),
			),
		decode: (taskCtx, value) =>
			runtime.runPromise(
				Effect.fn("task_decode")(function* () {
					return JSON.parse(value as string)
				})(),
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
						network: taskCtx.currentNetwork,
					}
					return input
				})(),
			),
		revalidate: (taskCtx, { input }) =>
			runtime.runPromise(
				Effect.fn("task_revalidate")(function* () {
					const {
						replica,
						roles: { deployer },
						currentNetwork,
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
					const canisterIdsService = yield* CanisterIdsService
					const configCanisterId = canisterConfig?.canisterId
					const storedCanisterIds =
						yield* canisterIdsService.getCanisterIds()
					const storedCanisterId =
						storedCanisterIds[canisterName]?.[currentNetwork]
					// TODO: handle changes to configCanisterId
					// Prefer an existing/stored id; fallback to config-provided id; may be undefined on first run
					const resolvedCanisterId =
						storedCanisterId ?? configCanisterId

					if (!resolvedCanisterId) {
						return true
					}

					const info = yield* replica.getCanisterInfo({
						canisterId: resolvedCanisterId,
						identity: deployer.identity,
					})
					if (info.status === CanisterStatus.NOT_FOUND) {
						return true
					}
					const moduleHash = info.module_hash ?? []
					if (moduleHash.length === 0) {
						return true
					}

					return false
				})(),
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

export async function isArtifactCached(
	path: string,
	prev: FileDigest | undefined, // last run (undefined = cache miss)
): Promise<{ fresh: boolean; digest: FileDigest }> {
	// No previous record – must rebuild
	if (!prev) {
		return { fresh: false, digest: digestFile(path) }
	}

	// 1️⃣ fast-path : stat only
	const currentStat = await stat(path)
	if (currentStat.mtimeMs === prev.mtimeMs) {
		return { fresh: true, digest: prev } // timestamps match ⟹ assume fresh
	}

	// 2️⃣ slow-path : hash check
	const digest = digestFile(path)
	const fresh = digest.sha256 === prev.sha256
	return { fresh, digest }
}

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
			}
			upgradeArgs: {
				raw: U
				encoded: Uint8Array<ArrayBufferLike>
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
			mode: InstallModes
			// computeKeyMode?: "install" | "upgrade"
			depCacheKeys: Record<string, string | undefined>
			wasmDigest: FileDigest
			installArgsDigest: string
			upgradeArgsDigest: string
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
		? T["children"]["install"] extends Task
			? T["children"]["install"]
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
			? Deps[K]["children"]["install"]
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
	if ("_tag" in dep && dep._tag === "scope" && dep.children?.install)
		return dep.children.install as Task
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

export const makeStopTask = (
	builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
): StopTask => {
	return {
		_tag: "task",
		id: Symbol("customCanister/stop"),
		dependsOn: {},
		dependencies: {},
		// TODO: do we allow a fn as args here?
		effect: (taskCtx) =>
			builderRuntime.runPromise(
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
					const status = yield* replica.getCanisterStatus({
						canisterId,
						identity,
					})
					if (status === CanisterStatus.STOPPED) {
						yield* Effect.logDebug(
							`Canister ${canisterName} is already stopped or not installed`,
							status,
						)
						return
					}
					yield* replica.stopCanister({
						canisterId,
						identity,
					})
					yield* Effect.logDebug(`Stopped canister ${canisterName}`)
				})(),
			),
		description: "Stop canister",
		// TODO: no tag custom
		tags: [Tags.CANISTER, Tags.STOP],
		namedParams: {},
		positionalParams: [],
		params: {},
	} satisfies Task<void>
}

export const makeRemoveTask = (
	builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
): RemoveTask => {
	return {
		_tag: "task",
		id: Symbol("customCanister/remove"),
		dependsOn: {},
		dependencies: {},
		// TODO: do we allow a fn as args here?
		effect: (taskCtx) =>
			builderRuntime.runPromise(
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
					yield* replica.removeCanister({
						canisterId,
						identity,
					})
					const canisterIdsService = yield* CanisterIdsService
					yield* canisterIdsService.removeCanisterId(canisterName)
					yield* Effect.logDebug(`Removed canister ${canisterName}`)
				})(),
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
	builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
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
		effect: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.fn("task_effect")(function* () {
					// TODO:
					const { replica, currentNetwork } = taskCtx
					const { taskPath } = taskCtx
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					const canisterIdsService = yield* CanisterIdsService
					const canisterIdsMap =
						yield* canisterIdsService.getCanisterIds()
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
					const canisterId = canisterIds[currentNetwork]
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
					const canisterInfo = yield* replica.getCanisterInfo({
						canisterId,
						identity,
					})
					const status = canisterInfo.status
					return {
						canisterName,
						canisterId,
						status,
						info: canisterInfo,
					}
				})(),
			),
		description: "Get canister status",
		tags: [Tags.CANISTER, Tags.STATUS, ...tags],
		namedParams: {},
		positionalParams: [],
		params: {},
	} satisfies StatusTask
}

export const resolveMode = (
	taskCtx: TaskCtxShape,
	configCanisterId: string | undefined,
) => {
	return Effect.gen(function* () {
		const {
			replica,
			args,
			currentNetwork,
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
		const canisterIdsService = yield* CanisterIdsService
		const canisterIdsMap = yield* canisterIdsService.getCanisterIds()
		const canisterId =
			canisterIdsMap[canisterName]?.[currentNetwork] ?? configCanisterId
		// TODO: use Option.Option?
		const canisterInfo = canisterId
			? yield* replica
					.getCanisterInfo({
						canisterId,
						identity,
					})
					.pipe(
						Effect.catchTag("CanisterStatusError", (err) => {
							// TODO: previous canister_ids could exist
							// but canister not even created
							return Effect.succeed({
								status: CanisterStatus.NOT_FOUND,
							})
						}),
					)
			: ({
					status: CanisterStatus.NOT_FOUND,
				} as const)

		const noModule =
			canisterInfo.status === CanisterStatus.NOT_FOUND ||
			canisterInfo.module_hash.length === 0

		const Deployments = yield* DeploymentsService
		const lastDeployment = yield* Deployments.get(
			canisterName,
			currentNetwork,
		)
		const { installArgs, upgradeArgs } = depResults["install_args"]
			?.result as TaskSuccess<InstallArgsTask>
		const installArgsHash = hashUint8(installArgs.encoded)
		const upgradeArgsHash = hashUint8(upgradeArgs.encoded)

		// // const mode =
		// // 	resolvedMode === "reinstall" ? "install" : resolvedMode

		let mode: InstallModes
		if (requestedMode === "auto") {
			if (noModule) {
				mode = "install"
			} else {
				mode = Option.match(lastDeployment, {
					onSome: (lastDeployment) => {
						if (
							lastDeployment.installArgsHash !== installArgsHash
						) {
							return "reinstall"
						}
						if (
							lastDeployment.upgradeArgsHash !== upgradeArgsHash
						) {
							return "upgrade"
						}
						// TODO: This one is changed, but it causes OTHER ISSUES
						return "install"
					},
					onNone: () => "reinstall",
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

export type InstallTaskArgs = ParamsToArgs<typeof installParams>

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
	builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
	installArgs: {
		fn: (args: {
			ctx: TaskCtxShape
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
			ctx: TaskCtxShape
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
		effect: (taskCtx) =>
			builderRuntime.runPromise(
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

					const installFnResult = installArgs.fn({
						ctx: taskCtx,
						deps,
					})
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

					const upgradeFnResult = upgradeArgs.fn({
						ctx: taskCtx,
						deps,
					})

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

					yield* Effect.logDebug("Install args generated", {
						installArgsResult,
						upgradeArgsResult,
					})

					const canisterDID = yield* Effect.tryPromise({
						try: () =>
							import(didJSPath) as Promise<CanisterDidModule>,
						catch: (e) => {
							return new TaskError({
								message: "Failed to load canisterDID",
							})
						},
					})
					yield* Effect.logDebug("Encoding args install args", {
						installArgsResult,
						canisterDID,
					})
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
						},
						upgradeArgs: {
							raw: upgradeArgsResult,
							encoded: encodedUpgradeArgs,
						},
						// args: installArgs,
						// encodedArgs,
						// mode,
						canisterName,
					}
				})(),
			),
		description: "Generate install args for canister",
		tags: [Tags.CANISTER, Tags.INSTALL_ARGS],
		// TODO: add network?
		// TODO: pocket-ic could be restarted?
		computeCacheKey: (input) => {
			const installInput = {
				installArgsFnHash: hashConfig(input.installArgsFn),
				upgradeArgsFnHash: hashConfig(input.upgradeArgsFn),
				depsHash: hashJson(input.depCacheKeys),
				network: input.network,
			}
			const cacheKey = hashJson(installInput)
			return cacheKey
		},
		input: (taskCtx) =>
			builderRuntime.runPromise(
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
					const { currentNetwork } = taskCtx
					const mode = taskArgs.mode

					// const taskRegistry = yield* TaskRegistry
					// TODO: we need a separate cache for this?
					const input = {
						canisterName,
						network: currentNetwork,
						mode,
						depCacheKeys,
						installArgsFn: installArgs.fn,
						upgradeArgsFn: upgradeArgs.fn,
					}
					return input
				})(),
			),
		encodingFormat: "string",

		encode: (taskCtx, result, input) =>
			builderRuntime.runPromise(
				Effect.fn("task_encode")(function* () {
					yield* Effect.logDebug("encoding:", result)
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
				})(),
			),
		decode: (taskCtx, value, input) =>
			builderRuntime.runPromise(
				Effect.fn("task_decode")(function* () {
					const { canisterName, installArgs, upgradeArgs } =
						(yield* decodeWithBigInt(value as string)) as {
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
						installArgs.encoded,
					)
					const encodedUpgradeArgs = jsonStringToUint8Array(
						upgradeArgs.encoded,
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
							raw: installArgs.raw,
							encoded: encodedInstallArgs,
						},
						upgradeArgs: {
							raw: upgradeArgs.raw,
							encoded: encodedUpgradeArgs,
						},
					}
					return decoded
				})(),
			),
	} satisfies InstallArgsTask<_SERVICE, I, U, D, P>
}

export const makeInstallTask = <_SERVICE, I, U>(
	builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
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
		effect: (taskCtx) =>
			builderRuntime.runPromise(
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

					// TODO: cache somehow?
					const mode = yield* resolveMode(taskCtx, canisterId)
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
					yield* Effect.logDebug("Loaded canisterDID", {
						canisterDID,
					})
					const fs = yield* FileSystem.FileSystem

					// TODO:
					// they can return the values we need perhaps? instead of reading from fs
					// we need the wasm blob and candid DIDjs / idlFactory?
					const wasmContent = yield* fs.readFile(wasmPath)
					const wasm = new Uint8Array(wasmContent)
					const maxSize = 3670016
					// Enforce explicit mode preconditions
					const canisterInfo = yield* replica.getCanisterInfo({
						canisterId,
						identity,
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
					yield* replica.installCode({
						canisterId,
						wasm,
						encodedArgs: initArgs.encoded,
						identity,
						mode,
					})
					const Deployments = yield* DeploymentsService
					yield* Deployments.set({
						canisterName,
						network: taskCtx.currentNetwork,
						deployment: {
							installArgsHash: hashUint8(installArgs.encoded),
							upgradeArgsHash: hashUint8(upgradeArgs.encoded),
							wasmHash: hashUint8(wasm),
							mode,
							updatedAt: Date.now(),
						},
					})
					yield* Effect.logDebug(`Code installed for ${canisterId}`)
					yield* Effect.logDebug(
						`Canister ${canisterName} installed successfully`,
					)
					const actor = yield* replica.createActor<_SERVICE>({
						canisterId,
						canisterDID,
						identity,
					})
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
				})(),
			),
		description: "Install canister code",
		tags: [Tags.CANISTER, Tags.CUSTOM, Tags.INSTALL],
		// TODO: add network?
		// TODO: pocket-ic could be restarted?
		computeCacheKey: (input) => {
			// TODO: input.mode causes cache miss. but should reuse install cache
			// on 2nd run? TODO: determine in inputs?
			const argsDigest =
				input.mode === "install" || input.mode === "reinstall"
					? "install:" + input.installArgsDigest
					: "upgrade:" + input.upgradeArgsDigest
			const keyInput = {
				depsHash: hashJson(input.depCacheKeys),
				canisterId: input.canisterId,
				network: input.network,
				wasmDigest: input.wasmDigest.sha256,
				// TODO: mode="upgrade" just returns cached. but should upgrade?
				// installArgsDigest: input.installArgsDigest,
				// upgradeArgsDigest: input.upgradeArgsDigest,
				// mode: input.mode === "reinstall" ? "install" : input.mode,
				argsDigest,
			}
			const cacheKey = hashJson(keyInput)
			return cacheKey
		},
		input: (taskCtx) =>
			builderRuntime.runPromise(
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
					const depCacheKeys = Record.map(
						dependencies,
						// Record.filter(
						// 	dependencies,
						// 	// causes issues for mode selection due to argsDigest
						// 	(dep, key) => key !== "install_args",
						// ),
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
						currentNetwork,
						// replica,
						// roles: {
						// 	deployer: { identity },
						// },
					} = taskCtx
					const { installArgs, upgradeArgs } = depResults[
						"install_args"
					]?.result as TaskSuccess<InstallArgsTask<_SERVICE, I, U>>

					const installArgsDigest = hashUint8(installArgs.encoded)
					const upgradeArgsDigest = hashUint8(upgradeArgs.encoded)
					const wasmDigest = yield* digestFileEffect(taskArgs.wasm)
					const mode = yield* resolveMode(taskCtx, canisterId)
					const input = {
						canisterId,
						// canisterName,
						network: currentNetwork,
						mode,
						wasmDigest,
						depCacheKeys,
						installArgsDigest,
						upgradeArgsDigest,
					}
					return input
				})(),
			),
		revalidate: (taskCtx, { input }) =>
			builderRuntime.runPromise(
				Effect.fn("task_revalidate")(function* () {
					const {
						replica,
						roles: { deployer },
					} = taskCtx
					if (input.mode === "reinstall") {
						return true
					}
					const info = yield* replica.getCanisterInfo({
						canisterId: input.canisterId,
						identity: deployer.identity,
					})
					if (
						info.status === CanisterStatus.NOT_FOUND ||
						info.module_hash.length === 0
					) {
						return true
					}
					return false
				})(),
			),
		encodingFormat: "string",

		encode: (taskCtx, result, input) =>
			builderRuntime.runPromise(
				Effect.fn("task_encode")(function* () {
					yield* Effect.logDebug("encoding:", result)
					return yield* encodeWithBigInt({
						canisterId: result.canisterId,
						canisterName: result.canisterName,
						mode: result.mode,
						encodedArgs: uint8ArrayToJsonString(result.encodedArgs),
						args: result.args,
					})
				})(),
			),
		decode: (taskCtx, value, input) =>
			builderRuntime.runPromise(
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
					const canisterDID = yield* Effect.tryPromise({
						try: () =>
							import(didJSPath) as Promise<CanisterDidModule>,
						catch: (e) =>
							new TaskError({
								message: "Failed to load canisterDID",
							}),
					})
					const actor = yield* replica.createActor<_SERVICE>({
						// canisterName,
						canisterId,
						canisterDID,
						identity,
					})
					const decoded = {
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
				})(),
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
