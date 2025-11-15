import { TaskCtx } from "../services/taskRuntime.js"
import { Scope, ScopeEval, TaskTreeNode, TaskTreeNodeEval } from "../types/types.js"
import { Tags } from "./lib.js"

export const scope = (
	childrenFn: (ctx: TaskCtx) => Record<string, TaskTreeNodeEval>,
) => {
	const scopeDefinition = {
		_tag: "scope" as const,
		id: Symbol("scope"),
		tags: [],
		description: "Scope",
		// defaultTask: "",
		children: childrenFn,
	}
    return scopeDefinition satisfies ScopeEval
}

/**
 * Creates a typed scope builder with a specific TaskCtx type.
 * Use this to get autocomplete for the ctx parameter in the scope function.
 */
export const createScope = <TCtx extends TaskCtx<any, any>>() => {
	return (childrenFn: (ctx: TCtx) => Record<string, TaskTreeNodeEval>) => {
		const scopeDefinition = {
			_tag: "scope" as const,
			id: Symbol("scope"),
			tags: [],
			description: "Scope",
			// defaultTask: "",
			children: childrenFn as any,
		}
		return scopeDefinition satisfies ScopeEval
	}
}

// const testScope = scope((ctx: TaskCtx) => {
//     return {
//         // canister
//     }
// })
