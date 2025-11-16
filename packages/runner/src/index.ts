// import { customCanister } from "./builders/custom.js"
// import { motokoCanister } from "./builders/motoko.js"
import { SignIdentity } from "@icp-sdk/core/agent"
import {
	motokoCanister,
	createMotokoCanister,
	createRustCanister,
	createRemoteCanister,
	createScope,
	createTask,
	// customCanister,
	createCustomCanister,
	task,
	scope,
} from "./builders/index.js"
import { makeCliRuntime } from "./cli/index.js"
import type { ICEConfig, ICEGlobalArgs } from "./types/types.js"
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

export const Ice = <T extends Partial<ICEConfig>>(
	configOrFn: T | ((ctx: ICEGlobalArgs) => Promise<T>),
): {
	config: T | ((ctx: ICEGlobalArgs) => Promise<T>)
	canister: {
		custom: ReturnType<typeof createCustomCanister<TaskCtx<{}, T>>>
		motoko: ReturnType<typeof createMotokoCanister<TaskCtx<{}, T>>>
		rust: ReturnType<typeof createRustCanister<TaskCtx<{}, T>>>
		remote: ReturnType<typeof createRemoteCanister<TaskCtx<{}, T>>>
	}
	task: ReturnType<typeof createTask<TaskCtx<{}, T>>>
	scope: ReturnType<typeof createScope<TaskCtx<{}, T>>>
} => {
	// TODO: return canister builders with types also
	return {
		// TODO: pass T to builders
		config: configOrFn,
		task: createTask<TaskCtx<{}, T>>(),
		// task: task,
		scope: createScope<TaskCtx<{}, T>>(),
		canister: {
			custom: createCustomCanister<TaskCtx<{}, T>>(),
			motoko: createMotokoCanister<TaskCtx<{}, T>>(),
			rust: createRustCanister<TaskCtx<{}, T>>(),
			remote: createRemoteCanister<TaskCtx<{}, T>>(),
		},
	}
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
