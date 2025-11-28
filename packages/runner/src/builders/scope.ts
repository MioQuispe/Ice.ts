import { TaskCtx } from "../services/taskRuntime.js"
import { Scope, TaskTree, TaskTreeNode } from "../types/types.js"
import { Tags } from "./lib.js"

/**
 * Creates a logical grouping of tasks or nested scopes.
 * This helps organize your ICE configuration into namespaces.
 *
 * @param children - A record mapping names to {@link Task} or {@link Scope} objects.
 * @returns A {@link Scope} object containing the children.
 *
 * @example
 * ```typescript
 * import { scope, task } from "@ice.ts/runner"
 *
 * const reset = task().run(() => console.log("reset")).make()
 * const seed = task().run(() => console.log("seed")).make()
 *
 * export const db = scope({
 *   reset,
 *   seed
 * })
 * // Usage: ice run db:reset
 * ```
 *
 * @group Essentials
 */
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
