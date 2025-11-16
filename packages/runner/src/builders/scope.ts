import { TaskCtx } from "../services/taskRuntime.js"
import { Scope, TaskTree, TaskTreeNode } from "../types/types.js"
import { Tags } from "./lib.js"

export const scope = (
	children: TaskTree
) => {
	const scopeDefinition = {
		_tag: "scope" as const,
		id: Symbol("scope"),
		tags: [],
		description: "Scope",
		// defaultTask: "",
		children,
	}
    return scopeDefinition satisfies Scope
}

/**
 * Creates a typed scope builder with a specific TaskCtx type.
 * Use this to get autocomplete for the ctx parameter in the scope function.
 */
export const createScope = <TCtx extends TaskCtx<any, any>>() => {
	return (children: TaskTree) => {
		const scopeDefinition = {
			_tag: "scope" as const,
			id: Symbol("scope"),
			tags: [],
			description: "Scope",
			// defaultTask: "",
			children,
		}
		return scopeDefinition satisfies Scope
	}
}

// const testScope = scope((ctx: TaskCtx) => {
//     return {
//         // canister
//     }
// })
