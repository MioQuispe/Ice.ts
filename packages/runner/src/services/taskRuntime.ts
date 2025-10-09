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
} from "effect"
import type { Task } from "../types/types.js"
import { TaskParamsToArgs, TaskSuccess } from "../tasks/lib.js"
// import { executeTasks } from "../tasks/execute"
import { ProgressUpdate } from "../tasks/lib.js"
import { StandardSchemaV1 } from "@standard-schema/spec"
import { ICEConfigService } from "./iceConfig.js"
import { NodeContext } from "@effect/platform-node"
import { type } from "arktype"
import { Logger, Tracer } from "effect"
import fs from "node:fs"
import { NodeSdk as OpenTelemetryNodeSdk } from "@effect/opentelemetry"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import type { Scope, TaskTree } from "../types/types.js"
import { TaskRegistry } from "./taskRegistry.js"
export { Opt } from "../types/types.js"
import { layerFileSystem, layerMemory } from "@effect/platform/KeyValueStore"
import { CanisterIdsService } from "./canisterIds.js"
import { DefaultConfig } from "./defaultConfig.js"
import { Moc, MocError } from "./moc.js"
import {
	AgentError,
	DefaultReplica,
	layerFromAsyncReplica,
	ReplicaError,
} from "./replica.js"
import type { ICEConfig, ICEConfigContext } from "../types/types.js"
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
import { DeploymentsService } from "./deployments.js"
// import { DfxReplica } from "./dfx.js"
import { configLayer } from "./config.js"
import { ClackLoggingLive } from "./logger.js"
import { PromptsService } from "./prompts.js"
import { PICReplica } from "./pic/pic.js"
import { effectifyReplica } from "./replica.js"
import { GlobalArgs } from "../cli/index.js"

type TaskReturnValue<T extends Task> = ReturnType<T["effect"]>

type Job = {
	task: Task
	args: Record<string, unknown>
	reply: Deferred.Deferred<unknown, unknown>
}

class TaskRunnerError extends Data.TaggedError("TaskRunnerError")<{
	message?: string
	error?: unknown
}> {}

const logLevelMap = {
	debug: LogLevel.Debug,
	info: LogLevel.Info,
	error: LogLevel.Error,
}

export class TaskRuntime extends Context.Tag("TaskRuntime")<
	TaskRuntime,
	{
		runtime: ManagedRuntime.ManagedRuntime<
			| OtelTracer
			| Resource
			| NodeContext.NodeContext
			| TaskRegistry
			| KeyValueStore.KeyValueStore
			| DefaultReplica
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
			| DefaultReplica
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
	}
>() {}

// const DfxReplicaService = DfxReplica.pipe(Layer.provide(NodeContext.layer))

// const DefaultsLayer = Layer
// 	.mergeAll
// 	()
const ICEConfigLayer = ICEConfigService.Live({
	network: "local",
	logLevel: "debug",
	background: false,
}).pipe(Layer.provide(NodeContext.layer))

const telemetryConfig = {
	resource: { serviceName: "ice" },
	spanProcessor: new BatchSpanProcessor(new OTLPTraceExporter()),
	shutdownTimeout: undefined,
	metricReader: undefined,
	logRecordProcessor: undefined,
}
const telemetryConfigLayer = Layer.succeed(TelemetryConfig, telemetryConfig)
const telemetryLayer = makeTelemetryLayer(telemetryConfig)

// TODO: create the directory if it doesn't exist
// do we need iceDir at all? maybe yes, because we want a finalizer?
const KVStorageLayer = layerFileSystem(".ice/cache").pipe(
	Layer.provide(NodeContext.layer),
)

const TaskRegistryLayer = TaskRegistry.Live.pipe(Layer.provide(KVStorageLayer))

const IceDirLayer = IceDir.Live({ iceDirName: ".ice" }).pipe(
	Layer.provide(NodeContext.layer),
	Layer.provide(configLayer),
)

const InFlightLayer = InFlight.Live.pipe(Layer.provide(NodeContext.layer))
const DeploymentsLayer = DeploymentsService.Live.pipe(
	// Layer.provide(NodeContext.layer),
	Layer.provide(KVStorageLayer),
	// Layer.provide(
	// 	// TODO: creates the directory if it doesn't exist
	// 	// do we need iceDir at all?
	// 	layerFileSystem(".ice/deployments").pipe(
	// 		Layer.provide(NodeContext.layer),
	// 	),
	// ),
)

const CanisterIdsLayer = CanisterIdsService.Live.pipe(
	Layer.provide(NodeContext.layer),
	Layer.provide(IceDirLayer),
)
// export const taskLayer = Layer.mergeAll(
// 	telemetryLayer,
// 	NodeContext.layer,
// 	TaskRegistryLayer,
// 	DefaultReplicaService,
// 	DefaultConfig.Live.pipe(Layer.provide(DefaultReplicaService)),
// 	Moc.Live.pipe(Layer.provide(NodeContext.layer)),
// 	CanisterIdsLayer,
// 	// DevTools.layerWebSocket().pipe(
// 	// 	Layer.provide(NodeSocket.layerWebSocketConstructor),
// 	// ),
// 	ICEConfigLayer,
// 	telemetryConfigLayer,
// 	InFlightLayer,
// 	IceDirLayer,
// 	KVStorageLayer,
// 	configLayer,
// 	NodeContext.layer,
// 	DeploymentsLayer,
// 	Logger.minimumLogLevel(logLevelMap.debug),
// )

// TODO: Layer memoize instead?
export const makeTaskLayer = (globalArgs: GlobalArgs) =>
	Effect.gen(function* () {
		const appDir = yield* Config.string("APP_DIR")
		// const iceDir = yield* Config.string("ICE_DIR_NAME")
		const configMap = new Map([
			["APP_DIR", appDir],
			// ["ICE_DIR_NAME", iceDir],
		])
		const configLayer = Layer.setConfigProvider(
			ConfigProvider.fromMap(configMap),
		)
		// TODO: dont pass down to child tasks
		const ICEConfig = yield* ICEConfigService
		const ICEConfigLayer = Layer.succeed(ICEConfigService, ICEConfig)
		const iceDir = yield* IceDir
		const IceDirLayer = Layer.succeed(IceDir, iceDir)
		// TODO: make it work for tests too
		const telemetryConfig = yield* TelemetryConfig
		// const defaultReplica = yield* DefaultReplica
		// const DefaultReplicaService = Layer.succeed(DefaultReplica, defaultReplica)
		// const DefaultReplicaService = Layer.scoped(
		// 	DefaultReplica,
		// 	picReplicaImpl({
		// 		runInBackground: false,
		// 		ip: "0.0.0.0",
		// 		port: 8081,
		// 		ttlSeconds: 9_999_999_999,
		// 	}),
		// ).pipe(Layer.provide(NodeContext.layer), Layer.provide(IceDirLayer))

		// const telemetryConfigLayer = Layer.succeed(
		// 	TelemetryConfig,
		// 	telemetryConfig,
		// )
		const telemetryLayer = makeTelemetryLayer(telemetryConfig)
		// const telemetryLayerMemo = yield* Layer.memoize(telemetryLayer)

		// const telemetryLayer = yield* getTelemetryLayer()
		const telemetryConfigLayer = Layer.succeed(
			TelemetryConfig,
			telemetryConfig,
		)
		const KV = yield* KeyValueStore.KeyValueStore
		const KVStorageLayer = Layer.succeed(KeyValueStore.KeyValueStore, KV)
		const InFlightService = yield* InFlight
		const InFlightLayer = Layer.succeed(InFlight, InFlightService)

		const CanisterIds = yield* CanisterIdsService
		const CanisterIdsLayer = Layer.succeed(CanisterIdsService, CanisterIds)
		const Deployments = yield* DeploymentsService
		const DeploymentsLayer = Layer.succeed(DeploymentsService, Deployments)
		const Prompts = yield* PromptsService
		const PromptsLayer = Layer.succeed(PromptsService, Prompts)

		const TaskRegistryService = yield* TaskRegistry
		const TaskRegistryLayer = Layer.succeed(
			TaskRegistry,
			TaskRegistryService,
		)
		const ctx = {
			...globalArgs,
			iceDirPath: iceDir.path,
		}

		// Reuse an already-provided DefaultReplica if available in the current Effect environment
		const existingDefaultReplica =
			yield* Effect.serviceOption(DefaultReplica)

		const DefaultReplicaService = Option.isNone(existingDefaultReplica)
			? layerFromAsyncReplica(
					new PICReplica(ctx, {
						host: "0.0.0.0",
						port: 8081,
						ttlSeconds: 9_999_999_999,
					}),
				)
			: Layer.succeed(DefaultReplica, existingDefaultReplica.value)

		// ICEConfigService | DefaultConfig | IceDir | TaskRunner | TaskRegistry | InFlight
		const taskLayer = Layer.mergeAll(
			telemetryLayer,
			NodeContext.layer,
			TaskRegistryLayer,
			DefaultReplicaService,
			DefaultConfig.Live.pipe(Layer.provide(DefaultReplicaService)),
			Moc.Live.pipe(Layer.provide(NodeContext.layer)),
			CanisterIdsLayer,
			// DevTools.layerWebSocket().pipe(
			// 	Layer.provide(NodeSocket.layerWebSocketConstructor),
			// ),
			ICEConfigLayer,
			telemetryConfigLayer,
			ClackLoggingLive, // single-writer clack logger
			Logger.minimumLogLevel(logLevelMap[ICEConfig.globalArgs.logLevel]),
			InFlightLayer,
			IceDirLayer,
			KVStorageLayer,
			configLayer,
			NodeContext.layer,
			DeploymentsLayer,
			PromptsLayer,
		)
		const taskRuntime = ManagedRuntime.make(taskLayer)
		// const ChildTaskRunner = Layer.succeed(TaskRuntime, {
		// 	runtime: taskRuntime,
		// 	taskLayer,
		// })

		// const fullTaskLayer = Layer.mergeAll(taskLayer, ChildTaskRunner)

		// const ChildTaskRunner = Layer.succeed(TaskRunner, {
		// 	runtime: taskRuntime,
		// })
		// runTasks: (
		// 	tasks: Array<Task & { args: TaskParamsToArgs<Task> }>,
		// 	progressCb: (
		// 		update: ProgressUpdate<unknown>,
		// 	) => void = () => {},
		// ) =>
		// 	taskRuntime.runPromise(
		// 		runTasks(tasks, progressCb).pipe(
		// 			Effect.provide(ChildTaskRunner),
		// 			Effect.annotateLogs("caller", "taskCtx.runTask"),
		// 			// Effect.annotateLogs("taskPath", taskPath),
		// 		),
		// 	),

		return {
			runtime: taskRuntime,
			taskLayer,

			// runTask: <T extends Task>(
			// 	task: T,
			// 	args?: TaskParamsToArgs<T>,
			// 	progressCb: (
			// 		update: ProgressUpdate<unknown>,
			// 	) => void = () => {},
			// ) =>
			// 	taskRuntime.runPromise(
			// 		runTask(task, args, progressCb)
			//         // .pipe(
			// 		// 	Effect.provide(ChildTaskRunner),
			// 		// 	Effect.annotateLogs("caller", "taskCtx.runTask"),
			// 		// 	Effect.annotateLogs("taskPath", taskPath),
			// 		// ),
			// 	),
			// runTasks: (
			// 	tasks: Array<Task & { args: TaskParamsToArgs<Task> }>,
			// 	progressCb: (
			// 		update: ProgressUpdate<unknown>,
			// 	) => void = () => {},
			// ) =>
			// 	taskRuntime.runPromise(
			// 		runTasks(tasks, progressCb).pipe(
			// 			Effect.provide(ChildTaskRunner),
			// 			Effect.annotateLogs("caller", "taskCtx.runTask"),
			// 			// Effect.annotateLogs("taskPath", taskPath),
			// 		),
			// 	),
		}
	})
