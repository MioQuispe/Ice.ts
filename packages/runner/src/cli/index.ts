import * as p from "@clack/prompts"
import { cancel, isCancel } from "@clack/prompts"
import { Ed25519KeyIdentity } from "@dfinity/identity"
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
import { CanisterStatus, DefaultReplica } from "../services/replica.js"
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
import { DfxReplica } from "../services/dfx.js"
import { Moc } from "../services/moc.js"
import { picReplicaImpl } from "../services/pic/pic.js"
import { TaskRegistry } from "../services/taskRegistry.js"
import type { ICEConfig, ICECtx } from "../types/types.js"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import type { Scope, TaskTree } from "../types/types.js"
export { Opt } from "../types/types.js"
import { makeTaskLayer, TaskRuntime } from "../services/taskRuntime.js"
import { InFlight } from "../services/inFlight.js"
import { IceDir } from "../services/iceDir.js"
import { runTask, runTasks } from "../tasks/run.js"
import { configLayer } from "../services/config.js"
import {
	makeTelemetryLayer,
	TelemetryConfig,
} from "../services/telemetryConfig.js"
import { DeploymentsService } from "../services/deployments.js"
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
	const { taskTree } = yield* ICEConfigService
	const task = yield* findTaskInTaskTree(taskTree, taskPathSegments)
	const argsMap = yield* resolveCliArgsMap(task, cliTaskArgs)
	yield* Effect.logDebug("Task found", taskPath)
	return yield* runTask(task, argsMap, progressCb).pipe(
		Effect.annotateLogs("caller", "runTaskByPath"),
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
				arg ? param.parse(arg) : undefined,
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
				arg ? param.parse(arg) : undefined,
			)
			argsMap[param.name] = resolvedArg
		}

		return argsMap
	})

const GlobalArgs = type({
	network: "string" as const,
	logLevel: "'debug' | 'info' | 'error'",
}) satisfies StandardSchemaV1<Record<string, unknown>>

const logLevelMap = {
	debug: LogLevel.Debug,
	info: LogLevel.Info,
	error: LogLevel.Error,
}

type MakeCliRuntimeArgs = {
	globalArgs: { network: string; logLevel: string }
	// fix type
}

export const makeCliRuntime = ({
	globalArgs: rawGlobalArgs,
}: MakeCliRuntimeArgs) => {
	const globalArgs = GlobalArgs(rawGlobalArgs)
	if (globalArgs instanceof type.errors) {
		throw new Error(globalArgs.summary)
	}

	const DfxReplicaService = DfxReplica.pipe(Layer.provide(NodeContext.layer))

	const DefaultReplicaService = Layer.effect(
		DefaultReplica,
		picReplicaImpl,
	).pipe(Layer.provide(NodeContext.layer))

	// const DefaultsLayer = Layer
	// 	.mergeAll
	// 	()
	const ICEConfigLayer = ICEConfigService.Live({
		network: globalArgs.network,
		logLevel: logLevelMap[globalArgs.logLevel],
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
	// const TaskRuntimeLayer = TaskRuntimeLive()

	const TaskRegistryLayer = TaskRegistry.Live.pipe(
		Layer.provide(KVStorageLayer),
	)

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

	const DefaultConfigLayer = DefaultConfig.Live.pipe(
		Layer.provide(DefaultReplicaService),
	)
	const CanisterIdsLayer = CanisterIdsService.Live.pipe(
		Layer.provide(NodeContext.layer),
		Layer.provide(IceDirLayer),
	)
	const cliLayer = Layer.mergeAll(
		DefaultConfigLayer,
		TaskRegistry.Live.pipe(
			Layer.provide(NodeContext.layer),
			Layer.provide(KVStorageLayer),
		),
		// TaskRuntimeLayer.pipe(
		// 	Layer.provide(NodeContext.layer),
		// 	Layer.provide(IceDirLayer),
		// 	Layer.provide(CanisterIdsLayer),
		// 	Layer.provide(ICEConfigLayer),
		// 	Layer.provide(telemetryConfigLayer),
		// 	Layer.provide(KVStorageLayer),
		// 	Layer.provide(InFlightLayer),
		// 	Layer.provide(DeploymentsLayer),
		// 	Layer.provide(TaskRegistryLayer),
		// ),
		TaskRegistryLayer,
		DeploymentsLayer,
		InFlightLayer,
		IceDirLayer,
		DefaultReplicaService,
		Moc.Live.pipe(Layer.provide(NodeContext.layer)),
		Logger.pretty,
		Logger.minimumLogLevel(logLevelMap[globalArgs.logLevel]),
		CanisterIdsLayer,
		configLayer,
		KVStorageLayer,
		NodeContext.layer,
		ICEConfigLayer,
		telemetryLayer,
		telemetryConfigLayer,
		// 	DevTools.layerWebSocket().pipe(
		//      Layer.provide(NodeSocket.layerWebSocketConstructor),
		// ),
	)
	return ManagedRuntime.make(cliLayer)

	// return ManagedRuntime.make(
	// 	Layer.provideMerge(
	// 		Layer.mergeAll(
	// 			TaskRuntimeLayer,
	// 			TaskRegistry.Live,
	// 			DefaultReplicaService,
	// 			DefaultConfig.Live.pipe(Layer.provide(DefaultReplicaService)),
	// 			Moc.Live,
	// 			Logger.pretty,
	// 			Logger.minimumLogLevel(logLevelMap[globalArgs.logLevel]),
	// 			IceDirLayer,
	// 		),
	// 		Layer.mergeAll(
	// 			Layer.provideMerge(
	// 				Layer.mergeAll(
	// 					CanisterIdsService.Live.pipe(
	// 						Layer.provide(configLayer),
	// 						Layer.provide(NodeContext.layer),
	// 					),
	// 					KVStorageLayer,
	// 					NodeContext.layer,
	// 					ICEConfigLayer,
	// 					telemetryConfigLayer,
	// 					telemetryLayer,
	// 					// ParentTaskCtxLayer
	// 				),
	// 				Layer.mergeAll(IceDirLayer, InFlightLayer, configLayer),
	// 			),
	// 		),
	// 	),
	// )
}

function moduleHashToHexString(moduleHash: [] | [number[]]): string {
	if (moduleHash.length === 0) {
		return "Not Present"
	}
	const bytes = new Uint8Array(moduleHash[0]) // Ensure it's a Uint8Array
	const hexString = Buffer.from(bytes).toString("hex")
	return `0x${hexString}`
}

const getGlobalArgs = (
	cmdName: string,
): { network: string; logLevel: string } => {
	const runIndex = process.argv.indexOf(cmdName)
	// TODO: simplify this
	if (runIndex === -1) {
		// just ice command
		const argv = mri(process.argv.slice(2, 3), {
			string: ["logLevel", "network"],
		})
		return {
			network: argv?.["network"] ?? "local",
			logLevel: argv?.["logLevel"] ?? "info",
		}
	}
	const argv = mri(process.argv.slice(2, runIndex + 2), {
		string: ["logLevel", "network"],
	})
	const globalArgs = {
		network: argv?.["network"] ?? "local",
		logLevel: argv?.["logLevel"] ?? "info",
	}
	return globalArgs
}

const globalArgs = {
	network: {
		type: "string",
		required: false,
		// TODO: hmm?
		default: "local",
		// TODO: better description
		description: "Select a network",
	},
	logLevel: {
		type: "string",
		required: false,
		default: "info",
		description: "Select a log level",
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
		const s = p.spinner()
		s.start(
			`Running task... ${color.green(color.underline(args.taskPath))}`,
		)
		const cliTaskArgs = {
			positionalArgs,
			namedArgs,
		}
		await makeCliRuntime({
			globalArgs,
		}).runPromise(
			Effect.gen(function* () {
				const { runtime, taskLayer } = yield* makeTaskLayer()
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime,
					taskLayer,
				})
				yield* runTaskByPath(args.taskPath, cliTaskArgs).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.tap((result) =>
						Effect.gen(function* () {
							const count = yield* Metric.value(totalTaskCount)
							const cachedCount =
								yield* Metric.value(cachedTaskCount)
							const uncachedCount =
								yield* Metric.value(uncachedTaskCount)
							const hitCount = yield* Metric.value(cacheHitCount)
							console.log(
								"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! task metrics:",
								"total:",
								count,
								"cached:",
								cachedCount,
								"uncached:",
								uncachedCount,
								"cache hits:",
								hitCount,
								"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
							)
						}),
					),
				)
			}),
		)
		s.stop(`Finished task: ${color.green(color.underline(args.taskPath))}`)
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
	network,
	logLevel,
	cliTaskArgs,
}: {
	network: string
	logLevel: string
	cliTaskArgs: {
		positionalArgs: string[]
		namedArgs: Record<string, string>
	}
}) => {
	const s = p.spinner()
	s.start("Deploying all canisters...")
	// TODO: mode
	const globalArgs = {
		network,
		logLevel,
	}
	// TODO: convert to task
	const program = Effect.fn("deploy")(function* () {
		const { taskTree } = yield* ICEConfigService
		const { runtime, taskLayer } = yield* makeTaskLayer()
		const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
			runtime,
			taskLayer,
		})
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

		yield* runTasks(tasksWithArgs, (update) => {
			if (update.status === "starting") {
				// const s = p.spinner()
				// s.start(`Deploying ${update.taskPath}\n`)
				// spinners.set(update.taskPath, s)
				s.message(`Running ${update.taskPath}`)
				// console.log(`Deploying ${update.taskPath}`)
			}
			if (update.status === "completed") {
				// const s = spinners.get(update.taskPath)
				// s?.stop(`Completed ${update.taskPath}\n`)
				s.message(`Completed ${update.taskPath}`)
				// console.log(`Completed ${update.taskPath}`)
			}
		}).pipe(
			Effect.provide(ChildTaskRuntimeLayer),
			Effect.annotateLogs("caller", "deployRun"),
		)

		const count = yield* Metric.value(totalTaskCount)
		const cachedCount = yield* Metric.value(cachedTaskCount)
		const uncachedCount = yield* Metric.value(uncachedTaskCount)
		const hitCount = yield* Metric.value(cacheHitCount)
		console.log(
			"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! task metrics:",
			"total:",
			count.count,
			"cached:",
			cachedCount.count,
			"uncached:",
			uncachedCount.count,
			"cache hits:",
			hitCount.count,
			"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
		)
	})()
	// .pipe(
	// 	// TODO: Task has any as error type
	// 	Effect.tapError(e => Effect.logError(e satisfies never)),
	// )
	await makeCliRuntime({
		globalArgs,
	}).runPromise(program)
	s.stop("Deployed all canisters")
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
		const { network, logLevel } = globalArgs
		// TODO: mode
		await makeCliRuntime({
			globalArgs: {
				network,
				logLevel,
			},
		}).runPromise(
			Effect.gen(function* () {
				const { runtime, taskLayer } = yield* makeTaskLayer()
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime,
					taskLayer,
				})
				const s = p.spinner()
				s.start("Creating all canisters")

				yield* Effect.logDebug("Running canisters:create")
				const { taskTree } = yield* ICEConfigService
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
				yield* runTasks(tasks, (update) => {
					if (update.status === "starting") {
						s.message(`Running ${update.taskPath}`)
					}
					if (update.status === "completed") {
						s.message(`Completed ${update.taskPath}`)
					}
				}).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.annotateLogs("caller", "canistersCreateCommand"),
				)
				s.stop("Finished creating all canisters")
			}),
		)
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
		const { network, logLevel } = globalArgs
		await makeCliRuntime({
			globalArgs: {
				network,
				logLevel,
			},
		}).runPromise(
			Effect.gen(function* () {
				const s = p.spinner()
				s.start("Building all canisters")

				yield* Effect.logDebug("Running canisters:create")
				const { taskTree } = yield* ICEConfigService
				const { runtime, taskLayer } = yield* makeTaskLayer()
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime,
					taskLayer,
				})
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
				yield* runTasks(tasks, (update) => {
					if (update.status === "starting") {
						s.message(`Running ${update.taskPath}`)
					}
					if (update.status === "completed") {
						s.message(`Completed ${update.taskPath}`)
					}
				}).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.annotateLogs("caller", "canistersBuildCommand"),
				)
				s.stop("Finished building all canisters")
			}),
		)
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
		const { network, logLevel } = globalArgs
		await makeCliRuntime({
			globalArgs: {
				network,
				logLevel,
			},
		}).runPromise(
			Effect.gen(function* () {
				const s = p.spinner()
				s.start("Generating bindings for all canisters")

				yield* Effect.logDebug("Running canisters:bindings")
				const { taskTree } = yield* ICEConfigService
				const { runtime, taskLayer } = yield* makeTaskLayer()
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime,
					taskLayer,
				})
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
				}).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.annotateLogs("caller", "canistersBindingsCommand"),
				)

				s.stop("Finished generating bindings for all canisters")
			}),
		)
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
		const { network, logLevel } = globalArgs
		// TODO: mode
		await makeCliRuntime({
			globalArgs: {
				network,
				logLevel,
			},
		}).runPromise(
			Effect.gen(function* () {
				const s = p.spinner()
				s.start("Installing all canisters")

				yield* Effect.logDebug("Running canisters:create")
				const { taskTree } = yield* ICEConfigService
				const { runtime, taskLayer } = yield* makeTaskLayer()
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime,
					taskLayer,
				})
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
				yield* runTasks(tasks, (update) => {
					if (update.status === "starting") {
						s.message(`Running ${update.taskPath}`)
					}
					if (update.status === "completed") {
						s.message(`Completed ${update.taskPath}`)
					}
				}).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.annotateLogs("caller", "canistersInstallCommand"),
				)

				s.stop("Finished installing all canisters")
			}),
		)
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
		const { network, logLevel } = globalArgs
		await makeCliRuntime({
			globalArgs: {
				network,
				logLevel,
			},
		}).runPromise(
			Effect.gen(function* () {
				const s = p.spinner()
				s.start("Stopping all canisters")

				yield* Effect.logDebug("Running canisters:stop")
				const { taskTree } = yield* ICEConfigService
				const { runtime } = yield* makeTaskLayer()
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
				runTasks(tasks, (update) => {
					if (update.status === "starting") {
						s.message(`Running ${update.taskPath}`)
					}
					if (update.status === "completed") {
						s.message(`Completed ${update.taskPath}`)
					}
				}).pipe(Effect.annotateLogs("caller", "canistersStopCommand"))

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
			}),
		)
	},
})

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
			const { network, logLevel } = globalArgs
			await makeCliRuntime({
				globalArgs: {
					network,
					logLevel,
				},
			}).runPromise(
				Effect.gen(function* () {
					const canisterIdsService = yield* CanisterIdsService
					const canisterIdsMap =
						yield* canisterIdsService.getCanisterIds()
					const replica = yield* DefaultReplica
					const identity = Ed25519KeyIdentity.generate()
					const canisterStatusesEffects = Object.keys(
						canisterIdsMap,
					).map((canisterName) =>
						Effect.either(
							Effect.gen(function* () {
								// TODO: currentNetwork
								const network = "local"
								const canisterInfo =
									canisterIdsMap[canisterName]
								const canisterId = canisterInfo?.[network]
								if (!canisterId) {
									return yield* Effect.fail(
										new DeploymentError({
											message: `No canister ID found for ${canisterName} on network ${network}`,
										}),
									)
								}
								const status = yield* replica.getCanisterInfo({
									canisterId,
									identity,
								})
								return { canisterName, canisterId, status }
							}),
						),
					)

					const canisterStatuses = yield* Effect.all(
						canisterStatusesEffects,
						{
							concurrency: "unbounded",
						},
					)

					// TODO: this needs to run as a task
					// TODO: inline
					const statusLog = canisterStatuses
						.map((result) =>
							Either.match(result, {
								onLeft: (left) => `Error for canister: ${left}`,
								onRight: (right) =>
									right.status.status !==
									CanisterStatus.NOT_FOUND
										? `
${color.underline(right.canisterName)}
  ID: ${right.canisterId}
  Status: ${color.green(Object.keys(right.status.status)[0])}
  Memory Size: ${right.status.memory_size.toLocaleString("en-US").replace(/,/g, "_")}
  Cycles: ${right.status.cycles.toLocaleString("en-US").replace(/,/g, "_")}
  Idle Cycles Burned Per Day: ${right.status.idle_cycles_burned_per_day.toLocaleString("en-US").replace(/,/g, "_")}
  Module Hash: ${moduleHashToHexString(right.status.module_hash)}`
										: // TODO: fix?
											`Error for canister: ${result._tag}`,
							}),
						)
						.join("\n")
					// 							result._tag === "Right" && result.right.status.status !== CanisterStatus.NOT_FOUND
					// 								? `
					// ${color.underline(result.right.canisterName)}
					//   ID: ${result.right.canisterId}
					//   Status: ${color.green(Object.keys(result.right.status.status)[0])}
					//   Memory Size: ${result.right.status.memory_size.toLocaleString("en-US").replace(/,/g, "_")}
					//   Cycles: ${result.right.status.cycles.toLocaleString("en-US").replace(/,/g, "_")}
					//   Idle Cycles Burned Per Day: ${result.right.status.idle_cycles_burned_per_day.toLocaleString("en-US").replace(/,/g, "_")}
					//   Module Hash: ${moduleHashToHexString(result.right.status.module_hash)}`
					// 								: `Error for canister: ${result._tag}`,
					// 						)
					// 						.join("\n")

					console.log(statusLog)
				}),
			)
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
		const { network, logLevel } = globalArgs
		await makeCliRuntime({
			globalArgs: {
				network,
				logLevel,
			},
		}).runPromise(
			Effect.gen(function* () {
				yield* Console.log("Coming soon...")
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
		const { network, logLevel } = globalArgs
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
			network,
			logLevel,
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
			const { network, logLevel } = globalArgs
			const cliTaskArgs = {
				positionalArgs: [],
				namedArgs: {},
			}
			await makeCliRuntime({
				globalArgs: {
					network,
					logLevel,
				},
			}).runPromise(
				Effect.gen(function* () {
					const { taskTree } = yield* ICEConfigService
					const { runtime, taskLayer } = yield* makeTaskLayer()
					const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
						runtime,
						taskLayer,
					})
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
					const s = p.spinner()
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
					).pipe(
						Effect.provide(ChildTaskRuntimeLayer),
						Effect.annotateLogs(
							"caller",
							"canistersCanisterCommand",
						),
					)
					s.stop(`Completed ${canister}:${action}`)
				}),
			)
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
			const { network, logLevel } = globalArgs
			const cliTaskArgs = {
				positionalArgs: [],
				namedArgs: {},
			}
			await makeCliRuntime({
				globalArgs: {
					network,
					logLevel,
				},
			}).runPromise(
				Effect.gen(function* () {
					const { taskTree } = yield* ICEConfigService
					const { runtime, taskLayer } = yield* makeTaskLayer()
					const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
						runtime,
						taskLayer,
					})
					const tasksWithPath = yield* filterNodes(
						taskTree,
						(node) =>
							node._tag === "task" &&
							!node.tags.includes(Tags.CANISTER),
					)
					// TODO: format nicely
					const taskList = tasksWithPath.map(
						({ node: task, path }) => {
							const taskPath = path.join(":") // Use colon to represent hierarchy
							return `  ${taskPath}` // Indent for better readability
						},
					)
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
					const s = p.spinner()
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
					).pipe(
						Effect.provide(ChildTaskRuntimeLayer),
						Effect.annotateLogs("caller", "canistersTaskCommand"),
					)
					s.stop(`Completed ${task}`)
				}),
			)
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
		const { network, logLevel } = globalArgs
		const cliTaskArgs = {
			positionalArgs,
			namedArgs,
		}

		if (args._.length === 0) {
			await deployRun({ network, logLevel, cliTaskArgs })
			// await deployRun(globalArgs)
		}
	},
	subCommands: {
		run: runCommand,
		// ls: listCommand,
		task: taskCommand,
		canister: canisterCommand,
		// init: initCommand,
		// g: generateCommand,
		status: canistersStatusCommand,
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
