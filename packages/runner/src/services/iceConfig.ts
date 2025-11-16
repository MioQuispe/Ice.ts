import { Data, Effect, Context, Layer, Ref } from "effect"
import type {
	BuilderResult,
	ICEConfig,
	ICEConfigFile,
	ICEGlobalArgs,
	Scope,
	TaskTree,
	TaskTreeNode,
} from "../types/types.js"
import { Path, FileSystem } from "@effect/platform"
import { tsImport } from "tsx/esm/api"
import { InstallModes, ReplicaStartError } from "./replica.js"
import { LogLevel } from "effect/LogLevel"
import { IceDir } from "./iceDir.js"
import { TaskCtx } from "./taskRuntime.js"

export const removeBuilders = (
	taskTree: TaskTree | TaskTreeNode | BuilderResult,
): TaskTree | TaskTreeNode => {
	if ("_tag" in taskTree && taskTree._tag === "builder") {
		return removeBuilders(taskTree.make())
	}
	if ("_tag" in taskTree && taskTree._tag === "scope") {
		return {
			...taskTree,
			children: Object.fromEntries(
				Object.entries(taskTree.children).map(([key, value]) => [
					key,
					removeBuilders(value),
				]),
			) as Record<string, TaskTreeNode>,
		} as Scope
	}
	if ("_tag" in taskTree && taskTree._tag === "task") {
		return taskTree
	}
	return Object.fromEntries(
		Object.entries(taskTree).map(([key, value]) => [
			key,
			removeBuilders(value),
		]),
	) as TaskTree
}

// export const evalScopes = (
// 	taskTree: TaskTreeEval | TaskTreeNodeEval,
// ): TaskTree | TaskTreeNode => {
// 	if ("_tag" in taskTree && taskTree._tag === "scope") {
// 		// children: Object.fromEntries(
// 		// 	Object.entries(taskTree.children).map(([key, value]) => [
// 		// 		key,
// 		// 		evalScopes(value),
// 		// 	]),
// 		// ) as Record<string, TaskTreeNode>,

// 		// TODO: ?? get ctx from somewhere
// 		const ctx = {} as TaskCtx
// 		const children =
// 			typeof taskTree.children === "function"
// 				? taskTree.children(ctx)
// 				: taskTree.children
// 		return {
// 			...taskTree,
// 			children: Object.fromEntries(
// 				Object.entries(children).map(([key, value]) => [
// 					key,
// 					evalScopes(value),
// 				]),
// 			) as Record<string, TaskTreeNode>,
// 		}
// 	}
// 	if ("_tag" in taskTree && taskTree._tag === "task") {
// 		return taskTree
// 	}
// 	return Object.fromEntries(
// 		Object.entries(taskTree).map(([key, value]) => [
// 			key,
// 			evalScopes(value),
// 		]),
// 	) as TaskTree
// }

const applyPlugins = (taskTree: TaskTree) =>
	Effect.gen(function* () {
		yield* Effect.logDebug("Applying plugins...")
		const transformedTaskTree = removeBuilders(taskTree) as TaskTree
		// TODO: deploy should be included directly in the builders
		// candid_ui as well
		// const transformedTaskTree = deployTaskPlugin(noBuildersTree)
		// const transformedConfig2 = yield* candidUITaskPlugin(transformedConfig)
		return transformedTaskTree
	})

export class ICEConfigError extends Data.TaggedError("ICEConfigError")<{
	message: string
}> {}

const createService = (globalArgs: {
	network: string
	policy: "reuse" | "restart"
	logLevel: "debug" | "info" | "error"
	background: boolean
	origin: "extension" | "cli"
}) =>
	Effect.gen(function* () {
		// TODO: service?
		const path = yield* Path.Path
		const fs = yield* FileSystem.FileSystem
		const appDirectory = yield* fs.realPath(process.cwd())
		// TODO: make this configurable if needed
		const configPath = "ice.config.ts"
		yield* Effect.logDebug("Loading config...", {
			configPath,
			appDirectory,
		})
		const { path: iceDirPath } = yield* IceDir

		// Wrap tsImport in a console.log monkey patch.
		const mod = yield* Effect.tryPromise({
			try: () =>
				tsImport(
					path.resolve(appDirectory, configPath),
					import.meta.url,
				) as Promise<ICEConfigFile>,
			catch: (error) =>
				new ICEConfigError({
					message: `Failed to get ICE config: ${
						error instanceof Error ? error.message : String(error)
					}`,
				}),
		})

		const iceGlobalArgs: ICEGlobalArgs = {
			network: globalArgs.network,
			iceDirPath,
			background: globalArgs.background,
			policy: globalArgs.policy,
			logLevel: globalArgs.logLevel,
		}

		const d = mod.default
		if (typeof d !== "function") {
			return yield* Effect.fail(
				new ICEConfigError({
					message:
						"Config file must export a default function (use Ice().tasks().make())",
				}),
			)
		}

		const environment = yield* Effect.tryPromise({
			try: () => {
				const result = d(iceGlobalArgs)
				if (result instanceof Promise) {
					return result
				}
				return Promise.resolve(result)
			},
			catch: (error) => {
				return new ICEConfigError({
					message: `Failed to load ICE environment: ${
						error instanceof Error ? error.message : String(error)
					}`,
				})
			},
		})

		const transformedTasks = yield* applyPlugins(environment.tasks)
		return {
			tasks: transformedTasks,
			config: environment.config,
			globalArgs,
		}
	})

/**
 * Service to load and process the ICE configuration.
 */
export class ICEConfigService extends Context.Tag("ICEConfigService")<
	ICEConfigService,
	{
		readonly config: Partial<ICEConfig>
		readonly tasks: TaskTree
		readonly globalArgs: {
			network: string
			logLevel: "debug" | "info" | "error"
			background: boolean
			policy: "reuse" | "restart"
			origin: "extension" | "cli"
		}
	}
>() {
	static readonly Live = (globalArgs: {
		network: string
		logLevel: "debug" | "info" | "error"
		background: boolean
		policy: "reuse" | "restart"
		origin: "extension" | "cli"
	}) => Layer.effect(ICEConfigService, createService(globalArgs))

	static readonly Test = (
		globalArgs: {
			network: string
			logLevel: "debug" | "info" | "error"
			background: boolean
			policy: "reuse" | "restart"
			origin: "extension" | "cli"
		},
		tasks: TaskTree,
		config: Partial<ICEConfig>,
	) =>
		Layer.effect(
			ICEConfigService,
			Effect.gen(function* () {
				return {
					tasks,
					config,
					globalArgs,
				}
			}),
		)
}
