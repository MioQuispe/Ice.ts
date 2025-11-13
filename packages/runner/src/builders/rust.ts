import { Effect, Layer, ManagedRuntime, Record, Fiber } from "effect"
import type { CachedTask, Task } from "../types/types.js"
import { FileSystem, Path, Command, CommandExecutor } from "@effect/platform"
import { generateDIDJS } from "../canister.js"
import {
	ParamsToArgs,
	ResolvedParamsToArgs,
	TaskParamsToArgs,
} from "../tasks/lib.js"
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
	baseLayer,
	type BuilderLayer,
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
} from "./lib.js"
import { type } from "arktype"
import { deployParams } from "./custom.js"
import { ActorSubclass } from "../types/actor.js"
import { decodeText, runFold, Stream } from "effect/Stream"

export type RustCanisterConfig = {
	src: string // Path to Cargo.toml
	candid: string // Path to .did file
	canisterId?: string
}

export type RustCanisterScope<
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
	children: {
		config: ConfigTask<RustCanisterConfig>
		create: CreateTask
		bindings: RustBindingsTask
		build: RustBuildTask
		install: InstallTask<_SERVICE, I, U>
		install_args: InstallArgsTask<_SERVICE, I, U, D, P>
		stop: StopTask
		remove: RemoveTask
		deploy: RustDeployTask<_SERVICE>
		status: StatusTask
	}
}

export const rustDeployParams = deployParams

export type RustDeployTask<_SERVICE = unknown> = Omit<
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
	params: typeof rustDeployParams
}

export type RustDeployTaskArgs = ResolvedParamsToArgs<typeof rustDeployParams>

export const makeRustDeployTask = <_SERVICE>(
	builderLayer: BuilderLayer,
	canisterConfigOrFn:
		| ((args: { ctx: TaskCtx }) => Promise<RustCanisterConfig>)
		| ((args: { ctx: TaskCtx }) => RustCanisterConfig)
		| RustCanisterConfig,
): RustDeployTask<_SERVICE> => {
	const builderRuntime = ManagedRuntime.make(builderLayer)
	return {
		_tag: "task",
		id: Symbol("canister/deploy"),
		dependsOn: {},
		dependencies: {},
		namedParams: rustDeployParams,
		params: rustDeployParams,
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
					)) as RustCanisterScope<_SERVICE>
					const { args, runTask } = taskCtx
					const taskArgs = args as RustDeployTaskArgs
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
								canisterId,
								candid: candidPath,
								wasm: wasmPath,
								forceReinstall: taskArgs.forceReinstall,
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
		tags: [Tags.CANISTER, Tags.DEPLOY, Tags.RUST],
	}
}

const rustBindingsParams = {
	candid: {
		type: type("string"),
		description: "Path to the candid file",
		name: "candid",
		isFlag: true as const,
		parse: (value: string) => value,
		isOptional: false as const,
		isVariadic: false as const,
	},
}
export type RustBindingsTaskArgs = ResolvedParamsToArgs<
	typeof rustBindingsParams
>

export type RustBindingsTask = Omit<
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
	params: typeof rustBindingsParams
	namedParams: typeof rustBindingsParams
}

export const makeRustBindingsTask = (
	builderLayer: BuilderLayer,
): RustBindingsTask => {
	const builderRuntime = ManagedRuntime.make(builderLayer)
	return {
		_tag: "task",
		id: Symbol("rustCanister/bindings"),
		dependsOn: {},
		dependencies: {},
		namedParams: rustBindingsParams,
		positionalParams: [],
		params: rustBindingsParams,
		effect: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.fn("task_effect")(function* () {
					const path = yield* Path.Path
					const fs = yield* FileSystem.FileSystem
					const { taskPath, appDir, iceDir } = taskCtx
					const { candid } = taskCtx.args as RustBindingsTaskArgs
					const depResults = taskCtx.depResults
					const canisterConfig = depResults["config"]
						?.result as RustCanisterConfig
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")

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
						didJSPath: didJSPath,
						didTSPath: didTSPath,
					})
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
		description: "Generate bindings for Rust canister",
		tags: [Tags.CANISTER, Tags.RUST, Tags.BINDINGS],
	}
}

export type RustBuildTask = CachedTask<
	{
		wasmPath: string
		candidPath: string
	},
	{},
	{},
	{
		taskPath: string
		src: Array<FileDigest>
		cargoToml: FileDigest
		depCacheKeys: Record<string, string | undefined>
	}
>

const extractPackageNameFromCargoToml = (cargoTomlContent: string): string => {
	const packageMatch = cargoTomlContent.match(
		/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/,
	)
	if (!packageMatch || !packageMatch[1]) {
		throw new Error("Could not extract package name from Cargo.toml")
	}
	return packageMatch[1]
}

const Uint8ArrayStreamToString = <E, R>(
	stream: Stream<Uint8Array<ArrayBufferLike>, E, R>,
) =>
	stream.pipe(
		decodeText(),
		runFold("", (a, b) => a + b),
	)

export const makeRustBuildTask = <C extends RustCanisterConfig>(
	builderLayer: BuilderLayer,
	configTask: ConfigTask<C>,
): RustBuildTask => {
	const builderRuntime = ManagedRuntime.make(builderLayer)
	return {
		_tag: "task",
		id: Symbol("rustCanister/build"),
		dependsOn: {},
		dependencies: {
			config: configTask,
		},
		effect: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.gen(function* () {
					yield* Effect.logDebug("Building Rust canister")
					const path = yield* Path.Path
					const fs = yield* FileSystem.FileSystem
					const commandExecutor =
						yield* CommandExecutor.CommandExecutor
					const { appDir, iceDir, taskPath } = taskCtx
					const depResults = taskCtx.depResults
					const canisterConfig = depResults["config"]
						?.result as RustCanisterConfig
					const canisterName = taskPath
						.split(":")
						.slice(0, -1)
						.join(":")

					yield* Effect.logDebug("Building Rust canister", {
						canisterName,
						canisterConfig,
					})

					// Read Cargo.toml to extract package name
					const cargoTomlPath = path.resolve(
						appDir,
						canisterConfig.src,
					)
					const cargoTomlContent =
						yield* fs.readFileString(cargoTomlPath)
					const packageName =
						extractPackageNameFromCargoToml(cargoTomlContent)

					yield* Effect.logDebug("Extracted package name", {
						packageName,
						cargoTomlPath,
						cargoTomlContent,
					})

					// Determine workspace root (directory containing Cargo.toml)
					const workspaceRoot = path.dirname(cargoTomlPath)

					yield* Effect.logDebug(
						"Building Rust canister with cargo",
						{
							package: packageName,
							workspaceRoot,
						},
					)

					// Run cargo build with cd to set working directory
					const command = Command.make(
						"cargo",
						"build",
						"--target",
						"wasm32-unknown-unknown",
						"--release",
						"-p",
						packageName,
						// "--locked",
					).pipe(Command.workingDirectory(workspaceRoot))

					// Use exitCode to properly capture both stdout/stderr and check exit status
					// We need to start consuming streams BEFORE waiting for exitCode
					const cargoProcess = yield* commandExecutor.start(command)

					// Start reading stdout and stderr concurrently
					const stdoutFiber = yield* Effect.fork(
						Uint8ArrayStreamToString(cargoProcess.stdout),
					)
					const stderrFiber = yield* Effect.fork(
						Uint8ArrayStreamToString(cargoProcess.stderr),
					)

					// Wait for process to finish
					const exitCode = yield* cargoProcess.exitCode
					// Now collect the output
					const stdout = yield* Fiber.join(stdoutFiber)
					const stderr = yield* Fiber.join(stderrFiber)

					yield* Effect.logDebug("Cargo build output", {
						exitCode,
						stdout,
						stderr,
					})

					if (exitCode !== 0) {
						return yield* Effect.fail(
							new TaskError({
								message: `Cargo build failed with error: 

                                ${stderr}

                                `,
							}),
						)
					}

					yield* Effect.logDebug("Cargo build succeeded")

					// Source paths for wasm and candid
					const srcWasmPath = path.join(
						workspaceRoot,
						"target",
						"wasm32-unknown-unknown",
						"release",
						`${packageName.replace(/-/g, "_")}.wasm`,
					)
					const srcCandidPath = path.resolve(
						appDir,
						canisterConfig.candid,
					)

					// Output paths
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

					// TODO: doesnt store past builds....
					// need to either store them or recompile?
					// otherwise cache hits wont work correctly

					// Copy wasm file to output directory
					yield* fs.copy(srcWasmPath, outWasmPath, {
						overwrite: true,
					})

					// Copy candid file to output directory
					yield* fs.copy(srcCandidPath, outCandidPath, {
						overwrite: true,
					})

					yield* Effect.logDebug("Rust canister built successfully", {
						wasmPath: outWasmPath,
						candidPath: outCandidPath,
					})
					return {
						wasmPath: outWasmPath,
						candidPath: outCandidPath,
					}
				}).pipe(Effect.withSpan("task_effect"), Effect.scoped),
			),
		computeCacheKey: (input) => {
			const buildInput = {
				taskPath: input.taskPath,
				depsHash: hashJson(input.depCacheKeys),
				srcHash: hashJson(
					input.src.map((s) => `${s.sha256}-${s.mtimeMs}`),
				),
				cargoTomlHash: input.cargoToml.sha256,
			}
			const cacheKey = hashJson(buildInput)
			console.log("build computeCacheKey input", input)
			console.log("cacheKey", cacheKey)
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
						?.result as RustCanisterConfig
					const path = yield* Path.Path
					const fs = yield* FileSystem.FileSystem
					const cargoTomlPath = path.resolve(
						taskCtx.appDir,
						canisterConfig.src,
					)
					const srcDir = path.join(path.dirname(cargoTomlPath), "src")

					// Hash Cargo.toml
					const { digest: cargoTomlDigest } = yield* isArtifactCached(
						cargoTomlPath,
						undefined,
					)

					// Hash all .rs files
					const entries = yield* fs.readDirectory(srcDir, {
						recursive: true,
					})
					const srcFiles = entries.filter((entry) =>
						entry.endsWith(".rs"),
					)
					const srcDigests: Array<FileDigest> = []
					for (const file of srcFiles) {
						const filePath = path.join(srcDir, file)
						const { digest: srcDigest } = yield* isArtifactCached(
							filePath,
							undefined,
						)
						srcDigests.push(srcDigest)
					}
					const input = {
						taskPath,
						src: srcDigests,
						cargoToml: cargoTomlDigest,
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
		description: "Build Rust canister",
		tags: [Tags.CANISTER, Tags.RUST, Tags.BUILD],
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
		ctx: TaskCtx
		deps: ExtractScopeSuccesses<D> & ExtractScopeSuccesses<P>
	}) => I | Promise<I>
	customEncode:
		| undefined
		| ((args: I) => Promise<Uint8Array<ArrayBufferLike>>)
}

export class RustCanisterBuilder<
	I,
	U,
	S extends RustCanisterScope<_SERVICE, I, U, D, P>,
	D extends Record<string, Task>,
	P extends Record<string, Task>,
	Config extends RustCanisterConfig,
	_SERVICE = unknown,
> {
	#scope: S
	#builderLayer: BuilderLayer
	#installArgs: ArgsFields<I, D, P>
	#upgradeArgs: ArgsFields<U, D, P>
	constructor(
		builderLayer: BuilderLayer,
		scope: S,
		installArgs: ArgsFields<I, D, P>,
		upgradeArgs: ArgsFields<U, D, P>,
	) {
		this.#builderLayer = builderLayer
		this.#scope = scope
		this.#installArgs = installArgs
		this.#upgradeArgs = upgradeArgs
	}
	create(
		canisterConfigOrFn:
			| Config
			| ((args: { ctx: TaskCtx }) => Config)
			| ((args: { ctx: TaskCtx }) => Promise<Config>),
	): RustCanisterBuilder<
		I,
		U,
		RustCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE
	> {
		const config = makeConfigTask<Config>(
			this.#builderLayer,
			canisterConfigOrFn,
		)
		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				config,
				create: makeCreateTask<Config>(this.#builderLayer, config, [
					Tags.RUST,
				]),
				build: makeRustBuildTask(this.#builderLayer, config),
			},
		} satisfies RustCanisterScope<_SERVICE, I, U, D, P>
		return new RustCanisterBuilder(
			this.#builderLayer,
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	build(): RustCanisterBuilder<
		I,
		U,
		RustCanisterScope<_SERVICE, I, U, D, P>,
		D,
		P,
		Config,
		_SERVICE
	> {
		// no-op; build is derived from config
		return new RustCanisterBuilder(
			this.#builderLayer,
			this.#scope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	installArgs(
		installArgsFn: (args: {
			ctx: TaskCtx
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
	): RustCanisterBuilder<
		I,
		U,
		RustCanisterScope<_SERVICE, I, U, D, P>,
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
			this.#builderLayer,
			this.#installArgs,
			this.#upgradeArgs,
			this.#scope.children.install_args.dependencies as P,
		)
		const updatedScope = {
			...this.#scope,
			children: {
				...this.#scope.children,
				install: makeInstallTask<_SERVICE, I, U>(
					this.#builderLayer,
					install_args,
				),
				install_args,
			},
		} satisfies RustCanisterScope<_SERVICE, I, U, D, P>

		return new RustCanisterBuilder(
			this.#builderLayer,
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	upgradeArgs(
		upgradeArgsFn: (args: {
			ctx: TaskCtx
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
	): RustCanisterBuilder<
		I,
		U,
		RustCanisterScope<_SERVICE, I, U, D, P>,
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
			this.#builderLayer,
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
		} satisfies RustCanisterScope<_SERVICE, I, U, D, P>

		return new RustCanisterBuilder(
			this.#builderLayer,
			updatedScope,
			this.#installArgs,
			this.#upgradeArgs,
		)
	}

	deps<UP extends Record<string, AllowedDep>, NP extends NormalizeDeps<UP>>(
		providedDeps: ValidProvidedDeps<D, UP>,
	): RustCanisterBuilder<
		I,
		U,
		RustCanisterScope<_SERVICE, I, U, D, NP>,
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
		} satisfies RustCanisterScope<_SERVICE, I, U, D, NP>
		return new RustCanisterBuilder(
			this.#builderLayer,
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
	): RustCanisterBuilder<
		I,
		U,
		RustCanisterScope<_SERVICE, I, U, ND, P>,
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
		} satisfies RustCanisterScope<_SERVICE, I, U, ND, P>
		return new RustCanisterBuilder(
			this.#builderLayer,
			updatedScope,
			installArgs,
			upgradeArgs,
		)
	}

	make(
		this: IsValid<S> extends true
			? RustCanisterBuilder<I, U, S, D, P, Config, _SERVICE>
			: DependencyMismatchError<S>,
	): S {
		const self = this as RustCanisterBuilder<
			I,
			U,
			S,
			D,
			P,
			Config,
			_SERVICE
		>

		const linkedChildren = linkChildren(self.#scope.children)

		const finalScope = {
			...self.#scope,
			id: Symbol("scope"),
			children: linkedChildren,
		} satisfies RustCanisterScope<_SERVICE, I, U, D, P>
		return finalScope
	}
}

export const makeRustCanister = <_SERVICE = unknown, I = unknown, U = unknown>(
	builderLayer: BuilderLayer,
	canisterConfigOrFn:
		| RustCanisterConfig
		| ((args: { ctx: TaskCtx }) => RustCanisterConfig)
		| ((args: { ctx: TaskCtx }) => Promise<RustCanisterConfig>),
) => {
	const config = makeConfigTask(builderLayer, canisterConfigOrFn)
    const install_args = makeInstallArgsTask<_SERVICE, I, U, {}, {}>(
		builderLayer,
		{ fn: () => [] as I, customEncode: undefined },
		{ fn: () => [] as U, customEncode: undefined },
		{} as {},
	)
	const initialScope = {
		_tag: "scope",
		id: Symbol("scope"),
		tags: [Tags.CANISTER, Tags.RUST],
		description: "Rust canister scope",
		defaultTask: "deploy",
		children: {
			config,
			create: makeCreateTask(
				builderLayer,
				config,
				[Tags.RUST],
			),
			build: makeRustBuildTask(
				builderLayer,
				config,
			),
			bindings: makeRustBindingsTask(builderLayer),
			stop: makeStopTask(builderLayer),
			remove: makeRemoveTask(builderLayer),
			install_args,
			install: makeInstallTask<_SERVICE, I, U>(
				builderLayer,
				install_args,
			),
			deploy: makeRustDeployTask<_SERVICE>(
				builderLayer,
				canisterConfigOrFn,
			),
			status: makeCanisterStatusTask(builderLayer, [Tags.RUST]),
		},
	} satisfies RustCanisterScope<_SERVICE, I, U, {}, {}>

	const installArgs = { fn: () => [] as I, customEncode: undefined }
	const upgradeArgs = { fn: () => [] as U, customEncode: undefined }
	return new RustCanisterBuilder<
		I,
		U,
		RustCanisterScope<_SERVICE, I, U, {}, {}>,
		{},
		{},
		RustCanisterConfig,
		_SERVICE
	>(builderLayer, initialScope, installArgs, upgradeArgs)
}

export const rustCanister = <
	_SERVICE = unknown,
	I extends unknown[] = unknown[],
	U extends unknown[] = unknown[],
>(
	canisterConfigOrFn:
		| RustCanisterConfig
		| ((args: { ctx: TaskCtx }) => RustCanisterConfig)
		| ((args: { ctx: TaskCtx }) => Promise<RustCanisterConfig>),
) => {
	return makeRustCanister<_SERVICE, I, U>(
		baseLayer as BuilderLayer,
		canisterConfigOrFn,
	)
}
