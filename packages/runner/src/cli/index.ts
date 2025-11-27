import * as p from "@clack/prompts"
import { cancel, isCancel } from "@clack/prompts"
import { Resolvable, createMain, defineCommand, type ArgsDef } from "citty"
import { Console, Effect, Either, Metric, Tracer } from "effect"
// import {
// 	Tracer as OtelTracer,
// 	Logger as OtelLogger,
// 	Resource as OtelResource,
// 	Metrics as OtelMetrics,
// } from "@effect/opentelemetry"
import * as OtelMetrics from "@effect/opentelemetry/Metrics"
import mri from "mri"
import color from "picocolors"
import { Tags } from "../builders/lib.js"
import { DeploymentError } from "../canister.js"
import { CanisterIdsService } from "../services/canisterIds.js"
import { ICEConfigService } from "../services/iceConfig.js"
import {
	CanisterStatus,
	CanisterStatusError,
	layerFromAsyncReplica,
	Replica,
	ReplicaError,
} from "../services/replica.js"
import {
	filterNodes,
	totalTaskCount,
	cachedTaskCount,
	uncachedTaskCount,
	cacheHitCount,
	ProgressUpdate,
	TaskParamsToArgs,
	findTaskInTaskTree,
	TaskRuntimeError,
	TaskArgsParseError,
	resolveArg,
	inflightTaskCount,
	cancelledTaskCount,
} from "../tasks/lib.js"
import type { PositionalParam, NamedParam, Task } from "../types/types.js"
import { task } from "../builders/task.js"
import { NodeContext, NodeSocket } from "@effect/platform-node"
import { layerFileSystem } from "@effect/platform/KeyValueStore"
import { StandardSchemaV1 } from "@standard-schema/spec"
import { type } from "arktype"
import {
	ConfigProvider,
	Context,
	Layer,
	Logger,
	LogLevel,
	ManagedRuntime,
} from "effect"
import fs from "node:fs"
import { DefaultConfig } from "../services/defaultConfig.js"
// import { DfxReplica } from "../services/dfx.js"
import { Moc } from "../services/moc.js"
import { PICReplica } from "../services/pic/pic.js"
import { TaskRegistry } from "../services/taskRegistry.js"
import type { ICEConfig, ICEGlobalArgs } from "../types/types.js"
import {
	BatchSpanProcessor,
	InMemorySpanExporter,
	SimpleSpanProcessor,
	SpanExporter,
} from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import type { Scope, TaskTree } from "../types/types.js"
export { Opt } from "../types/types.js"
import { InFlight } from "../services/inFlight.js"
import { IceDir } from "../services/iceDir.js"
import { runTask, runTasks } from "../tasks/run.js"
import {
	makeTelemetryLayer,
	TelemetryConfig,
} from "../services/telemetryConfig.js"
import { DeploymentsService } from "../services/deployments.js"
import { PromptsService } from "../services/prompts.js"
import { ClackLoggingLive } from "../services/logger.js"
import { TaskRuntime } from "../services/taskRuntime.js"
import { NodeSdk } from "@effect/opentelemetry"
import { ICReplica } from "../services/ic-replica.js"
import { FileSystem } from "@effect/platform"
import { Identity } from "@icp-sdk/core/agent"
// import { uiTask } from "./ui/index.js"

export const runTaskByPath = Effect.fn("runTaskByPath")(function* (
	taskPath: string,
	cliTaskArgs: {
		positionalArgs: string[]
		namedArgs: Record<string, string>
	},
	progressCb: (update: ProgressUpdate<unknown>) => void = () => {},
) {
	yield* Effect.annotateCurrentSpan({
		taskPath,
	})
	yield* Effect.logDebug("Running task by path", { taskPath })
	const taskPathSegments: string[] = taskPath.split(":")
	const { tasks: taskTree } = yield* ICEConfigService
	const task = yield* findTaskInTaskTree(taskTree, taskPathSegments)
	const argsMap = yield* resolveCliArgsMap(task, cliTaskArgs)
	yield* Effect.logDebug("Task found", taskPath)
	return yield* runTask(task, argsMap, progressCb).pipe(
		Effect.withConcurrency("unbounded"),
	)
})

export const resolveCliArgsMap = (
	task: Task,
	cliTaskArgs: {
		positionalArgs: string[]
		namedArgs: Record<string, string>
	},
) =>
	Effect.gen(function* () {
		let argsMap: Record<string, unknown> = {}
		for (const [paramName, param] of Object.entries(task.namedParams)) {
			const arg = cliTaskArgs.namedArgs[paramName]
			if (!arg && !param.isOptional) {
				return yield* Effect.fail(
					new TaskArgsParseError({
						message: `Missing parameter: ${paramName}`,
					}),
				)
			}
			const resolvedArg = yield* resolveArg(
				param,
				arg ? param.decode(arg) : undefined,
			)
			argsMap[paramName] = resolvedArg
		}
		for (const [index, param] of task.positionalParams.entries()) {
			const arg = cliTaskArgs.positionalArgs[index]
			if (!arg && !param.isOptional) {
				return yield* Effect.fail(
					new TaskArgsParseError({
						message: `Missing positional arg: ${index}`,
					}),
				)
			}
			const resolvedArg = yield* resolveArg(
				param,
				arg ? param.decode(arg) : undefined,
			)
			argsMap[param.name] = resolvedArg
		}

		return argsMap
	})

export const CliArgs = type({
	logLevel: "'debug' | 'info' | 'error'",
	background: type("'1' | '0' | 'true' | 'false' | '' | false | true").pipe(
		(str) => str === "1" || str === "true" || str === "" || str === true,
	),
	policy: "'reuse' | 'restart'",
	origin: "'extension' | 'cli'",
}) satisfies StandardSchemaV1<Record<string, unknown>>
export type CliArgs = {
	logLevel: "debug" | "info" | "error"
	background: boolean
	policy: "reuse" | "restart"
	origin: "extension" | "cli"
}

export const logLevelMap = {
	debug: LogLevel.Debug,
	info: LogLevel.Info,
	error: LogLevel.Error,
}

type RuntimeArgs = {
	// TODO: add config
	logLevel: string
	background: boolean
	policy: string
	origin: "extension" | "cli"
}

type MakeCliRuntimeArgs = {
	globalArgs: RuntimeArgs
	telemetryExporter?: SpanExporter
}

/**
 * Creates a minimal runtime with only basic services (FileSystem, Logger, IceDir, Prompts).
 * Use for commands that don't need config or replica (e.g., clean, help).
 */
export const makeMinimalRuntime = ({
	globalArgs: rawGlobalArgs,
	telemetryExporter = new OTLPTraceExporter(),
}: MakeCliRuntimeArgs) => {
	const globalArgs = CliArgs(rawGlobalArgs)
	if (globalArgs instanceof type.errors) {
		throw new Error(globalArgs.summary)
	}

	const iceDirName = ".ice"

	const IceDirLayer = IceDir.Live({ iceDirName }).pipe(
		Layer.provide(NodeContext.layer),
	)

	const spanProcessor = new SimpleSpanProcessor(telemetryExporter)
	const telemetryConfig = {
		resource: { serviceName: "ice" },
		spanProcessor,
		shutdownTimeout: undefined,
		metricReader: undefined,
		logRecordProcessor: undefined,
	}
	const telemetryConfigLayer = Layer.succeed(TelemetryConfig, telemetryConfig)
	const telemetryLayer = makeTelemetryLayer(telemetryConfig)

	const KVStorageLayer = layerFileSystem(".ice/cache").pipe(
		Layer.provide(NodeContext.layer),
	)

	const minimalLayer = Layer.mergeAll(
		NodeContext.layer,
		IceDirLayer,
		ClackLoggingLive,
		PromptsService.Live,
		Logger.minimumLogLevel(logLevelMap[globalArgs.logLevel]),
		telemetryLayer,
		telemetryConfigLayer,
		KVStorageLayer,
	)

	return ManagedRuntime.make(minimalLayer)
}

/**
 * Creates a runtime with config services (includes ICEConfig, CanisterIds).
 * Use for commands that need config but not replica (e.g., status on IC network).
 */
export const makeConfigRuntime = ({
	globalArgs: rawGlobalArgs,
	telemetryExporter = new OTLPTraceExporter(),
}: MakeCliRuntimeArgs) => {
	const globalArgs = CliArgs(rawGlobalArgs)
	if (globalArgs instanceof type.errors) {
		throw new Error(globalArgs.summary)
	}

	const iceDirName = ".ice"

	const IceDirLayer = IceDir.Live({ iceDirName }).pipe(
		Layer.provide(NodeContext.layer),
	)

	const ICEConfigLayer = ICEConfigService.Live({
		logLevel: globalArgs.logLevel,
		background: globalArgs.background,
		policy: globalArgs.policy,
		origin: globalArgs.origin,
	}).pipe(Layer.provide(NodeContext.layer), Layer.provide(IceDirLayer))

	const spanProcessor = new SimpleSpanProcessor(telemetryExporter)
	const telemetryConfig = {
		resource: { serviceName: "ice" },
		spanProcessor,
		shutdownTimeout: undefined,
		metricReader: undefined,
		logRecordProcessor: undefined,
	}
	const telemetryConfigLayer = Layer.succeed(TelemetryConfig, telemetryConfig)
	const telemetryLayer = makeTelemetryLayer(telemetryConfig)

	const KVStorageLayer = layerFileSystem(".ice/cache").pipe(
		Layer.provide(NodeContext.layer),
	)

	const CanisterIdsLayer = CanisterIdsService.Live.pipe(
		Layer.provide(NodeContext.layer),
		Layer.provide(IceDirLayer),
	)

	const DeploymentsLayer = DeploymentsService.Live.pipe(
		Layer.provide(KVStorageLayer),
	)

	const InFlightLayer = InFlight.Live.pipe(Layer.provide(NodeContext.layer))

	const configLayer = Layer.mergeAll(
		NodeContext.layer,
		IceDirLayer,
		ClackLoggingLive,
		PromptsService.Live,
		Logger.minimumLogLevel(logLevelMap[globalArgs.logLevel]),
		telemetryLayer,
		telemetryConfigLayer,
		KVStorageLayer,
		ICEConfigLayer,
		CanisterIdsLayer,
		DeploymentsLayer,
		InFlightLayer,
	)

	return ManagedRuntime.make(configLayer)
}

/**
 * Creates a full runtime with all services including Replica and TaskRuntime.
 * Use for commands that need to interact with canisters (e.g., deploy, run tasks).
 */
export const makeFullRuntime = ({
	globalArgs: rawGlobalArgs,
	telemetryExporter = new OTLPTraceExporter(),
}: MakeCliRuntimeArgs) => {
	const globalArgs = CliArgs(rawGlobalArgs)
	if (globalArgs instanceof type.errors) {
		throw new Error(globalArgs.summary)
	}

	const iceDirName = ".ice"

	// const DfxReplicaService = DfxReplica.pipe(Layer.provide(NodeContext.layer))

	const IceDirLayer = IceDir.Live({ iceDirName }).pipe(
		Layer.provide(NodeContext.layer),
	)

	const ICEConfigLayer = ICEConfigService.Live({
		logLevel: globalArgs.logLevel,
		background: globalArgs.background,
		policy: globalArgs.policy,
		origin: globalArgs.origin,
	}).pipe(Layer.provide(NodeContext.layer), Layer.provide(IceDirLayer))

	// const telemetryExporter = new OTLPTraceExporter()
	// const spanProcessor = new BatchSpanProcessor(telemetryExporter)
	const spanProcessor = new SimpleSpanProcessor(telemetryExporter)
	const telemetryConfig = {
		resource: { serviceName: "ice" },
		spanProcessor,
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

	// const TaskRegistryLayer = TaskRegistry.Live.pipe(
	// 	Layer.provide(KVStorageLayer),
	// )

	const picReplicaLayer = layerFromAsyncReplica(
		new PICReplica({
			host: "0.0.0.0",
			port: 8081,
			ttlSeconds: 9_999_999_999,
		}),
	)

	// TODO: use staging & ic urls
	// const stagingReplicaLayer = layerFromAsyncReplica(
	// 	new ICReplica({
	// 		host: "http://0.0.0.0",
	// 		port: 8080,
	// 		isDev: true,
	// 	}),
	// 	{
	// 		iceDirPath: iceDirName,
	// 		network: globalArgs.network,
	// 		logLevel: globalArgs.logLevel,
	// 		background: globalArgs.background,
	// 		policy: globalArgs.policy,
	// 	},
	// )
	// const icReplicaLayer = layerFromAsyncReplica(
	// 	new ICReplica({
	// 		// host: "0.0.0.0",
	// 		// port: 8080,
	// 		host: "https://icp-api.io",
	// 		port: 80,
	// 		isDev: false,
	// 	}),
	// 	{
	// 		iceDirPath: iceDirName,
	// 		network: globalArgs.network,
	// 		logLevel: globalArgs.logLevel,
	// 		background: globalArgs.background,
	// 		policy: globalArgs.policy,
	// 	},
	// )

	const ReplicaService = picReplicaLayer
	const DefaultConfigLayer = DefaultConfig.Live.pipe(
		Layer.provide(ReplicaService),
	)

	const InFlightLayer = InFlight.Live.pipe(Layer.provide(NodeContext.layer))
	const DeploymentsLayer = DeploymentsService.Live.pipe(
		Layer.provide(KVStorageLayer),
	)

	const CanisterIdsLayer = CanisterIdsService.Live.pipe(
		Layer.provide(NodeContext.layer),
		Layer.provide(IceDirLayer),
	)
	const TaskRuntimeLayer = TaskRuntime.Live(() => {})
	const cliLayer = Layer.mergeAll(
		TaskRegistry.Live.pipe(
			Layer.provide(NodeContext.layer),
			Layer.provide(KVStorageLayer),
		),
		DeploymentsLayer,
		InFlightLayer,
		IceDirLayer,
		// Moc.Live.pipe(Layer.provide(NodeContext.layer)),
		ClackLoggingLive,
		PromptsService.Live,
		Logger.minimumLogLevel(logLevelMap[globalArgs.logLevel]),
		CanisterIdsLayer,
		KVStorageLayer,
		NodeContext.layer,
		ICEConfigLayer,
		telemetryLayer,
		telemetryConfigLayer,

		// ReplicaService,
		// DefaultConfigLayer.pipe(Layer.provide(ReplicaService)),
		TaskRuntimeLayer.pipe(
			Layer.provide(
				Layer.mergeAll(
					ClackLoggingLive,
					NodeContext.layer,
					KVStorageLayer,
					ICEConfigLayer,
					telemetryLayer,
					telemetryConfigLayer,
					ReplicaService,
					DefaultConfigLayer,
					CanisterIdsLayer,
					InFlightLayer,
					IceDirLayer,
					DeploymentsLayer,
					PromptsService.Live,
					TaskRegistry.Live.pipe(Layer.provide(KVStorageLayer)),
				),
			),
		),
	)
	return ManagedRuntime.make(cliLayer)
}

/**
 * Legacy alias for makeFullRuntime. Use specific runtime constructors instead.
 * @deprecated Use makeMinimalRuntime, makeConfigRuntime, or makeFullRuntime
 */
export const makeCliRuntime = makeFullRuntime

function moduleHashToHexString(moduleHash: [] | [number[]]): string {
	if (moduleHash.length === 0) {
		return "Not Present"
	}
	const bytes = new Uint8Array(moduleHash[0]) // Ensure it's a Uint8Array
	const hexString = Buffer.from(bytes).toString("hex")
	return `0x${hexString}`
}

const getGlobalArgs = (cmdName: string): CliArgs => {
	const args = process.argv.slice(2)
	// Stop at the first non-flag token (subcommand/positional)
	const firstNonFlagIndex = args.findIndex((arg) => !arg.startsWith("-"))
	const globalSlice =
		firstNonFlagIndex === -1 ? args : args.slice(0, firstNonFlagIndex)
	const parsed = mri(globalSlice, {
		boolean: ["background"],
		string: ["logLevel", "policy", "origin"],
		default: { background: false },
	}) as Record<string, unknown>
	const rawLogLevel = String(parsed["logLevel"] ?? "info").toLowerCase()
	const logLevel = ["debug", "info", "error"].includes(rawLogLevel)
		? (rawLogLevel as "debug" | "info" | "error")
		: "info"
	const rawOrigin = String(parsed["origin"] ?? "cli").toLowerCase()
	const origin = ["extension", "cli"].includes(rawOrigin)
		? (rawOrigin as "extension" | "cli")
		: "cli"
	const background =
		Boolean(parsed["background"]) || parsed["background"] === ""
	const rawPolicy = String(parsed["policy"]).toLowerCase()
	const policy = ["reuse", "restart"].includes(rawPolicy)
		? (rawPolicy as "reuse" | "restart")
		: "reuse"
	return { logLevel, background, policy, origin }
}

const globalArgs = {
	logLevel: {
		type: "string",
		required: false,
		default: "info",
		description: "Select a log level",
	},
	background: {
		type: "boolean",
		required: false,
		default: false,
		description: "Run in background",
	},
} satisfies Resolvable<ArgsDef>

//   // TODO: we need to construct this dynamically if we want space delimited task paths
const runCommand = defineCommand({
	meta: {
		name: "run",
		description:
			"Run an ICE task by its path, e.g. icrc1:build, nns:governance:install",
	},
	args: {
		taskPath: {
			type: "positional",
			required: true,
			description:
				"The task to run. examples: icrc1:build, nns:governance:install",
		},
		// TODO: fix. these get overridden by later args
		...globalArgs,
	},
	run: async ({ args, rawArgs }) => {
		const globalArgs = getGlobalArgs("run")
		const taskArgs = rawArgs.slice(1)
		const parsedArgs = mri(taskArgs)
		const namedArgs = Object.fromEntries(
			Object.entries(parsedArgs).filter(([name]) => name !== "_"),
		)
		const positionalArgs = parsedArgs._
		const cliTaskArgs = {
			positionalArgs,
			namedArgs,
		}
		const telemetryExporter = new OTLPTraceExporter()
		await makeFullRuntime({
			globalArgs,
			telemetryExporter,
		}).runPromise(
			Effect.gen(function* () {
				const Prompts = yield* PromptsService
				const s = yield* Prompts.Spinner()
				s.start(
					`Running task... ${color.green(color.underline(args.taskPath))}`,
				)
				const { replica } = yield* TaskRuntime
				const iceDir = yield* IceDir
				const { config } = yield* ICEConfigService
				// TODO: use finalizer??
				yield* Effect.tryPromise({
					try: () =>
						replica.start({
							...globalArgs,
							network: config.network,
							iceDirPath: iceDir.path,
						}),
					catch: (e) => new ReplicaError({ message: String(e) }),
				})
				yield* runTaskByPath(args.taskPath, cliTaskArgs)
				// TODO: use finalizer??
				yield* Effect.tryPromise({
					try: () => replica.stop({ scope: "foreground" }),
					catch: (e) => new ReplicaError({ message: String(e) }),
				})
				// TODO: fix
				// yield* runTaskByPath(args.taskPath, cliTaskArgs).pipe(
				// 	Effect.provide(ChildTaskRuntimeLayer),
				// 	Effect.tap((result) =>
				// 		Effect.gen(function* () {
				// 			const count = yield* Metric.value(totalTaskCount)
				// 			const cachedCount =
				// 				yield* Metric.value(cachedTaskCount)
				// 			const uncachedCount =
				// 				yield* Metric.value(uncachedTaskCount)
				// 			const hitCount = yield* Metric.value(cacheHitCount)
				// 		}),
				// 	),
				// )
				s.stop(
					`Finished task: ${color.green(color.underline(args.taskPath))}`,
				)
			}),
		)
	},
})

const stopCommand = defineCommand({
	meta: {
		name: "stop",
		description: "Stop the ICE replica",
	},
	args: {
		// TODO: fix. these get overridden by later args
		...globalArgs,
	},
	run: async ({ args, rawArgs }) => {
		const globalArgs = getGlobalArgs("stop")
		const taskArgs = rawArgs.slice(1)
		const parsedArgs = mri(taskArgs)
		const namedArgs = Object.fromEntries(
			Object.entries(parsedArgs).filter(([name]) => name !== "_"),
		)
		const positionalArgs = parsedArgs._
		const cliTaskArgs = {
			positionalArgs,
			namedArgs,
		}
		const telemetryExporter = new OTLPTraceExporter()
		await makeFullRuntime({
			globalArgs,
			telemetryExporter,
		}).runPromise(
			Effect.gen(function* () {
				const Prompts = yield* PromptsService
				const s = yield* Prompts.Spinner()
				s.start("Stopping replica...")
				const { runtime, replica } = yield* TaskRuntime
				const iceDir = yield* IceDir
				const { config } = yield* ICEConfigService
				// TODO: replica stop needs to work without starting it
				yield* Effect.tryPromise({
					try: () =>
						replica.stop(
							{
								scope: "background",
							},
							{
								...globalArgs,
								network: config.network,
								iceDirPath: iceDir.path,
							},
						),
					catch: (e) =>
						new ReplicaError({
							message: String(e),
						}),
				})
				s.stop("Replica stopped")
			}),
		)
	},
})

const initCommand = defineCommand({
	meta: {
		name: "Init",
		description: "Initialize a new ICE project",
	},
	run: async ({ args }) => {
		p.text({ message: "Coming soon..." })
		// TODO: prompt which canisters to include
		// await runtime.runPromise(
		//   Effect.gen(function* () {
		//     yield* initTask()
		//   }),
		// )
	},
})

const deployRun = async ({
	logLevel,
	background,
	policy,
	origin,
	cliTaskArgs,
}: {
	logLevel: "debug" | "info" | "error"
	background: boolean
	policy: "reuse" | "restart"
	origin: "extension" | "cli"
	cliTaskArgs: {
		positionalArgs: string[]
		namedArgs: Record<string, string>
	}
}) => {
	// spinner controlled inside Effect program via PromptsService
	// TODO: mode
	const globalArgs = {
		logLevel,
		background,
		policy,
		origin,
	}
	const telemetryExporter = new InMemorySpanExporter()
	// const telemetryExporter = new OTLPTraceExporter()
	// TODO: convert to task
	const program = Effect.fn("deploy")(function* () {
		const { tasks: taskTree } = yield* ICEConfigService
		const Prompts = yield* PromptsService
		const s = yield* Prompts.Spinner()
		s.start("Deploying all canisters...")
		const tasksWithPath = (yield* filterNodes(
			taskTree,
			(node) =>
				node._tag === "task" &&
				node.tags.includes(Tags.CANISTER) &&
				node.tags.includes(Tags.DEPLOY),
		)) as Array<{ node: Task; path: string[] }>
		// TODO: map cli args to task args here?
		const tasks = tasksWithPath.map(({ node }) => node)
		if (!tasks?.[0]) {
			return yield* Effect.fail(
				new TaskRuntimeError({
					message: "No deploy tasks found",
				}),
			)
		}
		// TODO: fix mode not found
		const argsMap = yield* resolveCliArgsMap(tasks[0], cliTaskArgs)
		const tasksWithArgs = tasks.map((task) => ({
			...task,
			args: argsMap,
		}))
		const { replica } = yield* TaskRuntime
		const iceDir = yield* IceDir
		const { config } = yield* ICEConfigService
		// TODO: use finalizer??
		yield* Effect.tryPromise({
			try: () =>
				replica.start({
					...globalArgs,
					network: config.network,
					iceDirPath: iceDir.path,
				}),
			catch: (e) => new ReplicaError({ message: String(e) }),
		})

		// TODO: FIX. call spinners from inside task/lib.ts ?
		yield* runTasks(tasksWithArgs, (update) => {
			if (update.status === "starting") {
				// const s = p.spinner()
				// s.start(`Deploying ${update.taskPath}\n`)
				// spinners.set(update.taskPath, s)
				// yield * Effect.logInfo(`Running ${update.taskPath}`)
				// s.message(`Running ${update.taskPath}`)
				// console.log(`Deploying ${update.taskPath}`)
			}
			if (update.status === "completed") {
				// const s = spinners.get(update.taskPath)
				// s?.stop(`Completed ${update.taskPath}\n`)
				// s.message(`Completed ${update.taskPath}`)
				// console.log(`Completed ${update.taskPath}`)
			}
		})

		// TODO: use finalizer??
		yield* Effect.tryPromise({
			try: () => replica.stop({ scope: "foreground" }),
			catch: (e) => new ReplicaError({ message: String(e) }),
		})

		const count = yield* Metric.value(totalTaskCount)
		const cachedCount = yield* Metric.value(cachedTaskCount)
		const uncachedCount = yield* Metric.value(uncachedTaskCount)
		const hitCount = yield* Metric.value(cacheHitCount)
		const inflightCount = yield* Metric.value(inflightTaskCount)
		const cancelledCount = yield* Metric.value(cancelledTaskCount)

		// TODO: ?? what is happening
		const spans = telemetryExporter.getFinishedSpans()
		const taskExecuteEffects = spans.filter(
			(span) => span.name === "task_execute_effect",
		)
		const uncachedTasks = taskExecuteEffects.filter(
			(span) => span.attributes?.["hasCaching"] === false,
		)
		const cachedTasks = taskExecuteEffects.filter(
			(span) => span.attributes?.["hasCaching"] === true,
		)
		const cacheHits = taskExecuteEffects.filter(
			(span) => span.attributes?.["cacheHit"] === true,
		)
		const cacheMisses = taskExecuteEffects.filter(
			(span) => span.attributes?.["cacheHit"] === false,
		)
		const revalidates = taskExecuteEffects.filter(
			(span) => span.attributes?.["revalidate"] === true,
		)
		const inflightTasks = taskExecuteEffects.filter(
			(span) => span.attributes?.["inflight"] === true,
		)
		const cancelledTasks = taskExecuteEffects.filter(
			(span) => span.attributes?.["cancelled"] === true,
		)
		const completedTasks = taskExecuteEffects.filter(
			(span) => span.attributes?.["cancelled"] === false,
		)
		// console.log("spans", spans)

		// TODO: get spans
		yield* Effect.logDebug(
			[
				"",
				"",
				"*** Task Metrics ***",
				"",
				`total: ${count.count}`,
				`cached: ${cachedCount.count}`,
				`uncached: ${uncachedCount.count}`,
				`cache hits: ${hitCount.count}`,
				`deduped inflight tasks: ${inflightCount.count}`,
				// `completed: ${completedTasks.count}`,
				`cancelled: ${cancelledCount.count}`,
				"",
				"************************",
				"",
				"",
				"*** Task Details ***",
				"",
				`uncached tasks:`,
				"",
				`${uncachedTasks.map((span) => span.attributes?.["taskPath"]).join(", ")}`,
				"",
				"",
				`cached tasks:`,
				"",
				`${cachedTasks.map((span) => span.attributes?.["taskPath"]).join(", ")}`,
				"",
				"",
				`cache hits:`,
				"",
				`${cacheHits.map((span) => span.attributes?.["taskPath"]).join(", ")}`,
				"",
				`cache misses:`,
				`${cacheMisses.map((span) => span.attributes?.["taskPath"]).join(", ")}`,
				"",
				"",
				`revalidates:`,
				"",
				`${revalidates.map((span) => span.attributes?.["taskPath"]).join(", ")}`,
				"",
				"",
				`deduped inflight tasks:`,
				"",
				`${inflightTasks.map((span) => span.attributes?.["taskPath"]).join(", ")}`,
				"",
				`cancelled tasks:`,
				"",
				`${cancelledTasks.map((span) => span.attributes?.["taskPath"]).join(", ")}`,
				"",
				"",
			].join("\n"),
		)
		s.stop("Deployed all canisters")
	})()
	// .pipe(
	// 	// TODO: Task has any as error type
	// 	Effect.tapError(e => Effect.logError(e satisfies never)),
	// )
	await makeFullRuntime({
		globalArgs,
		telemetryExporter,
	}).runPromise(program)
}

const canistersCreateCommand = defineCommand({
	meta: {
		name: "create",
		description: "Creates all canisters",
	},
	args: {
		...globalArgs,
	},
	run: async ({ args }) => {
		const globalArgs = getGlobalArgs("create")
		const { logLevel, background, policy, origin } = globalArgs

		const program = Effect.gen(function* () {
			const Prompts = yield* PromptsService
			const s = yield* Prompts.Spinner()
			s.start("Creating all canisters")

			yield* Effect.logDebug("Running canisters:create")
			const { tasks: taskTree } = yield* ICEConfigService
			const tasksWithPath = (yield* filterNodes(
				taskTree,
				(node) =>
					node._tag === "task" &&
					node.tags.includes(Tags.CANISTER) &&
					node.tags.includes(Tags.CREATE),
			)) as Array<{ node: Task; path: string[] }>
			const tasks = tasksWithPath.map(({ node }) => ({
				...node,
				args: {},
			}))
			const { replica } = yield* TaskRuntime
			const iceDir = yield* IceDir
			const { config } = yield* ICEConfigService
			// TODO: use finalizer??
			yield* Effect.tryPromise({
				try: () =>
					replica.start({
						...globalArgs,
						network: config.network,
						iceDirPath: iceDir.path,
					}),
				catch: (e) => new ReplicaError({ message: String(e) }),
			})
			yield* runTasks(tasks, (update) => {
				if (update.status === "starting") {
					s.message(`Running ${update.taskPath}`)
				}
				if (update.status === "completed") {
					s.message(`Completed ${update.taskPath}`)
				}
			})
			s.stop("Finished creating all canisters")
			yield* Effect.tryPromise({
				try: () => replica.stop({ scope: "foreground" }),
				catch: (e) => new ReplicaError({ message: String(e) }),
			})
		})

		// TODO: mode
		await makeFullRuntime({
			globalArgs: {
				logLevel,
				background,
				policy,
				origin,
			},
		}).runPromise(program)
	},
})

const canistersBuildCommand = defineCommand({
	meta: {
		name: "build",
		description: "Builds all canisters",
	},
	args: {
		...globalArgs,
	},
	run: async ({ args }) => {
		const globalArgs = getGlobalArgs("build")
		const { logLevel, background, policy, origin } = globalArgs

		const program = Effect.gen(function* () {
			const Prompts = yield* PromptsService
			const s = yield* Prompts.Spinner()
			s.start("Building all canisters")

			yield* Effect.logDebug("Running canisters:create")
			const { tasks: taskTree } = yield* ICEConfigService
			const tasksWithPath = (yield* filterNodes(
				taskTree,
				(node) =>
					node._tag === "task" &&
					node.tags.includes(Tags.CANISTER) &&
					node.tags.includes(Tags.CREATE),
			)) as Array<{ node: Task; path: string[] }>
			const tasks = tasksWithPath.map(({ node }) => ({
				...node,
				args: {},
			}))
			const { replica } = yield* TaskRuntime
			const iceDir = yield* IceDir
			const { config } = yield* ICEConfigService
			// TODO: use finalizer??
			yield* Effect.tryPromise({
				try: () =>
					replica.start({
						...globalArgs,
						network: config.network,
						iceDirPath: iceDir.path,
					}),
				catch: (e) => new ReplicaError({ message: String(e) }),
			})
			yield* runTasks(tasks, (update) => {
				if (update.status === "starting") {
					s.message(`Running ${update.taskPath}`)
				}
				if (update.status === "completed") {
					s.message(`Completed ${update.taskPath}`)
				}
			})
			s.stop("Finished building all canisters")
			yield* Effect.tryPromise({
				try: () => replica.stop({ scope: "foreground" }),
				catch: (e) => new ReplicaError({ message: String(e) }),
			})
		})

		await makeFullRuntime({
			globalArgs: {
				logLevel,
				background,
				policy,
				origin,
			},
		}).runPromise(program)
	},
})

const canistersBindingsCommand = defineCommand({
	meta: {
		name: "bindings",
		description: "Generates bindings for all canisters",
	},
	args: {
		...globalArgs,
	},
	run: async ({ args }) => {
		const globalArgs = getGlobalArgs("bindings")
		const { logLevel, background, policy, origin } = globalArgs

		const program = Effect.gen(function* () {
			const Prompts = yield* PromptsService
			const s = yield* Prompts.Spinner()
			s.start("Generating bindings for all canisters")

			yield* Effect.logDebug("Running canisters:bindings")
			const { tasks: taskTree } = yield* ICEConfigService
			const tasksWithPath = (yield* filterNodes(
				taskTree,
				(node) =>
					node._tag === "task" &&
					node.tags.includes(Tags.CANISTER) &&
					node.tags.includes(Tags.BINDINGS),
			)) as Array<{ node: Task; path: string[] }>
			const tasks = tasksWithPath.map(({ node }) => ({
				...node,
				args: {},
			}))
			// TODO: wrong. deps not deduplicated
			// need a runTasks
			yield* runTasks(tasks, (update) => {
				if (update.status === "starting") {
					s.message(`Running ${update.taskPath}`)
				}
				if (update.status === "completed") {
					s.message(`Completed ${update.taskPath}`)
				}
			})

			s.stop("Finished generating bindings for all canisters")
		})

		await makeFullRuntime({
			globalArgs: {
				logLevel,
				background,
				policy,
				origin,
			},
		}).runPromise(program)
	},
})

const canistersInstallCommand = defineCommand({
	meta: {
		name: "install",
		description: "Installs all canisters",
	},
	args: {
		...globalArgs,
	},
	run: async ({ args }) => {
		const globalArgs = getGlobalArgs("install")
		const { logLevel, background, policy, origin } = globalArgs

		const program = Effect.gen(function* () {
			const Prompts = yield* PromptsService
			const s = yield* Prompts.Spinner()
			s.start("Installing all canisters")

			yield* Effect.logDebug("Running canisters:create")
			const { tasks: taskTree } = yield* ICEConfigService
			const tasksWithPath = (yield* filterNodes(
				taskTree,
				(node) =>
					node._tag === "task" &&
					node.tags.includes(Tags.CANISTER) &&
					node.tags.includes(Tags.CREATE),
			)) as Array<{ node: Task; path: string[] }>
			const tasks = tasksWithPath.map(({ node }) => ({
				...node,
				args: {},
			}))
			const { replica } = yield* TaskRuntime
			const iceDir = yield* IceDir
			const { config } = yield* ICEConfigService
			// TODO: use finalizer??
			yield* Effect.tryPromise({
				try: () =>
					replica.start({
						...globalArgs,
						network: config.network,
						iceDirPath: iceDir.path,
					}),
				catch: (e) => new ReplicaError({ message: String(e) }),
			})
			yield* runTasks(tasks, (update) => {
				if (update.status === "starting") {
					s.message(`Running ${update.taskPath}`)
				}
				if (update.status === "completed") {
					s.message(`Completed ${update.taskPath}`)
				}
			})

			s.stop("Finished installing all canisters")
			yield* Effect.tryPromise({
				try: () => replica.stop({ scope: "foreground" }),
				catch: (e) => new ReplicaError({ message: String(e) }),
			})
		})

		// TODO: mode
		await makeFullRuntime({
			globalArgs: {
				policy,
				logLevel,
				background,
				origin,
			},
		}).runPromise(program)
	},
})

const cleanCommand = defineCommand({
	meta: {
		name: "clean",
		description: "Clean cache and state",
	},
	args: {
		...globalArgs,
	},
	run: async ({ args }) => {
		const globalArgs = getGlobalArgs("clean")
		const { logLevel, background, policy, origin } = globalArgs

		const program = Effect.gen(function* () {
			const Prompts = yield* PromptsService
			const s = yield* Prompts.Spinner()

			// TODO: more granular clean options
			s.start("Starting clean")
			yield* Effect.logDebug("Running clean")
			const iceDir = yield* IceDir
			const fs = yield* FileSystem.FileSystem
			yield* fs.remove(iceDir.path, { recursive: true })
			s.stop("Cleaned cache and state")
		})

		await makeMinimalRuntime({
			globalArgs: {
				logLevel,
				background,
				policy,
				origin,
			},
		}).runPromise(program)
	},
})

const canistersStopCommand = defineCommand({
	meta: {
		name: "stop",
		description: "Stops all canisters",
	},
	args: {
		...globalArgs,
	},
	run: async ({ args }) => {
		const globalArgs = getGlobalArgs("stop")
		const { logLevel, background, policy, origin } = globalArgs

		const program = Effect.gen(function* () {
			const Prompts = yield* PromptsService
			const s = yield* Prompts.Spinner()
			s.start("Stopping all canisters")

			yield* Effect.logDebug("Running canisters:stop")
			const { tasks: taskTree } = yield* ICEConfigService
			const tasksWithPath = (yield* filterNodes(
				taskTree,
				(node) =>
					node._tag === "task" &&
					node.tags.includes(Tags.CANISTER) &&
					node.tags.includes(Tags.STOP),
			)) as Array<{ node: Task; path: string[] }>
			const tasks = tasksWithPath.map(({ node }) => ({
				...node,
				args: {},
			}))
			const { replica } = yield* TaskRuntime
			const iceDir = yield* IceDir
			const { config } = yield* ICEConfigService
			// TODO: use finalizer??
			yield* Effect.tryPromise({
				try: () =>
					replica.start({
						...globalArgs,
						network: config.network,
						iceDirPath: iceDir.path,
					}),
				catch: (e) => new ReplicaError({ message: String(e) }),
			})
			yield* runTasks(tasks, (update) => {
				if (update.status === "starting") {
					s.message(`Running ${update.taskPath}`)
				}
				if (update.status === "completed") {
					s.message(`Completed ${update.taskPath}`)
				}
			})

			// // TODO: runTask?
			// yield* Effect.forEach(
			// 	Object.keys(canisterIdsMap),
			// 	(canisterId) =>
			// 		Effect.gen(function* () {
			// 			const {
			// 				roles: {
			// 					deployer: { identity },
			// 				},
			// 				replica,
			// 			} = yield* TaskCtx
			// 			yield* replica.stopCanister({
			// 				canisterId,
			// 				identity,
			// 			})
			// 		}),
			// 	{ concurrency: "unbounded" },
			// )

			// (update) => {
			// 				if (update.status === "starting") {
			// 					s.message(`Running ${update.taskPath}`)
			// 				}
			// 				if (update.status === "completed") {
			// 					s.message(`Completed ${update.taskPath}`)
			// 				}
			// 			}

			s.stop("Finished stopping all canisters")
			yield* Effect.tryPromise({
				try: () => replica.stop({ scope: "foreground" }),
				catch: (e) => new ReplicaError({ message: String(e) }),
			})
		})

		await makeFullRuntime({
			globalArgs: {
				logLevel,
				background,
				policy,
				origin,
			},
		}).runPromise(program)
	},
})

const canistersStatusTask = task("Check status of all canisters")
	.run(async ({ ctx }) => {
		const canisterIdsMap = await ctx.canisterIds.getCanisterIds()
		const identity = ctx.roles.deployer.identity

		const canisterStatuses = await Promise.all(
			Object.keys(canisterIdsMap).map(async (canisterName) => {
				const network = ctx.network || "local"
				const canisterInfo = canisterIdsMap[canisterName]
				const canisterId = canisterInfo?.[network]

				if (!canisterId) {
					return {
						canisterName,
						error: `No canister ID found for ${canisterName} on network ${network}`,
					}
				}

				try {
					const status = await ctx.replica.getCanisterInfo({
						canisterId,
						identity,
					})
					return { canisterName, canisterId, status }
				} catch (e) {
					return { canisterName, canisterId, error: String(e) }
				}
			}),
		)

		const statusLog = canisterStatuses
			.map((result) => {
				if ("error" in result) {
					return `Error for canister: ${result.error}`
				}
				const { status } = result

				if (status.status === CanisterStatus.NOT_FOUND) {
					return `Error for canister: Not Found`
				}

				let prettyStatus
				if (status.status === CanisterStatus.STOPPED) {
					prettyStatus = color.red(status.status)
				} else if (status.status === CanisterStatus.STOPPING) {
					prettyStatus = color.yellow(status.status)
				} else if (status.status === CanisterStatus.RUNNING) {
					prettyStatus = color.green(status.status)
					if (status.module_hash.length === 0) {
						prettyStatus = color.yellow("not installed")
					}
				}

				return `
${color.underline(result.canisterName)}
  ID: ${result.canisterId}
  Status: ${prettyStatus}
  Memory Size: ${status.memory_size.toLocaleString("en-US").replace(/,/g, "_")}
  Cycles: ${status.cycles.toLocaleString("en-US").replace(/,/g, "_")}
  Idle Cycles Burned Per Day: ${status.idle_cycles_burned_per_day.toLocaleString("en-US").replace(/,/g, "_")}
  Module Hash: ${moduleHashToHexString(status.module_hash)}`
			})
			.join("\n")

		console.log(statusLog)
		return statusLog
	})
	.make()

const canistersStatusCommand = defineCommand({
	meta: {
		name: "status",
		description: "Show the status of all canisters",
	},
	args: {
		canisterNameOrId: {
			type: "positional",
			required: false,
			description: "The name or ID of the canister to get the status of",
		},
		...globalArgs,
	},
	run: async ({ args }) => {
		// TODO: support canister name or ID
		if (args._.length === 0) {
			const globalArgs = getGlobalArgs("status")
			const { logLevel, background, policy, origin } = globalArgs

			const program = Effect.gen(function* () {
				const { replica } = yield* TaskRuntime
				const iceDir = yield* IceDir
				const { config } = yield* ICEConfigService
				// TODO: use finalizer??
				yield* Effect.tryPromise({
					try: () =>
						replica.start({
							...globalArgs,
							network: config.network,
							iceDirPath: iceDir.path,
						}),
					catch: (e) => new ReplicaError({ message: String(e) }),
				})

				// Inject the task into the tree so runTask can resolve its path
				const { tasks: taskTree } = yield* ICEConfigService
				taskTree["@@@__internal_status"] = canistersStatusTask
				yield* runTask(canistersStatusTask)
				delete taskTree["@@@__internal_status"]

				yield* Effect.tryPromise({
					try: () => replica.stop({ scope: "foreground" }),
					catch: (e) => new ReplicaError({ message: String(e) }),
				})
			})

			await makeFullRuntime({
				globalArgs: {
					policy,
					logLevel,
					background,
					origin,
				},
			}).runPromise(program)
		}
	},
})

const canistersRemoveCommand = defineCommand({
	meta: {
		name: "remove",
		description: "Removes all canisters",
	},
	args: {
		...globalArgs,
	},
	run: async ({ args }) => {
		const globalArgs = getGlobalArgs("remove")
		const { logLevel, background, policy, origin } = globalArgs
		await makeFullRuntime({
			globalArgs: {
				policy,
				logLevel,
				background,
				origin,
			},
		}).runPromise(
			Effect.gen(function* () {
				yield* Effect.logInfo("Coming soon...")
			}),
		)
	},
})

// const uiCommand = defineCommand({
// 	meta: {
// 		name: "ui",
// 		description: "Opens the experimental ICE terminal UI",
// 	},
// 	run: async ({ args }) => {
// 		const globalArgs = getGlobalArgs("ui")
// 		const { network, logLevel } = globalArgs
// 		await makeRuntime({
// 			globalArgs: {
// 				network: "local",
// 				logLevel: "debug",
// 			},
// 		}).runPromise(
// 			Effect.gen(function* () {
// 				const { config, taskTree } = yield* ICEConfigService
// 				yield* uiTask({ config, taskTree })
// 			}),
// 		)
// 	},
// })

// TODO: convert to ICE tasks

// const deployRunTask = {
//   ...task("Deploy all canisters")
//     .params({
//       // network: {
//       // },
//     })
//     .make(),
//   effect: Effect.gen(function* () {
//     const { runTask } = yield* TaskCtx;
// 	const { taskTree } = yield* ICEConfigService
// 	const tasksWithPath = yield* filterNodes(
// 		taskTree,
// 		(node) => node._tag === "task" && node.tags.includes(Tags.CANISTER) && node.tags.includes(Tags.DEPLOY)
// 	)
// 	const tasks = tasksWithPath.map(({ node }) => node)
// 	yield* Effect.all(tasks.map((task) => runTask(task, {})))
//   }),
// };

const canistersDeployCommand = defineCommand({
	meta: {
		name: "deploy",
		description: "Deploys all canisters",
	},
	args: {
		...globalArgs,
	},
	run: async ({ args, rawArgs }) => {
		const globalArgs = getGlobalArgs("deploy")
		const { logLevel, background, policy, origin } = globalArgs
		const taskArgs = rawArgs.slice(1)
		const parsedArgs = mri(taskArgs)
		const namedArgs = Object.fromEntries(
			Object.entries(parsedArgs).filter(([name]) => name !== "_"),
		)
		const positionalArgs = parsedArgs._
		const mode = namedArgs["mode"] as string | undefined
		const cliTaskArgs = {
			positionalArgs,
			namedArgs,
		}
		await deployRun({
			logLevel,
			background,
			policy,
			origin,
			cliTaskArgs,
		})
	},
})

const canisterCommand = defineCommand({
	meta: {
		name: "canister",
		description:
			"Select a specific canister to run a task on. install, build, deploy, etc.",
	},
	args: {
		...globalArgs,
	},
	run: async ({ args }) => {
		if (args._.length === 0) {
			const globalArgs = getGlobalArgs("canister")
			const { logLevel, background, policy, origin } = globalArgs
			const cliTaskArgs = {
				positionalArgs: [],
				namedArgs: {},
			}

			const program = Effect.gen(function* () {
				const { tasks: taskTree } = yield* ICEConfigService
				const canisterScopesWithPath = yield* filterNodes(
					taskTree,
					(node) =>
						node._tag === "scope" &&
						node.tags.includes(Tags.CANISTER),
				)

				// TODO: format nicely
				const canisterList = canisterScopesWithPath.map(
					({ node, path }) => {
						const scopePath = path.join(":") // Use colon to represent hierarchy
						return `  ${scopePath}` // Indent for better readability
					},
				)
				const canister = (yield* Effect.tryPromise(() =>
					p.select({
						message: "Select a canister",
						options: canisterList.map((canister) => ({
							value: canister,
							// TODO: add a status marker to the canister
							label: canister,
						})),
					}),
				)) as string
				if (isCancel(canister)) {
					cancel("Operation cancelled.")
					process.exit(0)
				}
				if (!canister) {
					return
				}
				const action = (yield* Effect.tryPromise(() =>
					p.select({
						message: "Select an action",
						options: [
							{ value: "deploy", label: "Deploy" },
							{ value: "create", label: "Create" },
							{ value: "build", label: "Build" },
							{ value: "bindings", label: "Bindings" },
							{ value: "install", label: "Install" },
							{ value: "status", label: "Status" },
							{ value: "stop", label: "Stop" },
							{ value: "remove", label: "Remove" },
						],
					}),
				)) as string
				if (isCancel(action)) {
					cancel("Operation cancelled.")
					process.exit(0)
				}
				const Prompts = yield* PromptsService
				const s = yield* Prompts.Spinner()
				const { replica } = yield* TaskRuntime
				const iceDir = yield* IceDir
				const { config } = yield* ICEConfigService
				// TODO: use finalizer??
				yield* Effect.tryPromise({
					try: () =>
						replica.start({
							...globalArgs,
							network: config.network,
							iceDirPath: iceDir.path,
						}),
					catch: (e) => new ReplicaError({ message: String(e) }),
				})
				s.start(`Running ${canister}:${action}`)
				const result = yield* runTaskByPath(
					`${canister.trimStart().trimEnd()}:${action.trimStart().trimEnd()}`,
					// TODO: args?
					cliTaskArgs,
					(update) => {
						if (update.status === "starting") {
							s.message(`Running ${update.taskPath}`)
						}
						if (update.status === "completed") {
							s.message(`Completed ${update.taskPath}`)
						}
					},
				)
				s.stop(`Completed ${canister}:${action}`)
				yield* Effect.tryPromise({
					try: () => replica.stop({ scope: "foreground" }),
					catch: (e) => new ReplicaError({ message: String(e) }),
				})
			})

			await makeFullRuntime({
				globalArgs: {
					policy,
					logLevel,
					background,
					origin,
				},
			}).runPromise(program)
		}
	},
	subCommands: {
		deploy: canistersDeployCommand,
		create: canistersCreateCommand,
		build: canistersBuildCommand,
		bindings: canistersBindingsCommand,
		stop: canistersStopCommand,
		install: canistersInstallCommand,
		// TODO:
		// status: canistersStatusCommand,
		remove: canistersRemoveCommand,
	},
})

const taskCommand = defineCommand({
	meta: {
		name: "task",
		description: `Select and run a task from the available tasks`,
	},
	args: {
		...globalArgs,
	},
	run: async ({ args }) => {
		if (args._.length === 0) {
			const globalArgs = getGlobalArgs("task")
			const { logLevel, background, policy, origin } = globalArgs
			const cliTaskArgs = {
				positionalArgs: [],
				namedArgs: {},
			}

			const program = Effect.gen(function* () {
				const { tasks: taskTree } = yield* ICEConfigService
				const tasksWithPath = yield* filterNodes(
					taskTree,
					(node) =>
						node._tag === "task" &&
						!node.tags.includes(Tags.CANISTER),
				)
				// TODO: format nicely
				const taskList = tasksWithPath.map(({ node: task, path }) => {
					const taskPath = path.join(":") // Use colon to represent hierarchy
					return `  ${taskPath}` // Indent for better readability
				})
				const task = (yield* Effect.tryPromise(() =>
					p.select({
						message: "Select a task",
						options: taskList.map((task) => ({
							value: task,
							label: task,
						})),
					}),
				)) as string
				if (isCancel(task)) {
					cancel("Operation cancelled.")
					process.exit(0)
				}
				const Prompts = yield* PromptsService
				const s = yield* Prompts.Spinner()
				const { replica } = yield* TaskRuntime
				const iceDir = yield* IceDir
				const { config } = yield* ICEConfigService
				// TODO: use finalizer??
				yield* Effect.tryPromise({
					try: () =>
						replica.start({
							...globalArgs,
							network: config.network,
							iceDirPath: iceDir.path,
						}),
					catch: (e) => new ReplicaError({ message: String(e) }),
				})
				s.start(`Running ${task}`)
				const result = yield* runTaskByPath(
					`${task.trimStart().trimEnd()}`,
					// TODO: args?
					cliTaskArgs,
					(update) => {
						if (update.status === "starting") {
							s.message(`Running ${update.taskPath}`)
						}
						if (update.status === "completed") {
							s.message(`Completed ${update.taskPath}`)
						}
					},
				)
				s.stop(`Completed ${task}`)
				yield* Effect.tryPromise({
					try: () => replica.stop({ scope: "foreground" }),
					catch: (e) => new ReplicaError({ message: String(e) }),
				})
			})

			await makeFullRuntime({
				globalArgs: {
					policy,
					logLevel,
					background,
					origin,
				},
			}).runPromise(program)
		}
	},
	subCommands: {},
})

const generateCommand = defineCommand({
	meta: {
		name: "generate",
		description: "Generate canisters",
	},
	run: async ({ args }) => {
		p.text({ message: "Coming soon..." })
		p.multiselect({
			message: "Select canisters to include",
			options: [
				{ value: "icrc1", label: "ICRC1" },
				{ value: "nns", label: "NNS" },
				{ value: "sns", label: "SNS" },
			],
		})
	},
})

const main = defineCommand({
	meta: {
		name: "ice",
		description: "ICE CLI",
	},
	args: {
		...globalArgs,
	},
	run: async ({ args, rawArgs }) => {
		const globalArgs = getGlobalArgs("ice")
		const taskArgs = rawArgs.slice(1)
		const parsedArgs = mri(taskArgs)
		const namedArgs = Object.fromEntries(
			Object.entries(parsedArgs).filter(([name]) => name !== "_"),
		)
		const positionalArgs = parsedArgs._
		const mode = namedArgs["mode"] as string | undefined
		const { logLevel, background, policy, origin } = globalArgs
		const cliTaskArgs = {
			positionalArgs,
			namedArgs,
		}

		if (args._.length === 0) {
			await deployRun({
				logLevel,
				background,
				policy,
				cliTaskArgs,
				origin,
			})
			// await deployRun(globalArgs)
		}
	},
	subCommands: {
		run: runCommand,
		task: taskCommand,
		canister: canisterCommand,
		status: canistersStatusCommand,
		stop: stopCommand,
		clean: cleanCommand,
		// ls: listCommand,
		// init: initCommand,
		// g: generateCommand,
		// ui: uiCommand,
		// w: watchCommand,
	},
})

// TODO: can we load the iceConfig before running the cli?
// Prepare and run the CLI application
export const runCli = async () => {
	// TODO: not in npm?
	// const completion = await tab(main);
	p.intro(`${color.bgCyan(color.black(" ICE CLI "))}`)
	p.updateSettings({
		aliases: {
			w: "up",
			s: "down",
			a: "left",
			d: "right",
			j: "down",
			k: "up",
			h: "left",
			l: "right",
		},
	})
	const cli = createMain(main)
	cli()
}
