import type { SignIdentity } from "@dfinity/agent"
import {
	Config,
	ConfigError,
	Context,
	Effect,
	Layer,
	Logger,
	ManagedRuntime,
	Option,
} from "effect"
import { type ReplicaService } from "../services/replica.js"
import {
	CanisterIds,
	ProgressUpdate,
	TaskParamsToArgs,
	TaskRuntimeError,
	TaskSuccess,
} from "../tasks/lib.js"
import type { ICEUser, Task, TaskTree } from "../types/types.js"
import { DefaultConfig, InitializedDefaultConfig } from "./defaultConfig.js"
import { ICEConfigService } from "./iceConfig.js"
import { TaskRuntime } from "./taskRuntime.js"
import { runTask } from "../tasks/run.js"
import { IceDir } from "./iceDir.js"
import { Deployment, DeploymentsService } from "./deployments.js"
import { CanisterIdsService } from "./canisterIds.js"

export interface TaskCtxShape<A extends Record<string, unknown> = {}> {
	readonly taskTree: TaskTree
	readonly users: {
		[name: string]: {
			identity: SignIdentity
			// agent: HttpAgent
			principal: string
			accountId: string
			// TODO: neurons?
		}
	}
	readonly roles: {
		deployer: ICEUser
		minter: ICEUser
		controller: ICEUser
		treasury: ICEUser
		[name: string]: {
			identity: SignIdentity
			principal: string
			accountId: string
		}
	}
	readonly replica: ReplicaService

	readonly runTask: {
		<T extends Task>(task: T): Promise<TaskSuccess<T>>
		<T extends Task>(
			task: T,
			args: TaskParamsToArgs<T>,
		): Promise<TaskSuccess<T>>
	}

	readonly currentNetwork: string
	readonly networks: {
		[key: string]: {
			replica: ReplicaService
			host: string
			port: number
			// subnet: Subnet?
		}
	}
	readonly args: A
	readonly taskPath: string
	readonly appDir: string
	readonly iceDir: string
	readonly depResults: Record<
		string,
		{
			cacheKey: string | undefined
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
			deployment: Deployment
		}) => Promise<void>
	}
	canisterIds: {
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
}

export const makeTaskCtx = Effect.fn("taskCtx_make")(function* (
	taskPath: string,
	task: Task,
	argsMap: Record<string, unknown>,
	depResults: Record<
		string,
		{
			cacheKey: string | undefined
			result: unknown
		}
	>,
	progressCb: (update: ProgressUpdate<unknown>) => void,
) {
	const { runtime } = yield* TaskRuntime
	const defaultConfig = yield* DefaultConfig
	const appDir = yield* Config.string("APP_DIR")
	const { path: iceDir } = yield* IceDir
	const { config, globalArgs } = yield* ICEConfigService
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
	for (const [name, user] of Object.entries(config?.roles ?? {})) {
		if (!currentUsers[user]) {
			return yield* Effect.fail(
				new TaskRuntimeError({
					message: `User ${user} not found in current users`,
				}),
			)
		}
		initializedRoles[name] = currentUsers[user]
	}
	const resolvedRoles: {
		[key: string]: ICEUser
	} & InitializedDefaultConfig["roles"] = {
		...defaultConfig.roles,
		...initializedRoles,
	}
	const iceConfigService = yield* ICEConfigService
	const { taskTree } = iceConfigService

	// TODO: telemetry
	// Pass down the same runtime to the child task
	const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
		runtime,
	})
	const Deployments = yield* DeploymentsService
	const CanisterIds = yield* CanisterIdsService
	return {
		...defaultConfig,
		taskPath,
		// TODO: add caching?
		// TODO: wrap with proxy?
		// TODO: needs to use same runtime
		// runTask: asyncRunTask,
		runTask: async <T extends Task>(
			task: T,
			args?: TaskParamsToArgs<T>,
		): Promise<TaskSuccess<T>> => {
			const result = await runtime.runPromise(
				runTask(task, args, progressCb).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.annotateLogs("caller", "taskCtx.runTask"),
					Effect.annotateLogs("taskPath", taskPath),
				),
			)
			return result
		},
		replica: currentReplica,
		taskTree,
		currentNetwork,
		networks,
		users: {
			...defaultConfig.users,
			...currentUsers,
		},
		roles: resolvedRoles,
		args: argsMap,
		depResults,
		appDir,
		iceDir,
		deployments: {
			get: async (canisterName, network) => {
				const result = await runtime.runPromise(
					Deployments.get(canisterName, network),
				)
				return Option.isSome(result) ? result.value : undefined
			},
			set: async (params) => {
				await runtime.runPromise(Deployments.set(params))
			},
		},
		canisterIds: {
			getCanisterIds: async () => {
				const result = await runtime.runPromise(
					CanisterIds.getCanisterIds(),
				)
				return result
			},
			setCanisterId: async (params) => {
				await runtime.runPromise(CanisterIds.setCanisterId(params))
			},
			removeCanisterId: async (canisterName) => {
				await runtime.runPromise(
					CanisterIds.removeCanisterId(canisterName),
				)
			},
		},
	} satisfies TaskCtxShape
})
// static Test = {}
