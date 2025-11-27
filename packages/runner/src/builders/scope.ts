import { TaskCtx } from "../services/taskRuntime.js"
import { Scope, TaskTree, TaskTreeNode } from "../types/types.js"
import { Tags } from "./lib.js"

export const scope = (children: TaskTree) => {
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