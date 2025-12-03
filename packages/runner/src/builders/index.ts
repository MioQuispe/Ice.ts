import { customCanister } from "./custom.js"
import { motokoCanister } from "./motoko.js"
import { rustCanister } from "./rust.js"
import { remoteCanister } from "./remote.js"

// export type {
// 	CanisterScopeSimple,
// 	ExtractScopeSuccesses,
// 	NormalizeDeps,
// 	NormalizeDep,
// 	InstallTask,
// 	CreateTask,
// 	BindingsTask,
// 	BuildTask,
// 	StopTask,
// 	RemoveTask,
// 	DeployTask,
// 	UniformScopeCheck,
// 	DepBuilder,
// 	IsValid,
// 	ValidProvidedDeps,
// 	InstallTaskArgs,
// 	FileDigest,
// 	MergeScopeDependencies,
// 	MergeScopeDependsOn,
// 	MergeTaskDependencies,
// 	MergeTaskDependsOn,
// 	TaskError,
// 	TaskReturnValue,
// 	StatusTask,
// 	CompareTaskEffects,
// 	CompareTaskReturnValues,
// 	InstallTaskError,
// 	AllowedDep,
// 	DependencyMismatchError,
// 	ProvideOf,
// 	ProvideReturnValues,
// 	DependenciesOf,
// 	DependencyReturnValues,
// } from "./lib.js"
export { type TaskCtx } from "../services/taskRuntime.js"
export { Tags } from "./lib.js"
// export * from "./motoko.js"
// export * from "./rust.js"
// export * from "./task.js"
// export * from "./custom.js"
// export * from "./scope.js"
// export * from "./remote.js"

export const canister: {
	custom: typeof customCanister
	motoko: typeof motokoCanister
	rust: typeof rustCanister
	remote: typeof remoteCanister
} = {
	custom: customCanister,
	motoko: motokoCanister,
	rust: rustCanister,
	remote: remoteCanister,
}
export { task, TaskBuilder } from "./task.js"
export { scope } from "./scope.js"
