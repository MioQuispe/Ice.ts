import { Effect, ManagedRuntime, Record } from "effect"
import type { CachedTask, Task } from "../types/types.js"
// import mo from "motoko"
import { FileSystem, Path } from "@effect/platform"
// TODO: move to ./lib.ts
import { compileMotokoCanister, generateDIDJS } from "../canister.js"
import { ParamsToArgs } from "../tasks/lib.js"
import { InstallModes } from "../services/replica.js"
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
	defaultBuilderRuntime,
} from "./lib.js"
import { type TaskCtxShape } from "../services/taskCtx.js"
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
} from "./lib.js"
import { type } from "arktype"
import { deployParams } from "./custom.js"
import { ActorSubclass } from "../types/actor.js"

export type MotokoCanisterConfig = {
	src: string
	canisterId?: string
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
// export const motokoDeployParams = {
// 	mode: {
// 		type: InstallModes,
// 		description: "The mode to install the canister in",
// 		default: "install",
// 		isFlag: true as const,
// 		isOptional: true as const,
// 		isVariadic: false as const,
// 		name: "mode",
// 		aliases: ["m"],
// 		parse: (value: string) => value as InstallModes,
// 	},
// 	args: {
// 		// TODO: maybe not Uint8Array?
// 		type: type("TypedArray.Uint8"),
// 		description: "The arguments to pass to the canister as a candid string",
// 		// default: undefined,
// 		isFlag: true as const,
// 		isOptional: true as const,
// 		isVariadic: false as const,
// 		name: "args",
// 		aliases: ["a"],
// 		parse: (value: string) => {
// 			// TODO: convert to candid string
// 			return new Uint8Array(Buffer.from(value))
// 		},
// 	},
// 	// TODO: provide defaults. just read from fs by canister name
// 	// should we allow passing in wasm bytes?
// 	wasm: {
// 		type: type("string"),
// 		description: "The path to the wasm file",
// 		isFlag: true as const,
// 		isOptional: true as const,
// 		isVariadic: false as const,
// 		name: "wasm",
// 		aliases: ["w"],
// 		parse: (value: string) => value as string,
// 	},
// 	// TODO: provide defaults
// 	candid: {
// 		// TODO: should be encoded?
// 		type: type("string"),
// 		description: "The path to the candid file",
// 		isFlag: true as const,
// 		isOptional: true as const,
// 		isVariadic: false as const,
// 		name: "candid",
// 		aliases: ["c"],
// 		parse: (value: string) => value as string,
// 	},
// 	// TODO: provide defaults
// 	canisterId: {
// 		type: type("string"),
// 		description: "The canister ID to install the canister in",
// 		isFlag: true as const,
// 		isOptional: true as const,
// 		isVariadic: false as const,
// 		name: "canisterId",
// 		aliases: ["i"],
// 		parse: (value: string) => value as string,
// 	},
// }

export type MotokoDeployTask<
	_SERVICE = unknown,
> = Omit<
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

export type MotokoDeployTaskArgs = ParamsToArgs<typeof motokoDeployParams>

export const makeMotokoDeployTask = <
	_SERVICE,
>(
	builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
	canisterConfigOrFn:
		| ((args: {
				ctx: TaskCtxShape
		  }) => Promise<MotokoCanisterConfig>)
		| ((args: { ctx: TaskCtxShape }) => MotokoCanisterConfig)
		| MotokoCanisterConfig,
): MotokoDeployTask<_SERVICE> => {
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
										"Now running bindings task",
									)
									const { didJSPath, didTSPath } =
										yield* Effect.tryPromise({
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
							}),
						catch: (error) => {
							return new TaskError({
								message: String(error),
							})
						},
					})

					yield* Effect.logDebug("Canister deployed successfully")
					return taskResult
				})(),
			),
		description: "Deploy canister code",
		tags: [Tags.CANISTER, Tags.DEPLOY, Tags.MOTOKO],
	}
}

export type MotokoBindingsTask = CachedTask<
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

const motokoBindingsParams = {
	// TODO:
	wasm: {
		type: "string",
		description: "Path to the wasm file",
	},
	candid: {
		type: "string",
		description: "Path to the candid file",
	},
}
export const makeMotokoBindingsTask = (
	builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
): MotokoBindingsTask => {
	return {
		_tag: "task",
		id: Symbol("motokoCanister/bindings"),
		dependsOn: {},
		dependencies: {},
		namedParams: {},
		positionalParams: [],
		params: {},
		// TODO: do we allow a fn as args here?
		effect: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.fn("task_effect")(function* () {
					const path = yield* Path.Path
					const fs = yield* FileSystem.FileSystem
					const { taskPath, appDir, iceDir } = taskCtx
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
					const wasmPath = path.join(
						iceDir,
						"canisters",
						canisterName,
						isGzipped
							? `${canisterName}.wasm.gz`
							: `${canisterName}.wasm`,
					)
					const didPath = path.join(
						iceDir,
						"canisters",
						canisterName,
						`${canisterName}.did`,
					)
					// TODO: convert to task params instead. the above can be the defaults
					// const wasmPath = taskArgs.wasm
					// const candidPath = taskArgs.candid

					yield* Effect.logDebug("Artifact paths", {
						wasmPath,
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
				})(),
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
				})(),
			),
		encode: (taskCtx, value) =>
			builderRuntime.runPromise(
				Effect.fn("task_encode")(function* () {
					return JSON.stringify(value)
				})(),
			),
		decode: (taskCtx, value) =>
			builderRuntime.runPromise(
				Effect.fn("task_decode")(function* () {
					return JSON.parse(value as string)
				})(),
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
		depCacheKeys: Record<string, string | undefined>
	}
>

export const makeMotokoBuildTask = <C extends MotokoCanisterConfig>(
    builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
    configTask: ConfigTask<C>,
): MotokoBuildTask => {
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
                    const isGzipped = yield* fs.exists(
                        path.join(
                            iceDir,
                            "canisters",
                            canisterName,
                            `${canisterName}.wasm.gz`,
                        ),
                    )
                    const wasmOutputFilePath = path.join(
                        iceDir,
                        "canisters",
                        canisterName,
                        isGzipped
                            ? `${canisterName}.wasm.gz`
                            : `${canisterName}.wasm`,
                    )
                    const outCandidPath = path.join(
                        iceDir,
                        "canisters",
                        canisterName,
                        `${canisterName}.did`,
                    )
                    // Ensure the directory exists
                    yield* fs.makeDirectory(path.dirname(wasmOutputFilePath), {
                        recursive: true,
                    })
                    yield* Effect.logDebug("Compiling Motoko canister")
                    yield* compileMotokoCanister(
                        path.resolve(appDir, canisterConfig.src),
                        canisterName,
                        wasmOutputFilePath,
                    )
                    yield* Effect.logDebug(
                        "Motoko canister built successfully",
                        {
                            wasmPath: wasmOutputFilePath,
                            candidPath: outCandidPath,
                        },
                    )
                    return {
                        wasmPath: wasmOutputFilePath,
                        candidPath: outCandidPath,
                    }
                })(),
            ),
        computeCacheKey: (input) => {
            // TODO: pocket-ic could be restarted?
            const installInput = {
                taskPath: input.taskPath,
                depsHash: hashJson(input.depCacheKeys),
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
                            yield* Effect.tryPromise({
                                try: () =>
                                    isArtifactCached(filePath, prevSrcDigest),
                                catch: (e) =>
                                    new TaskError({
                                        message:
                                            "Failed to check if artifact is cached",
                                    }),
                            })
                        srcDigests.push(srcDigest)
                    }
                    const input = {
                        taskPath,
                        src: srcDigests,
                        depCacheKeys,
                    }
                    return input
                })(),
            ),
        encode: (taskCtx, value) =>
            builderRuntime.runPromise(
                Effect.fn("task_encode")(function* () {
                    return JSON.stringify(value)
                })(),
            ),
        decode: (taskCtx, value) =>
            builderRuntime.runPromise(
                Effect.fn("task_decode")(function* () {
                    return JSON.parse(value as string)
                })(),
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
> = {
    fn: (args: {
        ctx: TaskCtxShape
        deps: ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>
    }) => I | Promise<I>
    customEncode:
        | undefined
        | ((args: I) => Promise<Uint8Array<ArrayBufferLike>>)
}

export class MotokoCanisterBuilder<
	I,
	U,
	S extends MotokoCanisterScope<_SERVICE, I, U, D, P>,
	D extends Record<string, Task>,
	P extends Record<string, Task>,
	Config extends MotokoCanisterConfig,
	_SERVICE = unknown,
> {
	#scope: S
	#builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>
	#installArgs: ArgsFields<I, D, P>
	#upgradeArgs: ArgsFields<U, D, P>
	constructor(
		builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
		scope: S,
		installArgs: ArgsFields<I, D, P>,
		upgradeArgs: ArgsFields<U, D, P>,
	) {
		this.#builderRuntime = builderRuntime
		this.#scope = scope
		this.#installArgs = installArgs
		this.#upgradeArgs = upgradeArgs
	}
	create(
		canisterConfigOrFn:
			| Config
			| ((args: { ctx: TaskCtxShape }) => Config)
			| ((args: { ctx: TaskCtxShape }) => Promise<Config>),
	): MotokoCanisterBuilder<
		I,
		U,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE
	> {
		const config = makeConfigTask<Config>(
			this.#builderRuntime,
			canisterConfigOrFn,
		)
		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				config,
				create: makeCreateTask<Config>(
					this.#builderRuntime,
					config,
					[Tags.MOTOKO],
				),
				build: makeMotokoBuildTask(this.#builderRuntime, config),
			},
		} satisfies MotokoCanisterScope<_SERVICE, I, U, D, P>
		return new MotokoCanisterBuilder(
			this.#builderRuntime,
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	build(): MotokoCanisterBuilder<
		I,
		U,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE
	> {
		// no-op; build is derived from config
		return new MotokoCanisterBuilder(
			this.#builderRuntime,
			this.#scope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	installArgs(
		installArgsFn: (args: {
			ctx: TaskCtxShape
			deps: ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>
		}) => I | Promise<I>,
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
		I,
		U,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE
	> {
		this.#installArgs = {
			fn: installArgsFn,
			customEncode,
		}
		const install_args = makeInstallArgsTask<_SERVICE, I, U, D, P>(
			this.#builderRuntime,
			this.#installArgs,
			this.#upgradeArgs,
			this.#scope.children.install_args.dependencies as P,
		)
		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				install: makeInstallTask<_SERVICE, I, U>(
					this.#builderRuntime,
					install_args,
				),
				install_args,
			},
		} satisfies MotokoCanisterScope<_SERVICE, I, U, D, P>

		return new MotokoCanisterBuilder(
			this.#builderRuntime,
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	upgradeArgs(
		upgradeArgsFn: (args: {
			ctx: TaskCtxShape
			deps: ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>
		}) => U | Promise<U>,
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
		I,
		U,
		MotokoCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE
	> {
		this.#upgradeArgs = {
			fn: upgradeArgsFn,
			customEncode,
		}
		const install_args = makeInstallArgsTask<_SERVICE, I, U, D, P>(
			this.#builderRuntime,
			this.#installArgs,
			this.#upgradeArgs,
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
			this.#builderRuntime,
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	deps<UP extends Record<string, AllowedDep>, NP extends NormalizeDeps<UP>>(
		providedDeps: ValidProvidedDeps<D, UP>,
	): MotokoCanisterBuilder<
		I,
		U,
		MotokoCanisterScope<_SERVICE, I, U, D, NP>,
		D,
		NP,
		Config,
		_SERVICE
	> {
		const finalDeps = normalizeDepsMap(providedDeps) as NP
		const installArgs = this.#installArgs as unknown as ArgsFields<I, D, NP>
		const upgradeArgs = this.#upgradeArgs as unknown as ArgsFields<U, D, NP>
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
		return new MotokoCanisterBuilder(
			this.#builderRuntime,
			updatedScope,
			installArgs,
			upgradeArgs,
		)
	}

	dependsOn<
		UD extends Record<string, AllowedDep>,
		ND extends NormalizeDeps<UD>,
	>(
		dependencies: UD,
	): MotokoCanisterBuilder<
		I,
		U,
		MotokoCanisterScope<_SERVICE, I, U, ND, P>,
		ND,
		P,
		Config,
		_SERVICE
	> {
		const updatedDependsOn = normalizeDepsMap(dependencies) as ND
		const installArgs = this.#installArgs as unknown as ArgsFields<I, ND, P>
		const upgradeArgs = this.#upgradeArgs as unknown as ArgsFields<U, ND, P>
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
		return new MotokoCanisterBuilder(
			this.#builderRuntime,
			updatedScope,
			installArgs,
			upgradeArgs,
		)
	}

	make(
		this: IsValid<S> extends true
			? MotokoCanisterBuilder<I, U, S, D, P, Config, _SERVICE>
			: DependencyMismatchError<S>,
	): S {
		// // Otherwise we get a type error
		const self = this as MotokoCanisterBuilder<
			I,
			U,
			S,
			D,
			P,
			Config,
			_SERVICE
		>

		// TODO: can we do this in a type-safe way?
		// so we get warnings about stale dependencies?
		const linkedChildren = linkChildren(self.#scope.children)

		const finalScope = {
			...self.#scope,
			id: Symbol("scope"),
			children: linkedChildren,
		} satisfies MotokoCanisterScope<_SERVICE, I, U, D, P>
		return finalScope
	}
}

export const makeMotokoCanister = <
	_SERVICE = unknown,
	I = unknown,
	U = unknown,
>(
    builderRuntime: ManagedRuntime.ManagedRuntime<unknown, unknown>,
    canisterConfigOrFn:
        | MotokoCanisterConfig
        | ((args: { ctx: TaskCtxShape }) => MotokoCanisterConfig)
        | ((args: { ctx: TaskCtxShape }) => Promise<MotokoCanisterConfig>),
) => {
    const initialScope = {
        _tag: "scope",
        id: Symbol("scope"),
        tags: [Tags.CANISTER, Tags.MOTOKO],
        description: "Motoko canister scope",
        defaultTask: "deploy",
        children: {
			config: makeConfigTask(builderRuntime, canisterConfigOrFn),
			create: makeCreateTask(builderRuntime, makeConfigTask(builderRuntime, canisterConfigOrFn), [
				Tags.MOTOKO,
			]),
			build: makeMotokoBuildTask(builderRuntime, makeConfigTask(builderRuntime, canisterConfigOrFn)),
			bindings: makeMotokoBindingsTask(builderRuntime),
            stop: makeStopTask(builderRuntime),
            remove: makeRemoveTask(builderRuntime),
			install_args: makeInstallArgsTask<_SERVICE, I, U, {}, {}>(builderRuntime, { fn: () => [] as I, customEncode: undefined }, { fn: () => [] as U, customEncode: undefined }, {} as {}),
			install: makeInstallTask<_SERVICE, I, U>(builderRuntime, makeInstallArgsTask<_SERVICE, I, U, {}, {}>(builderRuntime, { fn: () => [] as I, customEncode: undefined }, { fn: () => [] as U, customEncode: undefined }, {} as {})),
			deploy: makeMotokoDeployTask<_SERVICE>(builderRuntime, canisterConfigOrFn),
            status: makeCanisterStatusTask(builderRuntime, [Tags.MOTOKO]),
        },
    } satisfies MotokoCanisterScope<_SERVICE, I, U, {}, {}>

    const installArgs = { fn: () => [] as I, customEncode: undefined }
    const upgradeArgs = { fn: () => [] as U, customEncode: undefined }
    return new MotokoCanisterBuilder<
        I,
        U,
        MotokoCanisterScope<_SERVICE, I, U, {}, {}>,
        {},
        {},
        MotokoCanisterConfig,
        _SERVICE
    >(builderRuntime, initialScope, installArgs, upgradeArgs)
}

export const motokoCanister = <
	_SERVICE = unknown,
	I extends unknown[] = unknown[],
	U extends unknown[] = unknown[],
>(
	canisterConfigOrFn:
		| MotokoCanisterConfig
		| ((args: { ctx: TaskCtxShape }) => MotokoCanisterConfig)
		| ((args: { ctx: TaskCtxShape }) => Promise<MotokoCanisterConfig>),
) => {
	return makeMotokoCanister<_SERVICE, I, U>(
		defaultBuilderRuntime as ManagedRuntime.ManagedRuntime<
			unknown,
			unknown
		>,
		canisterConfigOrFn,
	)
	// const initialScope = {
	// 	_tag: "scope",
	// 	id: Symbol("scope"),
	// 	tags: [Tags.CANISTER, Tags.MOTOKO],
	// 	description: "Motoko canister scope",
	// 	defaultTask: "deploy",
	// 	children: {
	// 		create: makeCreateTask(canisterConfigOrFn, [Tags.MOTOKO]),
	// 		build: makeMotokoBuildTask(canisterConfigOrFn),
	// 		bindings: makeMotokoBindingsTask(),
	// 		stop: makeStopTask(),
	// 		remove: makeRemoveTask(),
	// 		install: makeInstallTask<I, {}, {}, _SERVICE>(),
	// 		upgrade: makeUpgradeTask<U, {}, {}, _SERVICE>(),
	// 		deploy: makeMotokoDeployTask<_SERVICE, P>(canisterConfigOrFn),
	// 		status: makeCanisterStatusTask([Tags.MOTOKO]),
	// 	},
	// } satisfies MotokoCanisterScope<_SERVICE, I, U, {}, {}>

	// return new MotokoCanisterBuilder<
	// 	I,
	// 	U,
	// 	MotokoCanisterScope<_SERVICE, I, U, {}, {}>,
	// 	{},
	// 	{},
	// 	MotokoCanisterConfig,
	// 	_SERVICE
	// >(initialScope)
}
