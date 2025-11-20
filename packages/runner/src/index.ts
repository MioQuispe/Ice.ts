// import { customCanister } from "./builders/custom.js"
// import { motokoCanister } from "./builders/motoko.js"
// import { SignIdentity } from "@icp-sdk/core/agent"
import type {
	ICEConfig,
	ICEGlobalArgs,
	ICEEnvironment,
	ICEConfigFile,
	ICEPlugin,
} from "./types/types.js"
import type { Scope, TaskTree } from "./types/types.js"
// import { TaskCtx, TaskCtxExtension } from "./services/taskRuntime.js"
// import { Principal } from "./external.js"
export { Opt } from "./types/types.js"
export { canister, task, scope } from "./builders/index.js"
export type { CanisterScopeSimple } from "./builders/lib.js"
export type {
	CustomCanisterScope,
	CustomCanisterConfig,
	CustomCanisterBuilder,
} from "./builders/custom.js"
export type {
	MotokoCanisterBuilder,
	MotokoCanisterConfig,
	MotokoCanisterScope,
} from "./builders/motoko.js"
export type {
	RemoteCanisterScope,
	RemoteCanisterConfig,
	RemoteCanisterBuilder,
} from "./builders/remote.js"
export type {
	RustCanisterBuilder,
	RustCanisterConfig,
	RustCanisterScope,
} from "./builders/rust.js"
export { Ids } from "./ids.js"
export type { InstallModes } from "./services/replica.js"
export type { TaskCtxExtension } from "./services/taskRuntime.js"
export { PICReplica } from "./services/pic/pic.js"
export { ICReplica } from "./services/ic-replica.js"

// Export additional types for user configs
export type {
	ICEConfig,
	ICEGlobalArgs,
	ICEEnvironment,
	ICEPlugin,
	TaskTree,
	Scope,
	Task,
	InferIceConfig,
	ICEUser,
} from "./types/types.js"

export type { Principal } from "@dfinity/principal"
export type { Identity } from "@dfinity/agent"

export class IceBuilder<C extends Partial<ICEConfig>> {
	#config: ((globalArgs: ICEGlobalArgs) => Promise<C> | C) | C
	#plugins: ICEPlugin[] = []

	constructor(config: ((globalArgs: ICEGlobalArgs) => Promise<C> | C) | C) {
		this.#config = config
	}

	extendEnv(
		plugin: (
			env: ICEEnvironment & { args: ICEGlobalArgs },
		) => Promise<ICEEnvironment> | ICEEnvironment,
	): IceBuilder<C> {
		this.#plugins.push(plugin)
		return this
	}

	make(): (
		globalArgs: ICEGlobalArgs,
	) => Promise<{ config: C; plugins: ICEPlugin[] }> {
		return async (globalArgs: ICEGlobalArgs) => {
			const configResult =
				typeof this.#config === "function"
					? this.#config(globalArgs)
					: this.#config
			const config =
				configResult instanceof Promise
					? await configResult
					: configResult

			return { config, plugins: this.#plugins }
		}
	}
}

export const Ice = <C extends Partial<ICEConfig>>(
	configFn: (globalArgs: ICEGlobalArgs) => Promise<C> | C,
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
export type { TaskCtx } from "./services/taskRuntime.js"
