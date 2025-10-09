import { NodeContext } from "@effect/platform-node"
import { FileSystem } from "@effect/platform"
// import {} from "@effect/platform-browser"
import { layerMemory } from "@effect/platform/KeyValueStore"
import {
	Effect,
	Layer,
	Logger,
	LogLevel,
	ManagedRuntime,
	Ref,
	Metric,
	Tracer,
	ConfigProvider,
	Option,
	ConfigError,
} from "effect"
import { CanisterIdsService } from "../../src/services/canisterIds.js"
import { DefaultConfig } from "../../src/services/defaultConfig.js"
import { ICEConfigService } from "../../src/services/iceConfig.js"
import { Moc } from "../../src/services/moc.js"
import { PICReplica } from "../../src/services/pic/pic.js"
import {
	DefaultReplica,
	layerFromAsyncReplica,
} from "../../src/services/replica.js"
import { TaskRegistry } from "../../src/services/taskRegistry.js"
import {
	ProgressUpdate,
	TaskSuccess,
	makeTaskEffects,
	TaskParamsToArgs,
	TaskRuntimeError,
	topologicalSortTasks,
} from "../../src/tasks/lib.js"
import { CachedTask, ICEConfig, Task, TaskTree } from "../../src/types/types.js"
import { NodeSdk as OpenTelemetryNodeSdk } from "@effect/opentelemetry"
import {
	customCanister,
	CustomCanisterConfig,
	makeCustomCanister,
	makeMotokoCanister,
	motokoCanister,
} from "../../src/builders/index.js"
import { makeTaskLayer, TaskRuntime } from "../../src/services/taskRuntime.js"
import {
	InMemorySpanExporter,
	BatchSpanProcessor,
	SimpleSpanProcessor,
	SpanExporter,
} from "@opentelemetry/sdk-trace-base"
// import { configLayer } from "../../src/services/config.js"
import {
	makeTelemetryLayer,
	TelemetryConfig,
} from "../../src/services/telemetryConfig.js"
import fs from "node:fs"
import { IceDir } from "../../src/services/iceDir.js"
import { InFlight } from "../../src/services/inFlight.js"
import { runTask, runTasks } from "../../src/tasks/run.js"
import { DeploymentsService } from "../../src/services/deployments.js"
import { BuilderLayer } from "../../src/builders/lib.js"
import { PromptsService } from "../../src/services/prompts.js"
import { logLevelMap } from "../../src/cli/index.js"

// TODO: this should use a separate pocket-ic / .ice instance for each test.
export const makeTestEnv = (iceDirName: string = ".ice_test") => {
	const globalArgs = { network: "local", logLevel: LogLevel.Debug } as const
	const config = {} satisfies Partial<ICEConfig>

	// const ICEConfigLayer = ICEConfigService.Test(
	// 	globalArgs,
	// 	// taskTree,
	// 	// config,
	// )
	// const ICEConfigLayer = ICEConfigService.Live(
	// 	globalArgs,
	// 	// taskTree,
	// 	// config,
	// ).pipe(Layer.provide(NodeContext.layer))

	const telemetryExporter = new InMemorySpanExporter()
	const telemetryConfig = {
		resource: { serviceName: "ice" },
		// spanProcessor: new SimpleSpanProcessor(telemetryExporter),
		spanProcessor: new SimpleSpanProcessor(telemetryExporter),
		shutdownTimeout: undefined,
		metricReader: undefined,
		logRecordProcessor: undefined,
	}

	const telemetryConfigLayer = Layer.succeed(TelemetryConfig, telemetryConfig)
	const telemetryLayer = makeTelemetryLayer(telemetryConfig)
	const KVStorageLayer = layerMemory

	// separate for each test?
	const configMap = new Map([
		["APP_DIR", fs.realpathSync(process.cwd())],
		// ["ICE_DIR_NAME", iceDir],
	])
	const configLayer = Layer.setConfigProvider(
		ConfigProvider.fromMap(configMap),
	)

	const iceDirLayer = IceDir.Test({ iceDirName: iceDirName }).pipe(
		Layer.provide(NodeContext.layer),
		Layer.provide(configLayer),
	)
	// const DefaultReplicaService = Layer.scoped(
	// 	DefaultReplica,
	// 	picReplicaImpl,
	// ).pipe(Layer.provide(NodeContext.layer), Layer.provide(iceDirLayer))
	const DefaultReplicaService = layerFromAsyncReplica(
		new PICReplica(
			{
				iceDirPath: iceDirName,
				network: globalArgs.network,
				logLevel: "debug",
				background: false,
			},
			{
				host: "0.0.0.0",
				port: 8081,
				ttlSeconds: 9_999_999_999,
			},
		),
	)
	const DefaultConfigLayer = DefaultConfig.Live.pipe(
		Layer.provide(DefaultReplicaService),
	)

	const InFlightLayer = InFlight.Live.pipe(Layer.provide(NodeContext.layer))

	const CanisterIdsLayer = CanisterIdsService.Test.pipe(
		Layer.provide(NodeContext.layer),
		Layer.provide(iceDirLayer),
	)
	// const sharedLayer = Layer.mergeAll(
	// 	// DeploymentsService.Live.pipe(Layer.provide(KVStorageLayer)),
	// 	// CanisterIdsLayer,
	// 	configLayer,
	// 	telemetryLayer,
	// 	Moc.Live.pipe(Layer.provide(NodeContext.layer)),
	// 	Logger.pretty,
	// 	Logger.minimumLogLevel(LogLevel.Debug),
	// 	telemetryConfigLayer,
	// )
	const testLayer = Layer.mergeAll(
		DefaultConfigLayer,
		TaskRegistry.Live.pipe(
			Layer.provide(NodeContext.layer),
			Layer.provide(KVStorageLayer),
		),
		DeploymentsService.Live.pipe(Layer.provide(KVStorageLayer)),
		CanisterIdsLayer,
		configLayer,
		telemetryLayer,
		Moc.Live.pipe(Layer.provide(NodeContext.layer)),
		Logger.pretty,
		Logger.minimumLogLevel(LogLevel.Debug),
		telemetryConfigLayer,
		// TaskRuntimeLayer.pipe(
		// 	Layer.provide(NodeContext.layer),
		// 	Layer.provide(iceDirLayer),
		// 	Layer.provide(CanisterIdsLayer),
		// 	Layer.provide(ICEConfigLayer),
		// 	Layer.provide(telemetryConfigLayer),
		// 	Layer.provide(KVStorageLayer),
		// 	Layer.provide(InFlightLayer),
		// ),
		InFlightLayer,
		iceDirLayer,
		DefaultReplicaService,
		// Moc.Live.pipe(Layer.provide(NodeContext.layer)),
		// Logger.pretty,
		// Logger.minimumLogLevel(LogLevel.Debug),
		// CanisterIdsLayer,
		// configLayer,
		// KVStorageLayer,
		// NodeContext.layer,
		// // ICEConfigLayer,
		// telemetryLayer,
		// telemetryConfigLayer,

		// sharedLayer,
	)

	const builderLayer = Layer.mergeAll(
		configLayer,
		telemetryLayer,
		Moc.Live.pipe(Layer.provide(NodeContext.layer)),
		Logger.pretty,
		Logger.minimumLogLevel(LogLevel.Debug),
		telemetryConfigLayer,
		NodeContext.layer,
		// Moc.Live.pipe(Layer.provide(NodeContext.layer)),
		// // taskLayer,
		// // TODO: generic storage?
		// CanisterIdsLayer,
		// DeploymentsService.Live.pipe(Layer.provide(KVStorageLayer)),
		// configLayer,
		// telemetryLayer,
		// Logger.pretty,
		// Logger.minimumLogLevel(LogLevel.Debug),
	) satisfies BuilderLayer
	const builderRuntime = ManagedRuntime.make(builderLayer)

	const custom = ((config: Parameters<typeof customCanister>[0]) =>
		makeCustomCanister(
			builderLayer,
			// builderRuntime as unknown as ManagedRuntime.ManagedRuntime<
			// 	unknown,
			// 	unknown
			// >,
			config,
		)) as unknown as typeof customCanister
	const motoko = ((config: Parameters<typeof motokoCanister>[0]) =>
		makeMotokoCanister(
			builderLayer,
			// builderRuntime as unknown as ManagedRuntime.ManagedRuntime<
			// 	unknown,
			// 	unknown
			// >,
			config,
		)) as unknown as typeof motokoCanister

	return {
		runtime: ManagedRuntime.make(testLayer),
		builderRuntime,
		telemetryExporter,
		customCanister: custom,
		motokoCanister: motoko,
	}
}

// TODO: this should use a separate pocket-ic / .ice instance for each test.
export const makeTestEnvEffect = (
	iceDirName: string = ".ice_test",
	globalArgs: {
		network: string
		logLevel: "debug" | "info" | "error"
		background: boolean
	} = {
		network: "local",
		logLevel: "debug",
		background: false,
	} as const,
) => {
	// const globalArgs = {
	// 	network: "local",
	// 	logLevel: LogLevel.Debug,
	// } as const
	const config = {} satisfies Partial<ICEConfig>
	// separate for each test?
	const configMap = new Map([
		["APP_DIR", fs.realpathSync(process.cwd())],
		// ["ICE_DIR_NAME", iceDir],
	])

	const configLayer = Layer.setConfigProvider(
		ConfigProvider.fromMap(configMap),
	)

	const iceDirLayer = IceDir.Test({ iceDirName: iceDirName }).pipe(
		Layer.provide(NodeContext.layer),
		Layer.provide(configLayer),
	)

	const DefaultReplicaService = layerFromAsyncReplica(
		new PICReplica(
			{
				iceDirPath: iceDirName,
				network: globalArgs.network,
				logLevel: "debug",
				background: false,
			},
			{
				host: "0.0.0.0",
				port: 8081,
				ttlSeconds: 9_999_999_999,
			},
		),
	)

	const DefaultConfigLayer = DefaultConfig.Live.pipe(
		Layer.provide(DefaultReplicaService),
	)

	// TODO: find out cleaner way to do this
	const telemetryExporter = new InMemorySpanExporter()
	telemetryExporter.shutdown = async () => {}
	const spanProcessor = new SimpleSpanProcessor(telemetryExporter)
	spanProcessor.shutdown = async () => {}

	const telemetryConfig = {
		resource: { serviceName: "ice" },
		spanProcessor,
		// telemetryExporter,
		shutdownTimeout: undefined,
		metricReader: undefined,
		logRecordProcessor: undefined,
	}

	const telemetryConfigLayer = Layer.succeed(TelemetryConfig, telemetryConfig)
	const telemetryLayer = makeTelemetryLayer(telemetryConfig)
	// const telemetryLayerMemo = yield* Layer.memoize(telemetryLayer)
	const KVStorageLayer = layerMemory

	const InFlightLayer = InFlight.Live.pipe(Layer.provide(NodeContext.layer))
	const PromptsLayer = PromptsService.Live.pipe(
		Layer.provide(NodeContext.layer),
	)

	const testLayer = Layer.mergeAll(
		// ICEConfigLayer,
		DefaultConfigLayer,
		// DeploymentsService.Live.pipe(Layer.provide(KVStorageLayer)),
		CanisterIdsService.Test.pipe(
			Layer.provide(NodeContext.layer),
			Layer.provide(iceDirLayer),
		),
		configLayer,
		telemetryConfigLayer,
		telemetryLayer,
		Moc.Live.pipe(Layer.provide(NodeContext.layer)),
		Logger.pretty,
		Logger.minimumLogLevel(logLevelMap[globalArgs.logLevel]),
		NodeContext.layer,
		KVStorageLayer,
		TaskRegistry.Live.pipe(Layer.provide(KVStorageLayer)),
		InFlightLayer,
		iceDirLayer,
		DefaultReplicaService,
		PromptsLayer,
	)

	const builderLayer = Layer.mergeAll(
		Moc.Live.pipe(Layer.provide(NodeContext.layer)),
		configLayer,
		Logger.pretty,
		Logger.minimumLogLevel(logLevelMap[globalArgs.logLevel]),
		NodeContext.layer,
		telemetryConfigLayer,
		telemetryLayer,
	)
	const builderRuntime = ManagedRuntime.make(builderLayer)

	const custom = ((config: Parameters<typeof customCanister>[0]) =>
		makeCustomCanister(
			builderLayer,
			// builderRuntime as unknown as ManagedRuntime.ManagedRuntime<
			// 	unknown,
			// 	unknown
			// >,
			config,
		)) as unknown as typeof customCanister
	const motoko = ((config: Parameters<typeof motokoCanister>[0]) =>
		makeMotokoCanister(
			builderLayer,
			// builderRuntime as unknown as ManagedRuntime.ManagedRuntime<
			// 	unknown,
			// 	unknown
			// >,
			config,
		)) as unknown as typeof motokoCanister

	return {
		runtime: ManagedRuntime.make(testLayer),
		telemetryExporter,
		customCanister: custom,
		motokoCanister: motoko,
		// testLayer,
		// builderLayer,
		// sharedLayer,
	}
}

export interface TaskRunnerShape {
	readonly runTask: <T extends Task>(
		task: T,
		args?: TaskParamsToArgs<T>,
		progressCb?: (update: ProgressUpdate<unknown>) => void,
	) => Effect.Effect<
		TaskSuccess<T>,
		TaskRuntimeError | ConfigError.ConfigError
	>
	readonly runTaskUncached: <T extends Task>(
		task: T,
		args?: TaskParamsToArgs<T>,
		progressCb?: (update: ProgressUpdate<unknown>) => void,
	) => Effect.Effect<
		TaskSuccess<T>,
		TaskRuntimeError | ConfigError.ConfigError
	>
	readonly runTasks: (
		tasks: Array<Task & { args: TaskParamsToArgs<Task> }>,
		progressCb?: (update: ProgressUpdate<unknown>) => void,
		concurrency?: "unbounded" | number,
	) => Effect.Effect<Array<TaskSuccess<Task>>, TaskRuntimeError>
}
export const makeTaskRunner = (taskTree: TaskTree) =>
	Effect.gen(function* () {
		const globalArgs = {
			network: "local",
			logLevel: "debug",
			background: false,
		} as const
		const config = {} satisfies Partial<ICEConfig>
		const ICEConfig = ICEConfigService.Test(globalArgs, taskTree, config)
		const KVStorageLayer = layerMemory
		const IceDirLayer = IceDir.Test({ iceDirName: ".ice_test" })

		const { runtime, taskLayer } = yield* makeTaskLayer(globalArgs).pipe(
			Effect.provide(ICEConfig),
			// Effect.provide(uncachedLayer),
			// Effect.provide(DeploymentsService.Live.pipe(Layer.provide(KVStorageLayer))),
			// Effect.provide(IceDirLayer),
		)
		const uncachedLayer = yield* Layer.memoize(
			Layer.mergeAll(
				Layer.effect(
					DeploymentsService,
					Effect.succeed({
						get: (_canisterName: string, _network: string) =>
							Effect.succeed(Option.none()), // not used in seed
						set: (_: {
							canisterName: string
							network: string
							deployment: unknown
						}) => Effect.succeed(undefined),
						serviceType: "NoOp",
					}),
				),
			),
		)
		const { runtime: runtimeUncached, taskLayer: taskLayerUncached } =
			yield* makeTaskLayer(globalArgs).pipe(
				Effect.provide(ICEConfig),
				Effect.provide(uncachedLayer),
				// Effect.provide(Layer.effect(DeploymentsService, Effect.succeed({
				// Effect.provide(DeploymentsService.Live.pipe(Layer.provide(KVStorageLayer))),
				// Effect.provide(IceDirLayer),
			)
		const ChildTaskRunner = Layer.succeed(TaskRuntime, {
			runtime,
			taskLayer,
		})
		const ChildTaskRunnerUncached = Layer.succeed(TaskRuntime, {
			runtime: runtimeUncached,
			taskLayer: taskLayerUncached,
		})
		const impl: TaskRunnerShape = {
			runTask: (task, args, progressCb = () => {}) =>
				Effect.gen(function* () {
					return yield* Effect.tryPromise({
						try: () =>
							runtime.runPromise(
								runTask(task, args, progressCb).pipe(
									Effect.provide(ChildTaskRunner),
									// Effect.annotateLogs("caller", "taskCtx.runTask"),
									// Effect.annotateLogs("taskPath", taskPath),
								),
							),
						catch: (error) => {
							return new TaskRuntimeError({
								message: String(error),
							})
						},
					})
				}),
			runTaskUncached: (task, args, progressCb = () => {}) =>
				Effect.tryPromise({
					try: () =>
						runtimeUncached.runPromise(
							runTask(task, args, progressCb).pipe(
								Effect.provide(ChildTaskRunnerUncached),
								// Effect.provide(uncachedLayer),
								// Effect.annotateLogs("caller", "taskCtx.runTask"),
								// Effect.annotateLogs("taskPath", taskPath),
							),
						),
					catch: (error) => {
						return new TaskRuntimeError({
							message: String(error),
						})
					},
				}),
			runTasks: (
				tasks,
				progressCb = () => {},
				concurrency = "unbounded",
			) =>
				Effect.tryPromise({
					try: () =>
						runtime.runPromise(
							runTasks(tasks, progressCb)
								.pipe(
									Effect.provide(ChildTaskRunner),
									// Effect.annotateLogs("caller", "taskCtx.runTask"),
									// Effect.annotateLogs("taskPath", taskPath),
								)
								.pipe(Effect.withConcurrency(concurrency)),
						),
					catch: (error) => {
						return new TaskRuntimeError({
							message: String(error),
						})
					},
				}),
		}
		return impl
	})

// TODO: add to builder instead
export const makeCachedTask = (task: Task, key: string) => {
	const cachedTask = {
		...task,
		// effect: async () => value,
		computeCacheKey: () => key, // ← always the same key
		input: () => Promise.resolve({} as Record<string, unknown>),
		encode: async (taskCtx, v) => v as string,
		decode: async (taskCtx, v) => v as string,
		encodingFormat: "string",
	} satisfies CachedTask
	return cachedTask
}
