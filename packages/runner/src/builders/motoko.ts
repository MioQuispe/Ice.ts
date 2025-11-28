import { Effect, Layer, ManagedRuntime, Record } from "effect"
import type { CachedTask, Task } from "../types/types.js"
// import mo from "motoko"
import { FileSystem, Path } from "@effect/platform"
// TODO: move to ./lib.ts
import { compileMotokoCanister, generateDIDJS } from "../canister.js"
import {
	ParamsToArgs,
	ResolvedParamsToArgs,
	TaskParamsToArgs,
} from "../tasks/lib.js"
import { InstallModes, CanisterSettings } from "../services/replica.js"
import {
	AllowedDep,
	CreateTask,
	DependencyMismatchError,
	ExtractScopeSuccesses,
	FileDigest,
	InstallTask,
	InstallArgsTask,
	ConfigTask,
	IsValid,
	NormalizeDeps,
	RemoveTask,
	StatusTask,
	StopTask,
	ValidProvidedDeps,
	makeLoggerLayer,
	defaultBuilderRuntime,
} from "./lib.js"
import { type TaskCtx } from "../services/taskRuntime.js"
import { getNodeByPath } from "../tasks/lib.js"
import {
	hashJson,
	isArtifactCached,
	linkChildren,
	makeCanisterStatusTask,
	makeCreateTask,
	makeInstallTask,
	makeInstallArgsTask,
	makeConfigTask,
	makeRemoveTask,
	makeStopTask,
	normalizeDepsMap,
	Tags,
	TaskError,
	UnwrapConfig,
} from "./lib.js"
import { type } from "arktype"
import { deployParams } from "./custom.js"
import { ActorSubclass } from "../types/actor.js"
// layer types are re-exported from ./lib.js

/**
 * Configuration for a Motoko canister.
 */
export type MotokoCanisterConfig = {
	/**
	 * Path to the main Motoko source file (e.g. "canisters/main.mo").
	 */
	readonly src: string
	/**
	 * Optional specific canister ID. If not provided, one will be generated/managed automatically.
	 */
	readonly canisterId?: string
	/**
	 * Initial canister settings (cycles, resource allocation, etc.).
	 */
	readonly settings?: CanisterSettings
}

export type MotokoCanisterScope<
	_SERVICE = any,
	I = any,
	U = any,
	D extends Record<string, Task> = Record<string, Task>,
	P extends Record<string, Task> = Record<string, Task>,
> = {
	_tag: "scope"
	id: symbol
	tags: Array<string | symbol>
	description: string
	defaultTask: "deploy"
	// only limited to tasks
	// children: Record<string, Task>
	children: {
		config: ConfigTask<MotokoCanisterConfig>
		create: CreateTask
		bindings: MotokoBindingsTask
		build: MotokoBuildTask
		install: InstallTask<_SERVICE, I, U>
		install_args: InstallArgsTask<_SERVICE, I, U, D, P>
		stop: StopTask
		remove: RemoveTask
		deploy: MotokoDeployTask<_SERVICE>
		status: StatusTask
	}
}

export const motokoDeployParams = deployParams

export type MotokoDeployTask<_SERVICE = unknown> = Omit<
	Task<
		{
			canisterId: string
			canisterName: string
			actor: ActorSubclass<_SERVICE>
			mode: InstallModes
		},
		{},
		{}
	>,
	"params"
> & {
	params: typeof motokoDeployParams
}

export type MotokoDeployTaskArgs = ResolvedParamsToArgs<
	typeof motokoDeployParams
>

export const makeMotokoDeployTask = <_SERVICE>(
	canisterConfigOrFn:
		| ((args: { ctx: TaskCtx }) => Promise<MotokoCanisterConfig>)
		| ((args: { ctx: TaskCtx }) => MotokoCanisterConfig)
		| MotokoCanisterConfig,
): MotokoDeployTask<_SERVICE> => {
	const builderRuntime = defaultBuilderRuntime
	return {
		_tag: "task",
		// TODO: change
		id: Symbol("canister/deploy"),
		dependsOn: {},
		// TODO: we only want to warn at a type level?
		// TODO: type Task
		dependencies: {},
		namedParams: motokoDeployParams,
		params: motokoDeployParams,
		positionalParams: [],
		effect: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.fn("task_effect")(function* () {
					const { taskPath } = taskCtx
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					const parentScope = (yield* getNodeByPath(
						taskCtx,
						canisterName,
					)) as MotokoCanisterScope<_SERVICE>
					const { args, runTask } = taskCtx
					const taskArgs = args as MotokoDeployTaskArgs
					const [canisterId, { wasmPath, candidPath }] =
						yield* Effect.all(
							[
								Effect.gen(function* () {
									const taskPath = `${canisterName}:create`
									yield* Effect.logDebug(
										"Now running create task",
									)
									const canisterId = yield* Effect.tryPromise(
										{
											try: () =>
												runTask(
													parentScope.children.create,
													{},
												),
											catch: (error) => {
												return new TaskError({
													message: String(error),
												})
											},
										},
									)
									yield* Effect.logDebug(
										"Finished running create task",
									)
									return canisterId
								}),
								Effect.gen(function* () {
									// Moc generates candid and wasm files in the same phase
									yield* Effect.logDebug(
										"Now running build task",
									)
									const { wasmPath, candidPath } =
										yield* Effect.tryPromise({
											try: () =>
												runTask(
													parentScope.children.build,
													{},
												),
											catch: (error) => {
												return new TaskError({
													message: String(error),
												})
											},
										})
									yield* Effect.logDebug(
										"Now running bindings task with args",
										{
											candid: candidPath,
										},
									)
									const { didJSPath, didTSPath } =
										yield* Effect.tryPromise({
											try: () =>
												runTask(
													parentScope.children
														.bindings,
													{
														candid: candidPath,
													},
												),
											catch: (error) => {
												return new TaskError({
													message: String(error),
												})
											},
										})
									// TODO:!!!!!
									return {
										wasmPath,
										candidPath,
										didJSPath,
										didTSPath,
									}
								}),
							],
							{
								concurrency: "unbounded",
							},
						)

					yield* Effect.logDebug("Now running install task")
					const taskResult = yield* Effect.tryPromise({
						try: () =>
							runTask(parentScope.children.install, {
								mode: taskArgs.mode,
								// args: taskArgs.args,
								canisterId,
								candid: candidPath,
								wasm: wasmPath,
								forceReinstall:
									taskArgs.forceReinstall ?? false,
							}),
						catch: (error) => {
							return new TaskError({
								message: String(error),
							})
						},
					})

					yield* Effect.logDebug("Canister deployed successfully")
					return taskResult
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
		description: "Deploy canister code",
		tags: [Tags.CANISTER, Tags.DEPLOY, Tags.MOTOKO],
	}
}

const motokoBindingsParams = {
	// TODO:
	candid: {
		type: type("string"),
		description: "Path to the candid file",
		name: "candid",
		isFlag: true as const,
		decode: (value: string) => value,
		isOptional: false as const,
		isVariadic: false as const,
	},
}
export type MotokoBindingsTaskArgs = ResolvedParamsToArgs<
	typeof motokoBindingsParams
>

export type MotokoBindingsTask = Omit<
	CachedTask<
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
	>,
	"params" | "namedParams"
> & {
	params: typeof motokoBindingsParams
	namedParams: typeof motokoBindingsParams
}

export const makeMotokoBindingsTask = (): MotokoBindingsTask => {
	const builderRuntime = defaultBuilderRuntime
	return {
		_tag: "task",
		id: Symbol("motokoCanister/bindings"),
		dependsOn: {},
		dependencies: {},
		namedParams: motokoBindingsParams,
		positionalParams: [],
		params: motokoBindingsParams,
		// TODO: do we allow a fn as args here?
		effect: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.fn("task_effect")(function* () {
					const path = yield* Path.Path
					const fs = yield* FileSystem.FileSystem
					const { taskPath, appDir, iceDir } = taskCtx
					const { candid } = taskCtx.args as MotokoBindingsTaskArgs
					const depResults = taskCtx.depResults
					const canisterConfig = depResults["config"]
						?.result as MotokoCanisterConfig
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")

					const isGzipped = yield* fs.exists(
						path.join(
							iceDir,
							"canisters",
							canisterName,
							`${canisterName}.wasm.gz`,
						),
					)
					// const wasmPath = path.join(
					// 	iceDir,
					// 	"canisters",
					// 	canisterName,
					// 	isGzipped
					// 		? `${canisterName}.wasm.gz`
					// 		: `${canisterName}.wasm`,
					// )
					// const didPath = path.join(
					// 	iceDir,
					// 	"canisters",
					// 	canisterName,
					// 	`${canisterName}.did`,
					// )
					// const canisterConfig = depResults["config"]
					// ?.result as CustomCanisterConfig
					// const canisterConfig = yield* resolveConfig(
					// 	taskCtx,
					// 	canisterConfigOrFn,
					// )
					// const didPath = canisterConfig.src
					const didPath =
						candid ??
						path.join(
							iceDir,
							"canisters",
							canisterName,
							`${canisterName}.did`,
						)
					yield* Effect.logDebug("Bindings task", canisterName, {
						didPath,
					})

					const { didJS, didJSPath, didTSPath } =
						yield* generateDIDJS(taskCtx, canisterName, didPath)
					yield* Effect.logDebug(
						`Generated DID JS for ${canisterName}`,
					)
					yield* Effect.logDebug("Artifact paths", {
						// wasmPath,
						didJSPath: didJSPath,
						didTSPath: didTSPath,
					})
					return {
						didJSPath,
						didTSPath,
					}
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
		computeCacheKey: (input) => {
			return hashJson({
				depsHash: hashJson(input.depCacheKeys),
				taskPath: input.taskPath,
			})
		},
		input: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.fn("task_input")(function* () {
					const { taskPath, depResults } = taskCtx
					const depCacheKeys = Record.map(
						depResults,
						(dep) => dep.cacheKey,
					)
					const input = {
						taskPath,
						depCacheKeys,
					}
					return input
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".input"),
				),
			),
		encode: (taskCtx, value) =>
			builderRuntime.runPromise(
				Effect.fn("task_encode")(function* () {
					return JSON.stringify(value)
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".encode"),
				),
			),
		decode: (taskCtx, value) =>
			builderRuntime.runPromise(
				Effect.fn("task_decode")(function* () {
					return JSON.parse(value as string)
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".decode"),
				),
			),
		encodingFormat: "string",
		description: "Generate bindings for Motoko canister",
		tags: [Tags.CANISTER, Tags.MOTOKO, Tags.BINDINGS],
	}
}

export type MotokoBuildTask = CachedTask<
	{
		wasmPath: string
		candidPath: string
	},
	{},
	{},
	{
		taskPath: string
		src: Array<FileDigest>
		configSrc: string
		depCacheKeys: Record<string, string | undefined>
	}
>

export const makeMotokoBuildTask = <C extends MotokoCanisterConfig>(
	configTask: ConfigTask<C>,
): MotokoBuildTask => {
	const builderRuntime = defaultBuilderRuntime
	return {
		_tag: "task",
		id: Symbol("motokoCanister/build"),
		dependsOn: {},
		dependencies: {
			config: configTask,
		},
		effect: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.fn("task_effect")(function* () {
					yield* Effect.logDebug("Building Motoko canister")
					const path = yield* Path.Path
					const fs = yield* FileSystem.FileSystem
					const { appDir, iceDir, taskPath } = taskCtx
					const depResults = taskCtx.depResults
					const canisterConfig = depResults["config"]
						?.result as MotokoCanisterConfig
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					// const isGzipped = yield* fs.exists(
					// 	path.join(
					// 		iceDir,
					// 		"canisters",
					// 		canisterName,
					// 		`${canisterName}.wasm.gz`,
					// 	),
					// )
					const outWasmPath = path.join(
						iceDir,
						"canisters",
						canisterName,
						`${canisterName}.wasm`,
					)
					const outCandidPath = path.join(
						iceDir,
						"canisters",
						canisterName,
						`${canisterName}.did`,
					)
					// Ensure the directory exists
					yield* fs.makeDirectory(path.dirname(outWasmPath), {
						recursive: true,
					})
					yield* Effect.logDebug(
						"Compiling Motoko canister with args",
						{
							wasmOutputFilePath: outWasmPath,
							outCandidPath,
						},
						"with src",
						path.resolve(appDir, canisterConfig.src),
					)
					yield* compileMotokoCanister(
						path.resolve(appDir, canisterConfig.src),
						canisterName,
						outWasmPath,
						outCandidPath,
					)
					yield* Effect.logDebug(
						"Motoko canister built successfully",
						{
							wasmPath: outWasmPath,
							candidPath: outCandidPath,
						},
					)
					return {
						wasmPath: outWasmPath,
						candidPath: outCandidPath,
					}
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
		computeCacheKey: (input) => {
			// TODO: pocket-ic could be restarted?
			const installInput = {
				taskPath: input.taskPath,
				// depsHash: hashJson(input.depCacheKeys),
				configSrc: input.configSrc,
				// TODO: should we hash all fields though?
				srcHash: hashJson(input.src.map((s) => s.sha256)),
			}
			const cacheKey = hashJson(installInput)
			return cacheKey
		},
		input: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.fn("task_input")(function* () {
					const { taskPath, depResults } = taskCtx
					const dependencies = depResults
					const depCacheKeys = Record.map(
						dependencies,
						(dep) => dep.cacheKey,
					)
					const canisterConfig = depResults["config"]
						?.result as MotokoCanisterConfig
					const path = yield* Path.Path
					const fs = yield* FileSystem.FileSystem
					const srcDir = path.dirname(canisterConfig.src)
					const entries = yield* fs.readDirectory(srcDir, {
						recursive: true,
					})
					const srcFiles = entries.filter((entry) =>
						entry.endsWith(".mo"),
					)
					const prevSrcDigests: Array<FileDigest> = []
					const srcDigests: Array<FileDigest> = []
					for (const [index, file] of srcFiles.entries()) {
						const prevSrcDigest = prevSrcDigests?.[index]
						const filePath = path.join(srcDir, file)
						const { fresh: srcFresh, digest: srcDigest } =
							yield* isArtifactCached(filePath, prevSrcDigest)
						srcDigests.push(srcDigest)
					}
					const input = {
						taskPath,
						src: srcDigests,
						configSrc: canisterConfig.src,
						depCacheKeys,
					}
					return input
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".input"),
				),
			),
		encode: (taskCtx, value) =>
			builderRuntime.runPromise(
				Effect.fn("task_encode")(function* () {
					return JSON.stringify(value)
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".encode"),
				),
			),
		decode: (taskCtx, value) =>
			builderRuntime.runPromise(
				Effect.fn("task_decode")(function* () {
					return JSON.parse(value as string)
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".decode"),
				),
			),
		encodingFormat: "string",
		description: "Build Motoko canister",
		tags: [Tags.CANISTER, Tags.MOTOKO, Tags.BUILD],
		namedParams: {},
		positionalParams: [],
		params: {},
	}
}

type ArgsFields<
	I,
	D extends Record<string, Task>,
	P extends Record<string, Task>,
	TCtx extends TaskCtx = TaskCtx,
> = {
	fn:
		| ((args: {
				ctx: TCtx
				deps: ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>
		  }) => I | Promise<I>)
		| I
	customEncode:
		| undefined
		| ((args: I) => Promise<Uint8Array<ArrayBufferLike>>)
}

type ResolveService<T> =
	UnwrapConfig<T> extends { src: infer S }
		? S extends keyof IceCanisterPaths
			? IceCanisterPaths[S]
			: unknown
		: unknown

/**
 * A builder class for configuring Motoko canisters.
 * Provides a fluent API to set installation arguments, upgrade arguments, and dependencies.
 */
export class MotokoCanisterBuilder<
	const Config extends MotokoCanisterConfig = MotokoCanisterConfig,
	_SERVICE = ResolveService<Config>,
	I = unknown,
	U = unknown,
	D extends Record<string, Task> = Record<string, Task>,
	P extends Record<string, Task> = Record<string, Task>,
	S extends MotokoCanisterScope<_SERVICE, I, U, D, P> = MotokoCanisterScope<
		_SERVICE,
		I,
		U,
		D,
		P
	>,
	TCtx extends TaskCtx = TaskCtx,
> {
	#scope: S
	#installArgs: ArgsFields<I, D, P, TCtx>
	#upgradeArgs: ArgsFields<U, D, P, TCtx>

	constructor(
		scope: S,
		installArgs: ArgsFields<I, D, P, TCtx>,
		upgradeArgs: ArgsFields<U, D, P, TCtx>,
	) {
		this.#scope = scope
		this.#installArgs = installArgs
		this.#upgradeArgs = upgradeArgs
	}

	// Override Type Method
	as<T>(): MotokoCanisterBuilder<
		Config,
		T,
		I,
		U,
		D,
		P,
		MotokoCanisterScope<T, I, U, D, P>,
		TCtx
	> {
		return this as unknown as MotokoCanisterBuilder<
			Config,
			T,
			I,
			U,
			D,
			P,
			MotokoCanisterScope<T, I, U, D, P>,
			TCtx
		>
	}

	create(
		canisterConfigOrFn:
			| Config
			| ((args: { ctx: TCtx }) => Config)
			| ((args: { ctx: TCtx }) => Promise<Config>),
	): MotokoCanisterBuilder<
		Config,
		_SERVICE,
		I,
		U,
		D,
		P,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		TCtx
	> {
		const config = makeConfigTask<Config>(canisterConfigOrFn as any)
		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				config,
				create: makeCreateTask<Config>(config, [Tags.MOTOKO]),
				build: makeMotokoBuildTask(config),
			},
		} satisfies MotokoCanisterScope<_SERVICE, I, U, D, P>

		return new MotokoCanisterBuilder(
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	build(): MotokoCanisterBuilder<
		Config,
		_SERVICE,
		I,
		U,
		D,
		P,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		TCtx
	> {
		// no-op; build is derived from config
		return new MotokoCanisterBuilder(
			this.#scope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	/**
	 * Defines the arguments to pass to the canister's `install` method (initial deployment).
	 *
	 * @param installArgsOrFn - A value or function returning the arguments.
	 * @returns The builder instance.
	 *
	 * @example
	 * ```typescript
	 * .installArgs(({ ctx }) => ({
	 *   owner: ctx.users.default.principal
	 * }))
	 * ```
	 */
	installArgs(
		installArgsFn: (args: {
			ctx: TCtx
			deps: ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>
		}) => I | Promise<I>,
		options?: {
			customEncode:
				| undefined
				| ((args: I) => Promise<Uint8Array<ArrayBufferLike>>)
		},
	): MotokoCanisterBuilder<
		Config,
		_SERVICE,
		I,
		U,
		D,
		P,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		TCtx
	>
	installArgs(
		installArgsValue: I,
		options?: {
			customEncode:
				| undefined
				| ((args: I) => Promise<Uint8Array<ArrayBufferLike>>)
		},
	): MotokoCanisterBuilder<
		Config,
		_SERVICE,
		I,
		U,
		D,
		P,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		TCtx
	>
	installArgs(
		installArgsOrFn:
			| ((args: {
					ctx: TCtx
					deps: ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>
			  }) => I | Promise<I>)
			| I,
		{
			customEncode,
		}: {
			customEncode:
				| undefined
				| ((args: I) => Promise<Uint8Array<ArrayBufferLike>>)
		} = {
			customEncode: undefined,
		},
	): MotokoCanisterBuilder<
		Config,
		_SERVICE,
		I,
		U,
		D,
		P,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		TCtx
	> {
		this.#installArgs = {
			fn: installArgsOrFn,
			customEncode,
		}
		const install_args = makeInstallArgsTask<_SERVICE, I, U, D, P>(
			this.#installArgs as any,
			this.#upgradeArgs as any,
			this.#scope.children.install_args.dependencies as P,
		)
		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				install: makeInstallTask<_SERVICE, I, U>(install_args),
				install_args,
			},
		} satisfies MotokoCanisterScope<_SERVICE, I, U, D, P>

		return new MotokoCanisterBuilder(
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	/**
	 * Defines the arguments to pass to the canister's `postUpgrade` method (subsequent deployments).
	 *
	 * @param upgradeArgsOrFn - A value or function returning the arguments.
	 * @returns The builder instance.
	 */
	upgradeArgs(
		upgradeArgsFn: (args: {
			ctx: TCtx
			deps: ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>
		}) => U | Promise<U>,
		options?: {
			customEncode:
				| undefined
				| ((args: U) => Promise<Uint8Array<ArrayBufferLike>>)
		},
	): MotokoCanisterBuilder<
		Config,
		_SERVICE,
		I,
		U,
		D,
		P,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		TCtx
	>
	upgradeArgs(
		upgradeArgsValue: U,
		options?: {
			customEncode:
				| undefined
				| ((args: U) => Promise<Uint8Array<ArrayBufferLike>>)
		},
	): MotokoCanisterBuilder<
		Config,
		_SERVICE,
		I,
		U,
		D,
		P,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		TCtx
	>
	upgradeArgs(
		upgradeArgsOrFn:
			| ((args: {
					ctx: TCtx
					deps: ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>
			  }) => U | Promise<U>)
			| U,
		{
			customEncode,
		}: {
			customEncode:
				| undefined
				| ((args: U) => Promise<Uint8Array<ArrayBufferLike>>)
		} = {
			customEncode: undefined,
		},
	): MotokoCanisterBuilder<
		Config,
		_SERVICE,
		I,
		U,
		D,
		P,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		TCtx
	> {
		this.#upgradeArgs = {
			fn: upgradeArgsOrFn,
			customEncode,
		}
		const install_args = makeInstallArgsTask<_SERVICE, I, U, D, P>(
			this.#installArgs as any,
			this.#upgradeArgs as any,
			this.#scope.children.install_args.dependencies as P,
		)
		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				install_args,
			},
		} satisfies MotokoCanisterScope<_SERVICE, I, U, D, P>

		return new MotokoCanisterBuilder(
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	/**
	 * Declares dependencies (other canisters or tasks) that are required for calculating init/upgrade args.
	 *
	 * @param providedDeps - A map of dependencies.
	 * @returns The builder instance.
	 *
	 * @example
	 * ```typescript
	 * .deps({ ledger: ledgerCanister })
	 * .installArgs(({ deps }) => ({
	 *   ledgerId: deps.ledger.canisterId
	 * }))
	 * ```
	 */
	deps<UP extends Record<string, AllowedDep>, NP extends NormalizeDeps<UP>>(
		providedDeps: ValidProvidedDeps<D, UP>,
	): MotokoCanisterBuilder<
		Config,
		_SERVICE,
		I,
		U,
		D,
		NP,
		MotokoCanisterScope<_SERVICE, I, U, D, NP>,
		TCtx
	> {
		const finalDeps = normalizeDepsMap(providedDeps) as NP
		const installArgs = this.#installArgs as unknown as ArgsFields<
			I,
			D,
			NP,
			TCtx
		>
		const upgradeArgs = this.#upgradeArgs as unknown as ArgsFields<
			U,
			D,
			NP,
			TCtx
		>
		const install_args = {
			...this.#scope.children.install_args,
			dependencies: finalDeps,
		} as InstallArgsTask<_SERVICE, I, U, D, NP>
		const updatedChildren = {
			...this.#scope.children,
			install_args,
		}
		const updatedScope = {
			...this.#scope,
			children: updatedChildren,
		} satisfies MotokoCanisterScope<_SERVICE, I, U, D, NP>
		return new MotokoCanisterBuilder(updatedScope, installArgs, upgradeArgs)
	}

	/**
	 * Declares execution dependencies. The canister tasks will wait for these to complete.
	 *
	 * @param dependencies - A map of dependencies.
	 */
	dependsOn<
		UD extends Record<string, AllowedDep>,
		ND extends NormalizeDeps<UD>,
	>(
		dependencies: UD,
	): MotokoCanisterBuilder<
		Config,
		_SERVICE,
		I,
		U,
		ND,
		P,
		MotokoCanisterScope<_SERVICE, I, U, ND, P>,
		TCtx
	> {
		const updatedDependsOn = normalizeDepsMap(dependencies) as ND
		const installArgs = this.#installArgs as unknown as ArgsFields<
			I,
			ND,
			P,
			TCtx
		>
		const upgradeArgs = this.#upgradeArgs as unknown as ArgsFields<
			U,
			ND,
			P,
			TCtx
		>
		const updatedChildren = {
			...this.#scope.children,
			install_args: {
				...this.#scope.children.install_args,
				dependsOn: updatedDependsOn,
			} as InstallArgsTask<_SERVICE, I, U, ND, P>,
		}
		const updatedScope = {
			...this.#scope,
			children: updatedChildren,
		} satisfies MotokoCanisterScope<_SERVICE, I, U, ND, P>
		return new MotokoCanisterBuilder(updatedScope, installArgs, upgradeArgs)
	}

	/**
	 * Finalizes the canister definition and returns the scope.
	 *
	 * @returns A `MotokoCanisterScope` containing all lifecycle tasks (build, deploy, etc).
	 */
	make(
		this: IsValid<S> extends true
			? MotokoCanisterBuilder<Config, _SERVICE, I, U, D, P, S, TCtx>
			: DependencyMismatchError<S>,
	): S {
		const self = this as unknown as MotokoCanisterBuilder<
			Config,
			_SERVICE,
			I,
			U,
			D,
			P,
			S,
			TCtx
		>

		const linkedChildren = linkChildren(self.#scope.children)

		const finalScope = {
			...self.#scope,
			id: Symbol("scope"),
			children: linkedChildren,
		} satisfies MotokoCanisterScope<_SERVICE, I, U, D, P> as S
		return finalScope
	}
}

/**
 * Creates a Motoko canister builder.
 *
 * @param canisterConfigOrFn - Configuration object or a function returning one.
 * @returns A {@link MotokoCanisterBuilder}.
 *
 * @example
 * ```typescript
 * import { canister } from "@ice.ts/runner"
 *
 * export const backend = canister.motoko({
 *   src: "canisters/backend/main.mo"
 * }).make()
 * ```
 */
export const motokoCanister = <
	const Config extends MotokoCanisterConfig,
	TCtx extends TaskCtx = TaskCtx,
	_SERVICE = ResolveService<Config>,
	I = unknown,
	U = unknown,
>(
	canisterConfigOrFn:
		| Config
        | ((args: { ctx: TCtx }) => Config | Promise<Config>),
) => {
	const config = makeConfigTask(canisterConfigOrFn as any)

	const install_args = makeInstallArgsTask<_SERVICE, I, U, {}, {}>(
		{ fn: () => [] as I, customEncode: undefined },
		{ fn: () => [] as U, customEncode: undefined },
		{} as {},
	)
	const initialScope = {
		_tag: "scope",
		id: Symbol("scope"),
		tags: [Tags.CANISTER, Tags.MOTOKO],
		description: "Motoko canister scope",
		defaultTask: "deploy",
		children: {
			config,
			create: makeCreateTask(config, [Tags.MOTOKO]),
			build: makeMotokoBuildTask(config),
			bindings: makeMotokoBindingsTask(),
			stop: makeStopTask(),
			remove: makeRemoveTask(),
			install_args,
			install: makeInstallTask<_SERVICE, I, U>(install_args),
			deploy: makeMotokoDeployTask<_SERVICE>(canisterConfigOrFn as any),
			status: makeCanisterStatusTask([Tags.MOTOKO]),
		},
	} satisfies MotokoCanisterScope<_SERVICE, I, U, {}, {}>

	const installArgs = { fn: () => [] as I, customEncode: undefined }
	const upgradeArgs = { fn: () => [] as U, customEncode: undefined }
	return new MotokoCanisterBuilder<
		Config,
		_SERVICE,
		I,
		U,
		{},
		{},
		MotokoCanisterScope<_SERVICE, I, U, {}, {}>,
		TCtx
	>(initialScope, installArgs, upgradeArgs)
}
