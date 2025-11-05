import { NodeContext } from "@effect/platform-node"
import { FileSystem } from "@effect/platform"
// import {} from "@effect/platform-browser"
import { layerMemory, layerFileSystem } from "@effect/platform/KeyValueStore"
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
import { layerFromAsyncReplica, Replica } from "../../src/services/replica.js"
import { TaskRegistry } from "../../src/services/taskRegistry.js"
import { CachedTask, ICEConfig, Task, TaskTree } from "../../src/types/types.js"
import { NodeSdk as OpenTelemetryNodeSdk } from "@effect/opentelemetry"
import {
	customCanister,
	CustomCanisterConfig,
	makeCustomCanister,
	makeMotokoCanister,
	motokoCanister,
} from "../../src/builders/index.js"
import {
	InMemorySpanExporter,
	BatchSpanProcessor,
	SimpleSpanProcessor,
	SpanExporter,
} from "@opentelemetry/sdk-trace-base"
import {
	makeTelemetryLayer,
	TelemetryConfig,
} from "../../src/services/telemetryConfig.js"
import fs, { realpathSync } from "node:fs"
import { IceDir } from "../../src/services/iceDir.js"
import { InFlight } from "../../src/services/inFlight.js"
import { DeploymentsService } from "../../src/services/deployments.js"
import { BuilderLayer } from "../../src/builders/lib.js"
import { PromptsService } from "../../src/services/prompts.js"
import { logLevelMap } from "../../src/cli/index.js"
import { TaskRuntime } from "../../src/services/taskRuntime.js"
import { ClackLoggingLive } from "../../src/services/logger.js"
import { IcpConfigFlag } from "@dfinity/pic"
import path from "node:path"

// TODO: this should use a separate pocket-ic / .ice instance for each test.
export const makeTestEnvEffect = (
	idx: number = 0,
	// iceDirName: string = ".ice_test",
	globalArgs: {
		network: string
		logLevel: "debug" | "info" | "error"
		background: boolean
		policy: "reuse" | "restart"
		origin: "extension" | "cli"
	} = {
		network: "local",
		logLevel: "debug",
		background: false,
		policy: "reuse",
		origin: "cli",
	} as const,
	taskTree: TaskTree = {},
	iceConfig: Partial<ICEConfig> = {},
) => {
	const iceDirName = `.ice_test/${idx}`

	// const configMap = new Map([
	// 	["APP_DIR", new URL(".", import.meta.url).pathname],
	// 	// ["ICE_DIR_NAME", ".ice"],
	// ])

	const iceDirLayer = IceDir.Test({ iceDirName: iceDirName }).pipe(
		Layer.provide(NodeContext.layer),
	)

	// const ReplicaService = Layer.succeed(
	// 	Replica,
	// 	new PICReplica({
	// 		host: "0.0.0.0",
	// 		port: 8081 + idx,
	// 		ttlSeconds: 9_999_999_999,
	// 	}),
	// )
	const ReplicaService = layerFromAsyncReplica(
		new PICReplica({
			host: "0.0.0.0",
			port: 8081,
			ttlSeconds: 9_999_999_999,
			picConfig: {
				icpConfig: { betaFeatures: IcpConfigFlag.Enabled },
			},
		}),
		{
			iceDirPath: iceDirName,
			network: globalArgs.network,
			logLevel: globalArgs.logLevel,
			background: globalArgs.background,
			policy: globalArgs.policy,
		},
	)
	const DefaultConfigLayer = DefaultConfig.Live.pipe(
		Layer.provide(ReplicaService),
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
    // TODO: fix??/
    // const appDir = fs.realpathSync(process.cwd())
    // const cacheDirPath = path.join(appDir, iceDirName, "cache")
	const KVStorageLayer = layerFileSystem(`${iceDirName}/cache`).pipe(
		Layer.provide(NodeContext.layer),
        Layer.provide(iceDirLayer),
	)

	const InFlightLayer = InFlight.Live.pipe(Layer.provide(NodeContext.layer))
	const PromptsLayer = PromptsService.Live.pipe(
		Layer.provide(NodeContext.layer),
	)

	// TODO: build it here?
	// const iceConfigLayer = ICEConfigService.Test(globalArgs, {}, {})
	const iceConfigLayer = ICEConfigService.Test(
		globalArgs,
		taskTree,
		iceConfig,
	)
	const canisterIdsLayer = CanisterIdsService.Live.pipe(
		Layer.provide(NodeContext.layer),
		Layer.provide(iceDirLayer),
	)
	const deploymentsLayer = DeploymentsService.Live.pipe(
		Layer.provide(KVStorageLayer),
	)
	const taskRuntimeLayer = TaskRuntime.Live(() => {})

	const testLayer = Layer.mergeAll(
		// DefaultConfigLayer,
		canisterIdsLayer,
		Moc.Live.pipe(Layer.provide(NodeContext.layer)),
		// Logger.pretty,
		ClackLoggingLive,
		Logger.minimumLogLevel(logLevelMap[globalArgs.logLevel]),
		NodeContext.layer,
		KVStorageLayer,
		TaskRegistry.Live.pipe(
			Layer.provide(NodeContext.layer),
			Layer.provide(KVStorageLayer),
		),
		InFlightLayer,
		iceDirLayer,
		// ReplicaService,
		PromptsLayer,
		iceConfigLayer,
		telemetryLayer,
		telemetryConfigLayer,
		deploymentsLayer,
		taskRuntimeLayer.pipe(
			Layer.provide(NodeContext.layer),
			Layer.provide(KVStorageLayer),
			Layer.provide(iceConfigLayer),
			Layer.provide(telemetryLayer),
			Layer.provide(telemetryConfigLayer),
			Layer.provide(ReplicaService),
			Layer.provide(
				DefaultConfigLayer.pipe(Layer.provide(ReplicaService)),
			),
			Layer.provide(canisterIdsLayer),
			Layer.provide(InFlightLayer),
			Layer.provide(iceDirLayer),
			Layer.provide(deploymentsLayer),
			Layer.provide(PromptsService.Live),
			Layer.provide(
				TaskRegistry.Live.pipe(Layer.provide(KVStorageLayer)),
			),
		),
	)

	const builderLayer = Layer.mergeAll(
		Moc.Live.pipe(Layer.provide(NodeContext.layer)),
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
		layer: testLayer,
		telemetryExporter,
		customCanister: custom,
		motokoCanister: motoko,
		// testLayer,
		// builderLayer,
		// sharedLayer,
	}
}
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
