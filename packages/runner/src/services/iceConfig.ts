import { Data, Effect, Context, Layer, Ref } from "effect"
import type {
	BuilderResult,
	ICEConfig,
	ICEConfigFile,
	ICEEnvironment,
	ICEGlobalArgs,
	ICEPlugin,
	Scope,
	TaskTree,
	TaskTreeNode,
} from "../types/types.js"
import { Path, FileSystem } from "@effect/platform"
import { createJiti } from "jiti"
import { InstallModes, ReplicaStartError } from "./replica.js"
import { LogLevel } from "effect/LogLevel"
import { IceDir } from "./iceDir.js"
import { TaskCtx } from "./taskRuntime.js"
import { pathToFileURL } from "node:url"

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

const applyPlugins = (environment: ICEEnvironment) =>
	Effect.gen(function* () {
		yield* Effect.logDebug("Applying plugins...")
		const transformedTaskTree = removeBuilders(
			environment.tasks,
		) as TaskTree
		// TODO: deploy should be included directly in the builders
		// candid_ui as well
		// const transformedTaskTree = deployTaskPlugin(noBuildersTree)
		// const transformedConfig2 = yield* candidUITaskPlugin(transformedConfig)
		return {
			...environment,
			tasks: transformedTaskTree,
		}
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
		const startTime = performance.now()
		yield* Effect.logDebug("Loading config...", { startTime })
		const { path: iceDirPath } = yield* IceDir

		yield* Effect.logDebug(`[TIMING] ICEConfig, loading started`)
		const beforeImportConfig = performance.now()
		
		const configFullPath = path.resolve(appDirectory, configPath)
		
		const mod = yield* Effect.tryPromise({
			try: async () => {
				// Use jiti for fast TypeScript loading with built-in caching
				// jiti is used by Nuxt and has zero dependencies
				const jiti = createJiti(import.meta.url, {
					interopDefault: true,
					cache: true,
					requireCache: false,
				})
				
				const result = (await jiti.import(configFullPath)) as ICEConfigFile
				return result
			},
			catch: (error) =>
				new ICEConfigError({
					message: `Failed to get ICE config: ${
						error instanceof Error ? error.message : String(error)
					}`,
				}),
		})
		const afterImportConfig = performance.now()
		yield* Effect.logDebug(
			`[TIMING] ICEConfig, loading finished in ${afterImportConfig - beforeImportConfig}ms`,
		)

        const beforeGlobalArgs = performance.now()
		const iceGlobalArgs: ICEGlobalArgs = {
			network: globalArgs.network,
			iceDirPath,
			background: globalArgs.background,
			policy: globalArgs.policy,
			logLevel: globalArgs.logLevel,
		}

		const d = mod.default

        const beforeTryPromise = performance.now()
		const { config, plugins } = yield* Effect.tryPromise({
			try: () => {
				if (typeof d !== "function") {
					return Promise.resolve({
						config: {},
						plugins: [],
					} as {
						config: Partial<ICEConfig>
						plugins: ICEPlugin[]
					})
				}
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
        const afterTryPromise = performance.now()
        yield* Effect.logDebug(`[TIMING] ICEConfig, tryPromise finished in ${afterTryPromise - beforeTryPromise}ms`)
		const tasks = Object.fromEntries(
			Object.entries(mod).filter(([key]) => key !== "default"),
		) as TaskTree
		let environment: ICEEnvironment = {
			config,
			tasks,
			plugins,
		}

        const beforeEnvPlugins = performance.now()
        yield* Effect.logDebug(`[TIMING] ICEConfig, environment plugins started`)
		// Apply plugins if they exist
		if (environment.plugins.length > 0) {
			for (const plugin of environment.plugins) {
				const envWithGlobalArgs = {
					...environment,
					args: iceGlobalArgs,
				}
				const result = plugin(envWithGlobalArgs)
				const transformedEnv =
					result instanceof Promise
						? yield* Effect.promise(() => result)
						: result
				// Update environment, plugins field is not needed after transformation
				environment = {
					config: transformedEnv.config,
					tasks: transformedEnv.tasks,
					plugins: [],
				}
			}
		}

		const afterEnvPlugins = performance.now()
		yield* Effect.logDebug(`[TIMING] ICEConfig, environment plugins finished in ${afterEnvPlugins - beforeEnvPlugins}ms`)

		const beforeApplyPlugins = performance.now()
		const transformedEnvironment = yield* applyPlugins(environment)
		yield* Effect.logDebug(
			`Finished applying plugins. [TIMING] applyPlugins took ${performance.now() - beforeApplyPlugins}ms`,
		)
		return {
			...transformedEnvironment,
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
