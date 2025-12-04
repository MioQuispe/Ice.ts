import { Effect, Record, ManagedRuntime } from "effect"
import type {
	CachedTask,
	ICEUser,
	Scope,
	Task,
	TaskTree,
} from "../types/types.js"
// import mo from "motoko"
import { FileSystem, Path } from "@effect/platform"
import { InstallModes, CanisterSettings } from "../services/replica.js"
import {
	BindingsTask,
	BuildTask,
	DeployTask,
	DependencyMismatchError,
	ExtractScopeSuccesses,
	InstallTask,
	InstallTaskArgs,
	IsValid,
	TaskError,
	CreateTask,
	StopTask,
	RemoveTask,
	StatusTask,
	FileDigest,
	InstallArgsTask,
	ConfigTask,
	makeLoggerLayer,
	defaultBuilderRuntime,
	UnwrapConfig,
} from "./lib.js"
import {
	getNodeByPath,
	ResolvedParamsToArgs,
	TaskParamsToArgs,
} from "../tasks/lib.js"
import {
	AllowedDep,
	hashConfig,
	hashJson,
	isArtifactCachedEffect,
	linkChildren,
	makeCanisterStatusTask,
	makeCreateTask,
	makeInstallTask,
	makeInstallArgsTask,
	makeConfigTask,
	makeRemoveTask,
	makeStopTask,
	NormalizeDeps,
	normalizeDepsMap,
	Tags,
	ValidProvidedDeps,
} from "./lib.js"
// TODO: move to lib.ts
import { generateDIDJS } from "../canister.js"
import { type TaskCtx } from "../services/taskRuntime.js"
import { type } from "arktype"

export type CustomCanisterScope<
	_SERVICE = unknown,
	I = unknown,
	U = unknown,
	D extends Record<string, Task> = Record<string, Task>,
	P extends Record<string, Task> = Record<string, Task>,
> = {
	_tag: "scope"
	id: symbol
	tags: Array<string>
	description: string
	defaultTask: "deploy"
	// only limited to tasks
	// children: Record<string, Task>
	children: {
		// create: Task<string>
		config: ConfigTask<CustomCanisterConfig>
		create: CreateTask
		bindings: BindingsTask
		build: CustomBuildTask
		install: InstallTask<_SERVICE, I, U>
		install_args: InstallArgsTask<_SERVICE, I, U, D, P>
		// upgrade: UpgradeTask<_SERVICE, U, D, P>
		// D,
		// P
		stop: StopTask
		remove: RemoveTask
		deploy: DeployTask<_SERVICE>
		status: StatusTask
	}
}

/**
 * Configuration for a custom canister (pre-built Wasm).
 */
export type CustomCanisterConfig = {
	/**
	 * Path to the pre-compiled Wasm file.
	 */
	readonly wasm: string
	/**
	 * Path to the Candid interface file (.did).
	 */
	readonly candid: string
	/**
	 * Optional specific canister ID.
	 */
	readonly canisterId?: string
	/**
	 * Initial canister settings.
	 */
	readonly settings?: CanisterSettings
}

export const deployParams = {
	mode: {
		// TODO: doesnt become optional unless default is removed
		// fix the type of runTask
		type: InstallModes.or("'auto'"),
		description: "The mode to install the canister in",
		default: "auto" as const,
		isFlag: true as const,
		isOptional: true as const,
		isVariadic: false as const,
		name: "mode",
		aliases: ["m"],
		decode: (value: string) => value as InstallModes,
	},
	forceReinstall: {
		type: type("boolean"),
		description: "Force reinstall the canister",
		isFlag: true as const,
		isOptional: true as const,
		isVariadic: false as const,
		// default: false as const,
		name: "forceReinstall",
		aliases: ["f"],
		decode: (value: string) => !!value as unknown as boolean,
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
	// TODO: provide defaults. just read from fs by canister name
	// should we allow passing in wasm bytes?
	wasm: {
		type: type("string"),
		description: "The path to the wasm file",
		isFlag: true as const,
		isOptional: true as const,
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
		isOptional: true as const,
		isVariadic: false as const,
		name: "canisterId",
		aliases: ["i"],
		decode: (value: string) => value as string,
	},
}

export type DeployTaskArgs = ResolvedParamsToArgs<typeof deployParams>

export const makeCustomDeployTask = <_SERVICE>(): DeployTask<_SERVICE> => {
	const runtime = defaultBuilderRuntime
	return {
		_tag: "task",
		// TODO: change
		id: Symbol("canister/deploy"),
		dependsOn: {},
		// TODO: we only want to warn at a type level?
		// TODO: type Task
		dependencies: {},
		namedParams: deployParams,
		params: deployParams,
		positionalParams: [],
		effect: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_effect")(function* () {
					const { taskPath, runTask } = taskCtx
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					// const canisterConfig = yield* resolveConfig(
					// 	taskCtx,
					// 	canisterConfigOrFn,
					// 	// )
					// TODO: include this in taskCtx instead? parentNode?
					const parentScope = (yield* getNodeByPath(
						taskCtx,
						canisterName,
					)) as CustomCanisterScope<_SERVICE>
					const { args } = taskCtx
					const taskArgs = args as DeployTaskArgs
					// const mode = yield* resolveMode()

					// yield* Effect.logDebug("deploy taskArgs:", taskArgs)
					const result = yield* Effect.all(
						[
							Effect.gen(function* () {
								const startTime = performance.now()
								yield* Effect.logDebug(
									"Now running create task",
									{ startTime },
								)
								const canisterId = yield* Effect.tryPromise({
									try: () => {
										return runTask(
											parentScope.children.create,
											{},
										)
									},
									catch: (error) => {
										return new TaskError({
											message: String(error),
										})
									},
								})
								const afterRunTask = performance.now()
								yield* Effect.logDebug(
									`Finished running create task. [TIMING] runTask (create) took ${afterRunTask - startTime}ms`,
								)
								return canisterId
							}),
							Effect.gen(function* () {
								return yield* Effect.all(
									[
										Effect.tryPromise({
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
										}),
										// runTaskEffect(
										// 	parentScope.children.build,
										// 	{},
										// ),
										Effect.tryPromise({
											try: () =>
												runTask(
													parentScope.children
														.bindings,
													{},
												),
											catch: (error) => {
												return new TaskError({
													message: String(error),
												})
											},
										}),
										// runTaskEffect(
										// 	parentScope.children.bindings,
										// 	{},
										// ),
									],
									{
										concurrency: "unbounded",
									},
								)
							}),
						],
						{
							concurrency: "unbounded",
						},
					)
					const [canisterId, [{ wasmPath, candidPath }]] = result
					// TODO: move to install task? (mode normalization handled in install)

					const beforeRunInstallTask = performance.now()
					yield* Effect.logDebug("Now running install task", {
						canisterId,
						wasmPath,
						mode: taskArgs.mode,
						// result: JSON.stringify(result),
					})
					const taskResult = yield* Effect.tryPromise({
						try: () =>
							runTask(parentScope.children.install, {
								mode: taskArgs.mode,
								canisterId,
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
					const afterRunInstallTask = performance.now()
					yield* Effect.logDebug(
						`Finished running install task. [TIMING] runTask (install) took ${afterRunInstallTask - beforeRunInstallTask}ms`,
					)
					return taskResult
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
		description: "Deploy canister code",
		tags: [Tags.CANISTER, Tags.DEPLOY, Tags.CUSTOM],
	} satisfies DeployTask<_SERVICE>
}

export const makeBindingsTask = (
	configTask: ConfigTask<CustomCanisterConfig>,
): BindingsTask => {
	const runtime = defaultBuilderRuntime
	return {
		_tag: "task",
		id: Symbol("customCanister/bindings"),
		dependsOn: {},
		dependencies: {
			config: configTask,
		},
		// TODO: do we allow a fn as args here?
		effect: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_effect")(function* () {
					const depResults = taskCtx.depResults
					const canisterConfig = depResults["config"]
						?.result as CustomCanisterConfig
					// const canisterConfig = yield* resolveConfig(
					// 	taskCtx,
					// 	canisterConfigOrFn,
					// )
					const { taskPath } = taskCtx
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					const didPath = canisterConfig.candid
					yield* Effect.logDebug("Bindings task", canisterName, {
						didPath,
					})

					const { didJS, didJSPath, didTSPath } =
						yield* generateDIDJS(taskCtx, canisterName, didPath)
					yield* Effect.logDebug(
						`Generated DID JS for ${canisterName}`,
					)
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
				// TODO: unnecessary?
				taskPath: input.taskPath,
			})
		},
		input: (taskCtx) =>
			runtime.runPromise(
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
		description: "Generate bindings for custom canister",
		tags: [Tags.CANISTER, Tags.CUSTOM, Tags.BINDINGS],
		namedParams: {},
		positionalParams: [],
		params: {},
	} satisfies BindingsTask
}

export type CustomBuildTask = Omit<
	CachedTask<
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
			configWasm: string
			configCandid: string
			depCacheKeys: Record<string, string | undefined>
		}
	>,
	"params"
> & {
	params: typeof customBuildParams
	// params: Record<string, never>
}

const customBuildParams = {}

// TODO: pass in wasm and candid as task params instead?
export const makeCustomBuildTask = <P extends Record<string, unknown>>(
	configTask: ConfigTask<CustomCanisterConfig>,
	// canisterConfigOrFn:
	// 	| ((args: {
	// 			ctx: TaskCtxShape
	// 			deps: P
	// 	  }) => Promise<CustomCanisterConfig>)
	// 	| ((args: { ctx: TaskCtxShape; deps: P }) => CustomCanisterConfig)
	// 	| CustomCanisterConfig,
): CustomBuildTask => {
	const runtime = defaultBuilderRuntime
	return {
		_tag: "task",
		id: Symbol("customCanister/build"),
		dependsOn: {},
		dependencies: {
			config: configTask,
		},
		effect: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_effect")(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					// TODO: could be a promise
					// const canisterConfig = yield* resolveConfig(
					// 	taskCtx,
					// 	canisterConfigOrFn,
					// )
					const depResults = taskCtx.depResults
					const canisterConfig = depResults["config"]
						?.result as CustomCanisterConfig
					const { taskPath, appDir, iceDir } = taskCtx
					// TODO: pass in as arg instead?
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					// TODO: look at the canisterConfig.wasm directly instead
					const isGzipped = canisterConfig.wasm.endsWith(".gz")
					// const isGzipped = yield* fs.exists(
					// 	path.join(
					// 		appDir,
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
						isGzipped
							? `${canisterName}.wasm.gz`
							: `${canisterName}.wasm`,
					)
					yield* Effect.logDebug(
						"Reading wasm file",
						canisterConfig.wasm,
					)
					const wasm = yield* fs.readFile(canisterConfig.wasm)
					// Ensure the directory exists
					yield* fs.makeDirectory(path.dirname(outWasmPath), {
						recursive: true,
					})
					yield* fs.writeFile(outWasmPath, wasm)

					const outCandidPath = path.join(
						iceDir,
						"canisters",
						canisterName,
						`${canisterName}.did`,
					)
					const candid = yield* fs.readFile(canisterConfig.candid)
					yield* fs.writeFile(outCandidPath, candid)
					yield* Effect.logDebug("Built custom canister", {
						wasmPath: outWasmPath,
						candidPath: outCandidPath,
					})
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
				wasmHash: input.wasm.sha256,
				candidHash: input.candid.sha256,
				// depsHash: hashJson(input.depCacheKeys),
				configWasm: input.configWasm,
				configCandid: input.configCandid,
			}
			const cacheKey = hashJson(installInput)
			return cacheKey
		},
		input: (taskCtx) =>
			runtime.runPromise(
				Effect.fn("task_input")(function* () {
					const { taskPath, depResults } = taskCtx
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")
					const depCacheKeys = Record.map(
						depResults,
						(dep) => dep.cacheKey,
					)
					// TODO...? might be problematic if user does lots of async
					const canisterConfig = depResults["config"]
						?.result as CustomCanisterConfig
					const wasmPath = canisterConfig.wasm
					const candidPath = canisterConfig.candid

					// TODO: we need a separate cache for this?
					const prevWasmDigest = undefined
					const { fresh, digest: wasmDigest } =
						yield* isArtifactCachedEffect(wasmPath, prevWasmDigest)
					// yield* Effect.tryPromise({
					// 	//
					// 	try: () => isArtifactCached(wasmPath, prevWasmDigest),
					// 	// TODO:
					// 	catch: Effect.fail,
					// })
					const prevCandidDigest = undefined
					const { fresh: candidFresh, digest: candidDigest } =
						yield* isArtifactCachedEffect(
							candidPath,
							prevCandidDigest,
						)
					// yield* Effect.tryPromise({
					// 	try: () => isArtifactCached(candidPath, prevCandidDigest),
					// 	catch: Effect.fail,
					// })
					const input = {
						canisterName,
						taskPath,
						wasm: wasmDigest,
						candid: candidDigest,
						depCacheKeys,
						configWasm: wasmPath,
						configCandid: candidPath,
					}
					return input
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
		description: "Build custom canister",
		tags: [Tags.CANISTER, Tags.CUSTOM, Tags.BUILD],
		namedParams: {},
		positionalParams: [],
		params: customBuildParams,
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
	UnwrapConfig<T> extends { candid: infer S }
		? S extends keyof IceCanisterPaths
			? IceCanisterPaths[S]
			: unknown
		: unknown

/**
 * A builder for configuring Custom canisters (pre-compiled Wasm).
 *
 * @group Canister Definitions
 */
export class CustomCanisterBuilder<
	I,
	U,
	S extends CustomCanisterScope<_SERVICE, I, U, D, P>,
	D extends Record<string, Task>,
	P extends Record<string, Task>,
	const Config extends CustomCanisterConfig,
	_SERVICE = ResolveService<Config>,
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

	as<T, I = unknown, U = unknown>(): CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<T, I, U, D, P>,
		D,
		P,
		Config,
		T,
		TCtx
	> {
		return this as any
	}

	// TODO: does nothing? what do we even use it for?
	create(
		canisterConfigOrFn:
			| Config
			| ((args: { ctx: TCtx; deps: P }) => Config)
			| ((args: { ctx: TCtx; deps: P }) => Promise<Config>),
	): CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE,
		TCtx
	> {
		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				create: makeCreateTask<CustomCanisterConfig>(
					this.#scope.children.config,
					// canisterConfigOrFn,
					[Tags.CUSTOM],
				),
			},
		} satisfies CustomCanisterScope<_SERVICE, I, U, D, P>
		return new CustomCanisterBuilder(
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	// TODO: does nothing? what do we even use it for?
	build(
		canisterConfigOrFn:
			| Config
			| ((args: { ctx: TCtx; deps: P }) => Config)
			| ((args: { ctx: TCtx; deps: P }) => Promise<Config>),
	): CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE,
		TCtx
	> {
		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				build: makeCustomBuildTask<P>(
					this.#scope.children.config,
					// canisterConfigOrFn,
				),
			},
		} satisfies CustomCanisterScope<_SERVICE, I, U, D, P>
		return new CustomCanisterBuilder(
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	/**
	 * Defines the arguments for the `install` method.
	 *
	 * @param installArgsOrFn - A value or function returning the arguments.
	 * @returns The builder instance.
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
	): CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE,
		TCtx
	>
	installArgs(
		installArgsValue: I,
		options?: {
			customEncode:
				| undefined
				| ((args: I) => Promise<Uint8Array<ArrayBufferLike>>)
		},
	): CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE,
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
	): CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE,
		TCtx
	> {
		// TODO: passing in I makes the return type: any
		// TODO: we need to inject dependencies again! or they can be overwritten

		// const upgradeArgsFn = this.#scope.children.install_args ??
		this.#installArgs = {
			fn: installArgsOrFn,
			customEncode,
		}
		const install_args = makeInstallArgsTask<_SERVICE, I, U, D, P>(
			// TODO: fix later. no any
			this.#installArgs as any,
			this.#upgradeArgs as any,
			this.#scope.children.install_args.dependencies,
		)

		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				// TODO: add these to the task type
				install: makeInstallTask<_SERVICE, I, U>(
					this.#scope.children.install_args,
				) as InstallTask<_SERVICE, I, U>,
				install_args,
				// reuse installTask as upgradeTask by default unless overridden by user
				// how will it affect caching? both get invalidated when argsFn has changed
				// TODO: check in make instead?
			},
		} satisfies CustomCanisterScope<_SERVICE, I, U, D, P>

		return new CustomCanisterBuilder(
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	/**
	 * Defines the arguments for the `postUpgrade` method.
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
	): CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE,
		TCtx
	>
	upgradeArgs(
		upgradeArgsValue: U,
		options?: {
			customEncode:
				| undefined
				| ((args: U) => Promise<Uint8Array<ArrayBufferLike>>)
		},
	): CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE,
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
	): CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE,
		TCtx
	> {
		this.#upgradeArgs = {
			fn: upgradeArgsOrFn,
			customEncode,
		}
		// deps??
		const install_args = makeInstallArgsTask<_SERVICE, I, U, D, P>(
			this.#installArgs as any,
			this.#upgradeArgs as any,
			this.#scope.children.install_args.dependencies,
		)
		// TODO: passing in I makes the return type: any
		// TODO: we need to inject dependencies again! or they can be overwritten

		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				install_args,
			},
		} satisfies CustomCanisterScope<_SERVICE, I, U, D, P>

		return new CustomCanisterBuilder(
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	/**
	 * Declares dependencies needed for calculating arguments.
	 *
	 * @param dependencies - A map of dependencies.
	 * @returns The builder instance.
	 */
	deps<UP extends Record<string, AllowedDep>, NP extends NormalizeDeps<UP>>(
		dependencies: ValidProvidedDeps<D, UP>,
	): CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<_SERVICE, I, U, D, NP>,
		D,
		NP,
		Config,
		_SERVICE,
		TCtx
	> {
		const updatedDependencies = normalizeDepsMap(dependencies) as NP
		// TODO: ..... this is too much duplication
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
			dependencies: updatedDependencies,
		} as InstallArgsTask<_SERVICE, I, U, D, NP>

		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				install_args,
			},
		} satisfies CustomCanisterScope<_SERVICE, I, U, D, NP>
		return new CustomCanisterBuilder(updatedScope, installArgs, upgradeArgs)
	}

	/**
	 * Declares execution dependencies.
	 *
	 * @param dependsOn - A map of dependencies.
	 * @returns The builder instance.
	 */
	dependsOn<
		UD extends Record<string, AllowedDep>,
		ND extends NormalizeDeps<UD>,
	>(
		dependsOn: UD,
	): CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<_SERVICE, I, U, ND, P>,
		ND,
		P,
		Config,
		_SERVICE,
		TCtx
	> {
		const updatedDependsOn = normalizeDepsMap(dependsOn) as ND
		// TODO: ..... this is too much duplication
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
		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				install_args: {
					...this.#scope.children.install_args,
					dependsOn: updatedDependsOn,
				} as InstallArgsTask<_SERVICE, I, U, ND, P>,
			},
		} satisfies CustomCanisterScope<_SERVICE, I, U, ND, P>
		return new CustomCanisterBuilder(updatedScope, installArgs, upgradeArgs)
	}

	/**
	 * Finalizes the canister definition.
	 *
	 * @returns A `CustomCanisterScope` with all lifecycle tasks.
	 */
	make(
		this: IsValid<S> extends true
			? CustomCanisterBuilder<I, U, S, D, P, Config, _SERVICE, TCtx>
			: DependencyMismatchError<S>,
	): S {
		// Otherwise we get a type error
		const self = this as CustomCanisterBuilder<
			I,
			U,
			S,
			D,
			P,
			Config,
			_SERVICE,
			TCtx
		>
		const linkedChildren = linkChildren(self.#scope.children)
		const finalScope = {
			...self.#scope,
			id: Symbol("scope"),
			children: linkedChildren,
		} satisfies CustomCanisterScope<_SERVICE, I, U, D, P>
		return finalScope
	}
}

/**
 * Creates a Custom canister builder (for pre-built Wasm/Candid).
 *
 * @param canisterConfigOrFn - Configuration object or a function returning one.
 * @returns A {@link CustomCanisterBuilder}.
 *
 * @example
 * ```typescript
 * import { canister } from "@ice.ts/runner"
 *
 * export const internet_identity = canister.custom({
 *   wasm: "canisters/internet_identity/internet_identity.wasm",
 *   candid: "canisters/internet_identity/internet_identity.did"
 * }).make()
 * ```
 */
export const customCanister = <
	const Config extends CustomCanisterConfig,
	TCtx extends TaskCtx = TaskCtx,
	_SERVICE = ResolveService<Config>,
	I = unknown,
	U = unknown,
>(
	canisterConfigOrFn:
		| Config
		| ((args: { ctx: TCtx }) => Config | Promise<Config>),
): CustomCanisterBuilder<
	I,
	U,
	CustomCanisterScope<_SERVICE, I, U, {}, {}>,
	{},
	{},
	Config,
	_SERVICE,
	TCtx
> => {
	const config = makeConfigTask(canisterConfigOrFn as any)
	const installArgs = {
		fn: () => [] as I,
		customEncode: undefined,
	}
	const upgradeArgs = {
		fn: () => [] as U,
		customEncode: undefined,
	}
	const install_args = makeInstallArgsTask<_SERVICE, I, U, {}, {}>(
		installArgs,
		upgradeArgs,
		{},
	)

	const initialScope = {
		_tag: "scope",
		id: Symbol("scope"),
		tags: [Tags.CANISTER, Tags.CUSTOM],
		description: "Custom canister scope",
		defaultTask: "deploy",
		// TODO: default implementations
		children: {
			config,
			create: makeCreateTask(config, [Tags.CUSTOM]),
			bindings: makeBindingsTask(config),
			build: makeCustomBuildTask(config),
			install: makeInstallTask<_SERVICE, I, U>(install_args),
			install_args,
			// upgrade: makeUpgradeTask<U, {}, {}, _SERVICE>(builderRuntime),
			stop: makeStopTask(),
			remove: makeRemoveTask(),
			deploy: makeCustomDeployTask<_SERVICE>(),
			status: makeCanisterStatusTask([Tags.CUSTOM]),
		},
	} satisfies CustomCanisterScope<_SERVICE, I, U, {}, {}>

	return new CustomCanisterBuilder<
		I,
		U,
		CustomCanisterScope<_SERVICE, I, U, {}, {}>,
		{},
		{},
		Config,
		_SERVICE,
		TCtx
	>(initialScope, installArgs, upgradeArgs)
}
