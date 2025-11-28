import { Effect, ManagedRuntime, Record } from "effect"
import type { Task } from "../types/types.js"
import { Path } from "@effect/platform"
import { generateDIDJS } from "../canister.js"
import { InstallModes } from "../services/replica.js"
import {
	BindingsTask,
	DependencyMismatchError,
	IsValid,
	StatusTask,
	ConfigTask,
	makeLoggerLayer,
	CanisterDidModule,
	defaultBuilderRuntime,
	UnwrapConfig,
} from "./lib.js"
import { type TaskCtx } from "../services/taskRuntime.js"
import { getNodeByPath, ResolvedParamsToArgs } from "../tasks/lib.js"
import {
	hashJson,
	linkChildren,
	makeCanisterStatusTask,
	makeConfigTask,
	Tags,
	TaskError,
} from "./lib.js"
import { type } from "arktype"
import { ActorSubclass } from "../types/actor.js"

/**
 * Configuration for a remote canister (existing on network).
 */
export type RemoteCanisterConfig = {
	/**
	 * The canister ID of the remote canister.
	 */
	readonly canisterId: string
	/**
	 * Path to the Candid interface file (.did).
	 */
	readonly candid: string
}

export type RemoteCanisterScope<
	_SERVICE = unknown,
	D extends Record<string, Task> = Record<string, Task>,
	P extends Record<string, Task> = Record<string, Task>,
> = {
	_tag: "scope"
	id: symbol
	tags: Array<string | symbol>
	description: string
	defaultTask: "deploy"
	children: {
		config: ConfigTask<RemoteCanisterConfig>
		bindings: BindingsTask
		deploy: RemoteDeployTask<_SERVICE>
		status: StatusTask
	}
}

export const remoteDeployParams = {
	mode: {
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
}

export type RemoteDeployTask<_SERVICE = unknown> = Omit<
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
	params: typeof remoteDeployParams
}

export type RemoteDeployTaskArgs = ResolvedParamsToArgs<
	typeof remoteDeployParams
>

export const makeRemoteDeployTask = <_SERVICE = unknown>(
): RemoteDeployTask<_SERVICE> => {
	const builderRuntime = defaultBuilderRuntime
	return {
		_tag: "task",
		id: Symbol("canister/deploy"),
		dependsOn: {},
		dependencies: {},
		namedParams: remoteDeployParams,
		params: remoteDeployParams,
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
					)) as RemoteCanisterScope<_SERVICE>
					const { runTask } = taskCtx

					// Get the canister config
					const canisterConfig = yield* Effect.tryPromise({
						try: () => runTask(parentScope.children.config, {}),
						catch: (error) => {
							return new TaskError({
								message: String(error),
							})
						},
					})

					const canisterId = canisterConfig.canisterId
					const candidPath = canisterConfig.candid

					yield* Effect.logDebug("Running bindings task")
					// Generate bindings
					const { didJSPath, didTSPath } = yield* Effect.tryPromise({
						try: () =>
							runTask(parentScope.children.bindings, {
								candid: candidPath,
							}),
						catch: (error) => {
							return new TaskError({
								message: String(error),
							})
						},
					})

					yield* Effect.logDebug(
						"Remote canister ready",
						canisterName,
					)

					// Create actor for remote canister
					const { replica } = taskCtx
					const identity = taskCtx.roles.deployer.identity
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
						"Creating actor for remote canister",
						{
							canisterId,
							canisterDID,
							identity,
						},
					)
					const actor = yield* Effect.tryPromise({
						try: () =>
							replica.createActor<_SERVICE>({
								canisterId,
								canisterDID,
								identity,
							}),
						catch: (e) =>
							new TaskError({
								message: `Failed to create actor: ${e}`,
							}),
					})

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

					yield* Effect.logDebug(
						"Remote canister deployed successfully",
						{
							canisterId,
							canisterName,
							actor,
							mode: "install" as InstallModes,
						},
					)

					return {
						canisterId,
						canisterName,
						actor,
						// TODO: how to handle?
						mode: "install" as InstallModes,
					}
				})().pipe(
					Effect.provide(makeLoggerLayer(taskCtx.logLevel)),
					Effect.annotateLogs("path", taskCtx.taskPath + ".effect"),
				),
			),
		description: "Connect to remote canister",
		tags: [Tags.CANISTER, Tags.DEPLOY, Tags.REMOTE],
	}
}

const remoteBindingsParams = {
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

export type RemoteBindingsTaskArgs = ResolvedParamsToArgs<
	typeof remoteBindingsParams
>

export const makeRemoteBindingsTask = (): BindingsTask => {
	const builderRuntime = defaultBuilderRuntime
	return {
		_tag: "task",
		id: Symbol("remoteCanister/bindings"),
		dependsOn: {},
		dependencies: {},
		namedParams: remoteBindingsParams,
		positionalParams: [],
		params: remoteBindingsParams,
		effect: (taskCtx) =>
			builderRuntime.runPromise(
				Effect.fn("task_effect")(function* () {
					const path = yield* Path.Path
					const { taskPath, iceDir } = taskCtx
					const { candid } = taskCtx.args as RemoteBindingsTaskArgs
					const depResults = taskCtx.depResults
					const canisterConfig = depResults["config"]
						?.result as RemoteCanisterConfig
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
		description: "Generate bindings for remote canister",
		tags: [Tags.CANISTER, Tags.REMOTE, Tags.BINDINGS],
	}
}

type ResolveService<T> =
	UnwrapConfig<T> extends { candid: infer S }
		? S extends keyof IceCanisterPaths
			? IceCanisterPaths[S]
			: unknown
		: unknown

/**
 * A builder for configuring Remote canisters (existing on mainnet/testnet).
 */
export class RemoteCanisterBuilder<
	const Config extends RemoteCanisterConfig = RemoteCanisterConfig,
	_SERVICE = ResolveService<Config>,
	TCtx extends TaskCtx = TaskCtx,
> {
	#scope: RemoteCanisterScope<_SERVICE>

	constructor(scope: RemoteCanisterScope<_SERVICE>) {
		this.#scope = scope
	}
	as<T>(): RemoteCanisterBuilder<Config, T, TCtx> {
		return this as unknown as RemoteCanisterBuilder<Config, T, TCtx>
	}

	/**
	 * Finalizes the canister definition.
	 *
	 * @returns A `RemoteCanisterScope` containing deployment/interaction tasks.
	 */
	make(): RemoteCanisterScope<_SERVICE> {
		const linkedChildren = linkChildren(this.#scope.children)

		const finalScope = {
			...this.#scope,
			id: Symbol("scope"),
			children: linkedChildren,
		} satisfies RemoteCanisterScope<_SERVICE>
		return finalScope
	}
}

/**
 * Creates a Remote canister builder (references an existing canister).
 *
 * @param canisterConfigOrFn - Configuration object or a function returning one.
 * @returns A {@link RemoteCanisterBuilder}.
 *
 * @example
 * ```typescript
 * import { canister } from "@ice.ts/runner"
 *
 * export const nns_governance = canister.remote({
 *   canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
 *   candid: "canisters/nns_governance.did"
 * }).make()
 * ```
 */
export const remoteCanister = <
	const Config extends RemoteCanisterConfig,
	TCtx extends TaskCtx = TaskCtx,
	_SERVICE = ResolveService<Config>,
>(
	canisterConfigOrFn:
		| Config
		| ((args: { ctx: TCtx }) => Config | Promise<Config>),
) => {
	const config = makeConfigTask(canisterConfigOrFn as any)

	const initialScope = {
		_tag: "scope",
		id: Symbol("scope"),
		tags: [Tags.CANISTER, Tags.REMOTE],
		description: "Remote canister scope",
		defaultTask: "deploy",
		children: {
			config,
			bindings: makeRemoteBindingsTask(),
			deploy: makeRemoteDeployTask(),
			status: makeCanisterStatusTask([Tags.REMOTE]),
		},
	} satisfies RemoteCanisterScope<_SERVICE>

	return new RemoteCanisterBuilder<Config, _SERVICE, TCtx>(initialScope)
}
