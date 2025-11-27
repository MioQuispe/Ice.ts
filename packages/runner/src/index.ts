import type {
	ICEConfig,
	ICEGlobalArgs,
} from "./types/types.js"
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

export { type StandardSchemaV1 } from "@standard-schema/spec"

// Export additional types for user configs
export type {
	ICEConfig,
	ICEGlobalArgs,
	ICEEnvironment,
	TaskTree,
	Scope,
	Task,
	ICEUser,
	InferIceConfig,
} from "./types/types.js"

export type { Principal } from "@dfinity/principal"
export type { Identity } from "@dfinity/agent"

// export const Ice = (
//     globalArgs: ICEGlobalArgs,
// ) => Promise<C> {
//     return async (globalArgs: ICEGlobalArgs) => {
//         const configResult =
//             typeof this.#config === "function"
//                 ? this.#config(globalArgs)
//                 : this.#config
//         const config =
//             configResult instanceof Promise
//                 ? await configResult
//                 : configResult

//         return { config, plugins: this.#plugins }
//     }
// }

export const Ice = <C extends ICEConfig>(
	configFn: (globalArgs: ICEGlobalArgs) => Promise<C> | C,
) => {
	return async (globalArgs: ICEGlobalArgs) => {
		const configResult =
			typeof configFn === "function" ? configFn(globalArgs) : configFn
		const config =
			configResult instanceof Promise ? await configResult : configResult

		return config
	}
}
// TODO: figure out programmatic use & APIs
export { runCli } from "./cli/index.js"
export type { TaskCtx } from "./services/taskRuntime.js"
