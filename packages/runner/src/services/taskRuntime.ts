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
import type {
	ICENetworks,
	ICERoles,
	ICEUser,
	ICEUsers,
	Task,
} from "../types/types.js"
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
	Replica,
	ReplicaError,
	ReplicaServiceClass,
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

// export type DefaultICEConfig = {
// 	readonly users: {
// 		[name: string]: ICEUser
// 	}
// 	readonly roles: {
// 		deployer: string
// 		minter: string
// 		controller: string
// 		treasury: string
// 		[name: string]: string
// 	}
// 	networks: {
// 		[key: string]: {
// 			replica: ReplicaServiceClass
// 		}
// 	}
// }

export type DefaultICEConfig = ICEConfig<
	{
		[key: string]: ICEUser
	},
	{
		// [key: string]: {
		// }
		deployer: string
		minter: string
		controller: string
		treasury: string
		[name: string]: string
	},
	{
		[key: string]: {
			replica: ReplicaServiceClass
		}
	}
>

export type DefaultRoles = "deployer" | "minter" | "controller" | "treasury"

export type InitializedICEConfig<I extends Partial<ICEConfig>> = {
	users: I["users"]
	roles: {
		[key in keyof I["roles"]]: ICEUser
	}
	networks: {
		[key: string]: {
			replica: ReplicaServiceClass
		}
	}
}

export type TaskCtxBase<
	A extends Record<string, unknown>,
	I extends Partial<ICEConfig>,
> = InitializedICEConfig<I> & {
	readonly taskTree: TaskTree
	readonly runTask: {
		<T extends Task>(task: T): Promise<TaskSuccess<T>>
		<T extends Task>(
			task: T,
			args: TaskParamsToArgs<T>,
		): Promise<TaskSuccess<T>>
	}

	readonly network: string
	readonly replica: ReplicaServiceClass

	readonly args: A
	readonly taskPath: string
	readonly appDir: string
	readonly iceDir: string
	readonly logLevel: "debug" | "info" | "error"
	readonly depResults: Record<
		string,
		{
			cacheKey?: string
			result: unknown
		}
	>
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
	readonly prompts: {
		confirm: (confirmOptions: ConfirmOptions) => Promise<boolean>
	}
	readonly origin: "extension" | "cli"
}

type ResolvedConfig = 
    TaskCtxExtension & 
    Omit<DefaultICEConfig, keyof TaskCtxExtension>;

export interface TaskCtxExtension {}

// = TaskCtxBase<A, I>
// export type TaskCtx<
// 	A extends Record<string, unknown> = {},
// 	I extends Partial<ICEConfig> = DefaultICEConfig,
// > = TaskCtxExtension extends Partial<{
// 	users: infer U extends ICEUsers
// 	roles: infer R extends ICERoles
// 	networks: infer N extends ICENetworks
// }>
// 	? TaskCtxBase<A, { users: U; roles: R; networks: N }>
// 	: TaskCtxBase<A, DefaultICEConfig>

// type test = TaskCtx<
// 	{},
// 	{
// 		// users: { 
//         //     seppo: ICEUser 
//         //     jussi: ICEUser
//         // }
// 		// roles: { [key: string]: string }
// 		// networks: { [key: string]: { replica: ReplicaServiceClass } }
// 	}
// >

// interface TaskExtension {
//     users: { 
//         seppo: ICEUser 
//         jussi: ICEUser
//     }
//     // roles: { [key: string]: string }
//     // networks: { [key: string]: { replica: ReplicaServiceClass } }
// }

// type test = TaskCtx

export type TaskCtx<
	A extends Record<string, unknown> = {},
	I extends Partial<ICEConfig> = ResolvedConfig,
> = TaskCtxBase<A, I>

export type BaseTaskCtx = Omit<TaskCtx, "taskPath" | "depResults" | "args">

// export type TaskCtx<
// 	A extends Record<string, unknown> = {},
// 	I extends Partial<ICEConfig> = DefaultICEConfig,
// > = TaskCtxExtension extends {
// 	users: infer U extends ICEUsers
// 	roles: infer R extends ICERoles
// 	networks: infer N extends ICENetworks
// }
// 	? TaskCtxBase<A, ICEConfig<U, R, N>>
// 	: TaskCtxBase<A, I>

// 3. The "Runtime" Context (Used in external tasks and .extendEnv)
// This looks at the global declaration to infer types.

// export type TaskCtx<
// 	A extends Record<string, unknown> = {},
// 	I extends Partial<ICEConfig> = DefaultICEConfig,
// > = TaskCtxExtension extends {
// 	users: infer U extends ICEUsers
// 	roles: infer R extends ICERoles
// 	networks: infer N extends ICENetworks
// }
// 	? TaskCtxBase<A, ICEConfig<U, R, N>>
// 	: TaskCtxBase<A, I>

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
		replica: ReplicaServiceClass
		runtime: ManagedRuntime.ManagedRuntime<
			| OtelTracer
			| Resource
			| NodeContext.NodeContext
			| TaskRegistry
			| KeyValueStore.KeyValueStore
			| Replica
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
			| Replica
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

				const startICEConfig = performance.now()
				const {
					config,
					globalArgs,
					tasks: taskTree,
				} = yield* ICEConfigService

				const currentNetwork = globalArgs.network ?? "local"
				const currentNetworkConfig =
					config?.networks?.[currentNetwork] ??
					defaultConfig.networks[currentNetwork]
				const currentReplica = currentNetworkConfig?.replica
				if (!currentReplica) {
					return yield* Effect.fail(
						new TaskRuntimeError({
							message: `No replica found for network: ${currentNetwork}`,
						}),
					)
				}
				const currentUsers = config?.users ?? {}
				const networks = config?.networks ?? defaultConfig.networks
				// TODO: merge with defaultConfig.roles
				const initializedRoles: Record<string, ICEUser> = {}
				for (const [name, user] of Object.entries(
					config?.roles ?? {},
				)) {
					if (!currentUsers[user]) {
						return yield* Effect.fail(
							new TaskRuntimeError({
								message: `User ${user} not found in current users`,
							}),
						)
					}
					initializedRoles[name] = currentUsers[user]
				}
				const runtimeScope = yield* Scope.make()
				const resolvedRoles: {
					[key: string]: ICEUser
				} & InitializedDefaultConfig["roles"] = {
					...defaultConfig.roles,
					...initializedRoles,
				}
				const iceConfigService = yield* ICEConfigService
				const configReplica =
					config?.networks?.[currentNetwork]?.replica
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

				const defaultReplica = yield* Replica
				const replica = configReplica ?? defaultReplica

				const ReplicaService = Layer.succeed(Replica, replica)
                const DefaultConfigService = Layer.succeed(DefaultConfig, defaultConfig)

				const taskLayer = Layer.mergeAll(
					telemetryLayer,
					NodeContext.layer,
					TaskRegistryLayer,
					ReplicaService,
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
					...defaultConfig,
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
					network: currentNetwork,
					networks,
					users: {
						...defaultConfig.users,
						...currentUsers,
					},
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
				// const startTimeMs = performance.now()
				// console.log(`Warming up task runtime... at ${startTimeMs}ms`)
				const startWarmup = performance.now()
				yield* Effect.tryPromise({
					try: () => taskRuntime.runPromise(warmup),
					catch: (error) =>
						new TaskRuntimeError({ message: String(error) }),
				})
				yield* Effect.logDebug(
					`[TIMING] TaskRuntime warmup finished in ${performance.now() - startWarmup}ms`,
				)
				// console.log(`Warming up task runtime completed at ${performance.now() - startTimeMs}ms`)

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
