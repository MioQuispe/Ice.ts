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
	baseLayer,
	type BuilderLayer,
	ConfigTask,
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

export type RemoteCanisterConfig = {
	canisterId: string
	candid: string
}

export type RemoteCanisterScope<
	_SERVICE = any,
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
		parse: (value: string) => value as InstallModes,
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

export const makeRemoteDeployTask = <_SERVICE>(
	builderLayer: BuilderLayer,
	canisterConfigOrFn:
		| ((args: { ctx: TaskCtx }) => Promise<RemoteCanisterConfig>)
		| ((args: { ctx: TaskCtx }) => RemoteCanisterConfig)
		| RemoteCanisterConfig,
): RemoteDeployTask<_SERVICE> => {
	const builderRuntime = ManagedRuntime.make(builderLayer)
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
					yield* Effect.tryPromise({
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
					const path = yield* Path.Path
					const canisterDID = path.resolve(taskCtx.appDir, candidPath)
					
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

					return {
						canisterId,
						canisterName,
						actor,
						mode: "install" as InstallModes,
					}
				})(),
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
		parse: (value: string) => value,
		isOptional: false as const,
		isVariadic: false as const,
	},
}

export type RemoteBindingsTaskArgs = ResolvedParamsToArgs<
	typeof remoteBindingsParams
>

export const makeRemoteBindingsTask = (
	builderLayer: BuilderLayer,
): BindingsTask => {
	const builderRuntime = ManagedRuntime.make(builderLayer)
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
		description: "Generate bindings for remote canister",
		tags: [Tags.CANISTER, Tags.REMOTE, Tags.BINDINGS],
	}
}

export class RemoteCanisterBuilder<
	_SERVICE = unknown,
	Config extends RemoteCanisterConfig = RemoteCanisterConfig,
	TCtx extends TaskCtx<any, any> = TaskCtx,
> {
	#scope: RemoteCanisterScope<_SERVICE>
	#builderLayer: BuilderLayer

	constructor(
		builderLayer: BuilderLayer,
		scope: RemoteCanisterScope<_SERVICE>,
	) {
		this.#builderLayer = builderLayer
		this.#scope = scope
	}

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

export const makeRemoteCanister = <
	_SERVICE = unknown,
	TCtx extends TaskCtx<any, any> = TaskCtx,
>(
	builderLayer: BuilderLayer,
	canisterConfigOrFn:
		| RemoteCanisterConfig
		| ((args: { ctx: TCtx }) => RemoteCanisterConfig)
		| ((args: { ctx: TCtx }) => Promise<RemoteCanisterConfig>),
) => {
	const config = makeConfigTask(builderLayer, canisterConfigOrFn as any)

	const initialScope = {
		_tag: "scope",
		id: Symbol("scope"),
		tags: [Tags.CANISTER, Tags.REMOTE],
		description: "Remote canister scope",
		defaultTask: "deploy",
		children: {
			config,
			bindings: makeRemoteBindingsTask(builderLayer),
			deploy: makeRemoteDeployTask<_SERVICE>(
				builderLayer,
				canisterConfigOrFn as any,
			),
			status: makeCanisterStatusTask(builderLayer, [Tags.REMOTE]),
		},
	} satisfies RemoteCanisterScope<_SERVICE>

	return new RemoteCanisterBuilder<_SERVICE, RemoteCanisterConfig, TCtx>(
		builderLayer,
		initialScope,
	)
}

export const remoteCanister = <_SERVICE = unknown>(
	canisterConfigOrFn:
		| RemoteCanisterConfig
		| ((args: { ctx: TaskCtx }) => RemoteCanisterConfig)
		| ((args: { ctx: TaskCtx }) => Promise<RemoteCanisterConfig>),
) => {
	return makeRemoteCanister<_SERVICE>(
		baseLayer as BuilderLayer,
		canisterConfigOrFn,
	)
}
