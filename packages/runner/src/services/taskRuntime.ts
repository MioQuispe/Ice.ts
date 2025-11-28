import {
	Context,
	Effect,
	Layer,
	Queue,
	Deferred,
	Fiber,
	Data,
	ManagedRuntime,
	LogLevel,
	ConfigProvider,
	Config,
	Option,
	Scope,
} from "effect"
import type { ICEUser, Task } from "../types/types.js"
import { TaskParamsToArgs, TaskSuccess } from "../tasks/lib.js"
// import { executeTasks } from "../tasks/execute"
import { ProgressUpdate } from "../tasks/lib.js"
import { StandardSchemaV1 } from "@standard-schema/spec"
import { ICEConfigService } from "./iceConfig.js"
import { NodeContext } from "@effect/platform-node"
import { type } from "arktype"
import { Logger, Tracer } from "effect"
import fs, { realpathSync } from "node:fs"
import { NodeSdk as OpenTelemetryNodeSdk } from "@effect/opentelemetry"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import type { TaskTree } from "../types/types.js"
import { TaskRegistry } from "./taskRegistry.js"
export { Opt } from "../types/types.js"
import { layerFileSystem, layerMemory } from "@effect/platform/KeyValueStore"
import { CanisterIds, CanisterIdsService } from "./canisterIds.js"
import { DefaultConfig, InitializedDefaultConfig } from "./defaultConfig.js"
import { Moc, MocError } from "./moc.js"
import {
	AgentError,
	ReplicaService,
	ReplicaError,
	Replica,
	ReplicaStartError,
} from "./replica.js"
import type { ICEGlobalArgs } from "../types/types.js"
import { TaskRuntimeError } from "../tasks/lib.js"
import { TelemetryConfig } from "./telemetryConfig.js"
import { makeTelemetryLayer } from "./telemetryConfig.js"
import { KeyValueStore } from "@effect/platform"
import { IceDir } from "./iceDir.js"
import { InFlight } from "./inFlight.js"
import { runTask, runTasks } from "../tasks/run.js"
import { OtelTracer } from "@effect/opentelemetry/Tracer"
import { Resource } from "@effect/opentelemetry/Resource"
import { PlatformError } from "@effect/platform/Error"
import { Deployment, DeploymentsService } from "./deployments.js"
// import { DfxReplica } from "./dfx.js"
import { ClackLoggingLive } from "./logger.js"
import { PromptsService } from "./prompts.js"
import { ConfirmOptions } from "@clack/prompts"
import { ICEConfig } from "../types/types.js"

export type DefaultICEConfig = {
	network: string
	users: {
		[key: string]: ICEUser
	}
	roles: {
		deployer: string
		minter: string
		controller: string
		treasury: string
		[name: string]: string
	}
	replica: Replica
}

export type DefaultRoles = "deployer" | "minter" | "controller" | "treasury"

export type InitializedICEConfig<I extends ICEConfig> = {
	users: I["users"]
	roles: {
		[key in keyof I["roles"]]: ICEUser
	}
}

/**
 * Base execution context passed to tasks.
 */
export type TaskCtxBase<
	A extends Record<string, unknown>,
	I extends ICEConfig,
> = InitializedICEConfig<I> & {
	/**
	 * The full tree of tasks defined in the config.
	 */
	readonly taskTree: TaskTree
	/**
	 * Helper to run another task from within a task.
	 * Automatically handles dependencies and caching.
	 */
	readonly runTask: {
		<T extends Task>(task: T): Promise<TaskSuccess<T>>
		<T extends Task>(
			task: T,
			args: TaskParamsToArgs<T>,
		): Promise<TaskSuccess<T>>
	}

	readonly network: string
	readonly replica: Replica

	/**
	 * The parsed arguments for the current task.
	 */
	readonly args: A
	/**
	 * The logical path of the current task (e.g. "backend:deploy").
	 */
	readonly taskPath: string
	/**
	 * Absolute path to the application root (where ice.config.ts lives).
	 */
	readonly appDir: string
	/**
	 * Absolute path to the .ice directory.
	 */
	readonly iceDir: string
	readonly logLevel: "debug" | "info" | "error"
	/**
	 * Results of dependency tasks that have already run.
	 */
	readonly depResults: Record<
		string,
		{
			cacheKey?: string
			result: unknown
		}
	>
	/**
	 * API to manage deployment metadata.
	 */
	readonly deployments: {
		// readonly canisterIds: CanisterIds
		/**
		 * Retrieves the current in-memory canister IDs.
		 */
		get: (
			canisterName: string,
			network: string,
		) => Promise<Deployment | undefined>
		/**
		 * Updates the canister ID for a specific canister and network.
		 */
		set: (params: {
			canisterName: string
			network: string
			deployment: Omit<Deployment, "id">
		}) => Promise<void>
	}
	/**
	 * API to manage canister IDs (canister_ids.json).
	 */
	readonly canisterIds: {
		// readonly canisterIds: CanisterIds
		/**
		 * Retrieves the current in-memory canister IDs.
		 */
		getCanisterIds: () => Promise<CanisterIds>
		/**
		 * Updates the canister ID for a specific canister and network.
		 */
		setCanisterId: (params: {
			canisterName: string
			network: string
			canisterId: string
		}) => Promise<void>
		/**
		 * Removes the canister ID for the given canister name.
		 */
		removeCanisterId: (canisterName: string) => Promise<void>
	}
	/**
	 * Interactive prompts.
	 */
	readonly prompts: {
		confirm: (confirmOptions: ConfirmOptions) => Promise<boolean>
	}
	readonly origin: "extension" | "cli"
}

type ResolvedConfig = TaskCtxExtension &
	Omit<DefaultICEConfig, keyof TaskCtxExtension>

/**
 * Interface for module augmentation to extend TaskCtx with user-specific types.
 *
 * @example
 * ```typescript
 * declare module "@ice.ts/runner" {
 *   interface TaskCtxExtension extends InferIceConfig<typeof ice> {}
 * }
 * ```
 */
export interface TaskCtxExtension {}

/**
 * The full execution context available to tasks and canister hooks.
 */
export type TaskCtx<
	A extends Record<string, unknown> = {},
	I extends ICEConfig = ResolvedConfig,
> = TaskCtxBase<A, I>

export type BaseTaskCtx = Omit<TaskCtx, "taskPath" | "depResults" | "args">

export const logLevelMap = {
	debug: LogLevel.Debug,
	info: LogLevel.Info,
	error: LogLevel.Error,
}

export const makeLoggerLayer = (logLevel: "debug" | "info" | "error") =>
	Logger.minimumLogLevel(logLevelMap[logLevel])

export class TaskRuntime extends Context.Tag("TaskRuntime")<
	TaskRuntime,
	{
		replica: Replica
		runtime: ManagedRuntime.ManagedRuntime<
			| OtelTracer
			| Resource
			| NodeContext.NodeContext
			| TaskRegistry
			| KeyValueStore.KeyValueStore
			| ReplicaService
			| DefaultConfig
			| Moc
			| CanisterIdsService
			| DeploymentsService
			| ICEConfigService
			| TelemetryConfig
			| InFlight
			| IceDir
			| PromptsService,
			| PlatformError
			| ReplicaError
			| AgentError
			| TaskRuntimeError
			| MocError
		>
		taskLayer: Layer.Layer<
			| OtelTracer
			| Resource
			| NodeContext.NodeContext
			| TaskRegistry
			| KeyValueStore.KeyValueStore
			| ReplicaService
			| DefaultConfig
			| Moc
			| CanisterIdsService
			| DeploymentsService
			| ICEConfigService
			| TelemetryConfig
			| PromptsService
			| InFlight
			| IceDir,
			| PlatformError
			| ReplicaError
			| AgentError
			| TaskRuntimeError
			| MocError
		>
		taskCtx: BaseTaskCtx
	}
>() {
	static Live = (progressCb: (update: ProgressUpdate<unknown>) => void) =>
		Layer.effect(
			TaskRuntime,
			Effect.gen(function* () {
				const startTaskRuntime = performance.now()
				const parentSpan = yield* Effect.currentSpan

				const startDefaultConfig = performance.now()
				const defaultConfig = yield* DefaultConfig

				const appDir = yield* Effect.try({
					try: () => realpathSync(process.cwd()),
					catch: (e) => new TaskRuntimeError({ message: String(e) }),
				})
				const { path: iceDirPath } = yield* IceDir

				const {
					config,
					globalArgs,
					tasks: taskTree,
				} = yield* ICEConfigService

				const replica = config?.replica ?? defaultConfig.replica
				if (!replica) {
					return yield* Effect.fail(
						new TaskRuntimeError({
							message: `No replica found`,
						}),
					)
				}
				const currentUsers = config?.users ?? defaultConfig.users
				const currentRoles = config?.roles ?? defaultConfig.roles
				let resolvedRoles = {} as {
					deployer: ICEUser
					minter: ICEUser
					controller: ICEUser
					treasury: ICEUser
					[key: string]: ICEUser
				}
				for (const [name, user] of Object.entries(currentRoles)) {
					if (!(user in currentUsers)) {
						return yield* Effect.fail(
							new TaskRuntimeError({
								message: `User ${user} not found in current users: ${currentUsers}`,
							}),
						)
					}
					resolvedRoles[name] =
						currentUsers[user as keyof typeof currentUsers]
				}
				const runtimeScope = yield* Scope.make()

				const resolvedUsers = {
					...defaultConfig.users,
					...currentUsers,
				}
				const iceConfigService = yield* ICEConfigService
				const ICEConfigLayer = Layer.succeed(
					ICEConfigService,
					iceConfigService,
				)
				const iceDir = yield* IceDir
				const IceDirLayer = Layer.succeed(IceDir, iceDir)
				const telemetryConfig = yield* TelemetryConfig
				const telemetryLayer = makeTelemetryLayer(telemetryConfig)
				const telemetryConfigLayer = Layer.succeed(
					TelemetryConfig,
					telemetryConfig,
				)
				const KV = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KV,
				)
				const InFlightService = yield* InFlight
				const InFlightLayer = Layer.succeed(InFlight, InFlightService)

				const CanisterIds = yield* CanisterIdsService
				const CanisterIdsLayer = Layer.succeed(
					CanisterIdsService,
					CanisterIds,
				)

				const Deployments = yield* DeploymentsService
				const DeploymentsLayer = Layer.succeed(
					DeploymentsService,
					Deployments,
				)
				const Prompts = yield* PromptsService
				const PromptsLayer = Layer.succeed(PromptsService, Prompts)

				const TaskRegistryService = yield* TaskRegistry
				const TaskRegistryLayer = Layer.succeed(
					TaskRegistry,
					TaskRegistryService,
				)
				const ctx = {
					...globalArgs,
					iceDirPath: iceDirPath,
				}

				const ReplicaLayer = Layer.succeed(ReplicaService, replica)
				const DefaultConfigService = Layer.succeed(
					DefaultConfig,
					defaultConfig,
				)

				const taskLayer = Layer.mergeAll(
					telemetryLayer,
					NodeContext.layer,
					TaskRegistryLayer,
					ReplicaLayer,
					DefaultConfigService,
					// DefaultConfig is already provided from parent layer, no need to recreate it
					Moc.Live.pipe(Layer.provide(NodeContext.layer)),
					CanisterIdsLayer,
					// DevTools.layerWebSocket().pipe(
					// 	Layer.provide(NodeSocket.layerWebSocketConstructor),
					// ),
					ICEConfigLayer,
					telemetryConfigLayer,
					ClackLoggingLive,
					Logger.minimumLogLevel(
						logLevelMap[iceConfigService.globalArgs.logLevel],
					),
					InFlightLayer,
					IceDirLayer,
					KVStorageLayer,
					NodeContext.layer,
					DeploymentsLayer,
					PromptsLayer,
				)
				const taskRuntime = ManagedRuntime.make(taskLayer)

				const taskCtx = {
					// ...defaultConfig,
					// TODO: add caching options?
					// TODO: wrap with proxy?
					runTask: async <T extends Task>(
						task: T,
						args?: TaskParamsToArgs<T>,
					): Promise<TaskSuccess<T>> => {
						const wrapperStartTime = performance.now()
						const result = await taskRuntime.runPromise(
							runTask(task, args, progressCb).pipe(
								Effect.provide(ChildTaskRuntimeLayer),
								Effect.withParentSpan(parentSpan),
								// Effect.withConcurrency("unbounded"),
								// Effect.scopeWith(runtimeScope),
								// Effect.scoped,
								Scope.extend(runtimeScope),
							),
						)
						return result
					},
					replica,
					taskTree,
					network: config?.network ?? defaultConfig.network,
					users: resolvedUsers,
					roles: resolvedRoles,
					appDir,
					iceDir: iceDirPath,
					logLevel: globalArgs.logLevel,
					deployments: {
						get: async (canisterName, network) => {
							const result = await taskRuntime.runPromise(
								Deployments.get(canisterName, network),
							)
							return Option.isSome(result)
								? result.value
								: undefined
						},
						set: async (params) => {
							await taskRuntime.runPromise(
								Deployments.set(params),
							)
						},
					},
					canisterIds: {
						getCanisterIds: async () => {
							const result = await taskRuntime.runPromise(
								CanisterIds.getCanisterIds(),
							)
							return result
						},
						setCanisterId: async (params) => {
							await taskRuntime.runPromise(
								CanisterIds.setCanisterId(params),
							)
						},
						removeCanisterId: async (canisterName) => {
							await taskRuntime.runPromise(
								CanisterIds.removeCanisterId(canisterName),
							)
						},
					},
					prompts: {
						confirm: async (confirmOptions) => {
							const result = await taskRuntime.runPromise(
								Prompts.confirm(confirmOptions),
							)
							return result
						},
					},
					origin: globalArgs.origin ?? "cli",
				} satisfies BaseTaskCtx

				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
					replica,
					taskCtx,
				})
				const warmup = Effect.gen(function* () {
					yield* Effect.succeed(true)
				}).pipe(Effect.provide(ChildTaskRuntimeLayer), Effect.scoped)
				const startWarmup = performance.now()
				yield* Effect.tryPromise({
					try: () => taskRuntime.runPromise(warmup),
					catch: (error) =>
						new TaskRuntimeError({ message: String(error) }),
				})
				yield* Effect.logDebug(
					`[TIMING] TaskRuntime warmup finished in ${performance.now() - startWarmup}ms`,
				)

				yield* Effect.logDebug(
					`[TIMING] TaskRuntime.Live finished in ${performance.now() - startTaskRuntime}ms`,
				)

				return {
					taskCtx,
					runtime: taskRuntime,
					taskLayer,
					replica,
				}
			}).pipe(Effect.withSpan("TaskRuntime.Live")),
		)
}
