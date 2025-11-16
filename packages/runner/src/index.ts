// import { customCanister } from "./builders/custom.js"
// import { motokoCanister } from "./builders/motoko.js"
import { SignIdentity } from "@icp-sdk/core/agent"
import type { ICEConfig, ICEGlobalArgs, ICEEnvironment } from "./types/types.js"
import type { Scope, TaskTree } from "./types/types.js"
import { TaskCtx } from "./services/taskRuntime.js"
export { Opt } from "./types/types.js"
export * from "./builders/index.js"
export type { CanisterScopeSimple } from "./builders/lib.js"
export type { CustomCanisterScope } from "./builders/custom.js"
export * from "./ids.js"
export type { InstallModes } from "./services/replica.js"
export { PICReplica } from "./services/pic/pic.js"
export { ICReplica } from "./services/ic-replica.js"

// Export additional types for user configs
export type { ICEConfig, ICEGlobalArgs, ICEEnvironment, TaskTree, Scope, Task } from "./types/types.js"

class IceBuilder<C extends Partial<ICEConfig>> {
	#configFn: (globalArgs: ICEGlobalArgs) => Promise<C> | C
	#tasksFn?: (env: C & ICEGlobalArgs) => TaskTree

	constructor(configFn: (globalArgs: ICEGlobalArgs) => Promise<C> | C) {
		this.#configFn = configFn
	}

	tasks(tasksFn: (env: C & ICEGlobalArgs) => TaskTree): IceBuilder<C> {
		this.#tasksFn = tasksFn
		return this
	}

	make(): (globalArgs: ICEGlobalArgs) => Promise<ICEEnvironment> {
		return async (globalArgs: ICEGlobalArgs): Promise<ICEEnvironment> => {
			// Resolve config (handles both sync and async)
			const configResult = this.#configFn(globalArgs)
			const config = configResult instanceof Promise 
				? await configResult 
				: configResult

			// Create env by merging config and globalArgs
			const env = { ...config, ...globalArgs } as C & ICEGlobalArgs

			// Resolve tasks
			const tasks = this.#tasksFn ? this.#tasksFn(env) : {}

			return { config, tasks }
		}
	}
}

export const Ice = <C extends Partial<ICEConfig>>(
	configFn: (globalArgs: ICEGlobalArgs) => Promise<C> | C
): IceBuilder<C> => {
	return new IceBuilder(configFn)
}
// const ice = Ice({
// 	users: {
// 		bla: {
// 			principal: "bla",
// 			accountId: "bla",
// 			identity: {} as SignIdentity,
// 		},
// 	},
// })

// const t = ice.customCanister(ctx => ({
// 	wasm: "bla.wasm",
// 	candid: "bla.did",
// })).installArgs(ctx => [])

// ice.test

// TODO: just use namespaces instead
// export const scope = <T extends TaskTree>(description: string, children: T) => {
// 	return {
// 		_tag: "scope",
// 		id: Symbol("scope"),
// 		tags: [],
// 		description,
// 		children,
// 	} satisfies Scope
// }

// TODO: figure out programmatic use & API
// export const publicRuntime = (globalArgs: { network: string; logLevel: string }) => {
//     const runtime = makeCliRuntime({ globalArgs })
//     return {
//         runTask: (task: Task) => runtime.runPromise(task)
//         runTaskByPath: (path: string) => runtime.runPromise(runTaskByPath(path))
//     }
// }

export { runCli } from "./cli/index.js"
export type { TaskCtx as TaskCtxShape } from "./services/taskRuntime.js"
