import { Data, Effect, Context, Layer, Ref } from "effect"
import type {
	BuilderResult,
	ICEConfig,
	ICEConfigFile,
	ICEEnvironment,
	ICEGlobalArgs,
	Scope,
	TaskTree,
	TaskTreeNode,
} from "../types/types.js"
import { Path, FileSystem } from "@effect/platform"
import { createJiti } from "jiti"
import { IceDir } from "./iceDir.js"

export class ICEConfigError extends Data.TaggedError("ICEConfigError")<{
	message: string
}> {}

const createService = (globalArgs: {
	policy: "reuse" | "restart"
	logLevel: "debug" | "info" | "error"
	background: boolean
	origin: "extension" | "cli"
	config?: string
}) =>
	Effect.gen(function* () {
		// TODO: service?
		const path = yield* Path.Path
		const fs = yield* FileSystem.FileSystem
		const appDirectory = yield* fs.realPath(process.cwd())
		const configPath = globalArgs.config ?? "ice.config.ts"
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

				const result = (await jiti.import(
					configFullPath,
				)) as ICEConfigFile
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
			iceDirPath,
			background: globalArgs.background,
			policy: globalArgs.policy,
			logLevel: globalArgs.logLevel,
		}

		const d = mod.default

		const beforeTryPromise = performance.now()
		const config = yield* Effect.tryPromise({
			try: () => {
				if (typeof d !== "function") {
					return Promise.resolve({ network: "local" } as ICEConfig)
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
		yield* Effect.logDebug(
			`[TIMING] ICEConfig, tryPromise finished in ${afterTryPromise - beforeTryPromise}ms`,
		)
		const tasks = Object.fromEntries(
			Object.entries(mod).filter(([key]) => key !== "default"),
		) as TaskTree
		let environment: ICEEnvironment = {
			config,
			tasks,
		}

		return {
			...environment,
			globalArgs,
		}
	})

/**
 * Service to load and process the ICE configuration.
 */
export class ICEConfigService extends Context.Tag("ICEConfigService")<
	ICEConfigService,
	{
		readonly config: ICEConfig
		readonly tasks: TaskTree
		readonly globalArgs: {
			logLevel: "debug" | "info" | "error"
			background: boolean
			policy: "reuse" | "restart"
			origin: "extension" | "cli"
			config?: string
		}
	}
>() {
	static readonly Live = (globalArgs: {
		logLevel: "debug" | "info" | "error"
		background: boolean
		policy: "reuse" | "restart"
		origin: "extension" | "cli"
		config?: string
	}) => Layer.effect(ICEConfigService, createService(globalArgs))

	static readonly Test = (
		globalArgs: {
			logLevel: "debug" | "info" | "error"
			background: boolean
			policy: "reuse" | "restart"
			origin: "extension" | "cli"
			config?: string
		},
		tasks: TaskTree,
		config: ICEConfig,
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
