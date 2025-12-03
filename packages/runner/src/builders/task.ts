import { StandardSchemaV1 } from "@standard-schema/spec"
import { match, type } from "arktype"
import { Effect, Record } from "effect"
import { type TaskCtx } from "../services/taskRuntime.js"
import type { ActorSubclass } from "../types/actor.js"
import type {
	InputNamedParam,
	InputPositionalParam,
	InputTaskParam,
	Task,
} from "../types/types.js"
import { NamedParam, PositionalParam, TaskParam } from "../types/types.js"
import { patchGlobals } from "../utils/extension.js"
import { customCanister } from "./custom.js"
import type {
	ExtractScopeSuccesses,
	MergeTaskDependencies,
	MergeTaskDependsOn,
} from "./lib.js"
import {
	AllowedDep,
	NormalizeDeps,
	normalizeDepsMap,
	ValidProvidedDeps,
	TaskError,
	defaultBuilderRuntime,
} from "./lib.js"
import {
	HasValue,
	ParamsToArgs,
	ResolvedParamsToArgs,
	TaskParamsToArgs,
} from "../tasks/lib.js"

// Helper to merge the new input params into the phantom type TP
type MergeTaskInferenceParams<
	TP extends Record<string, InputTaskParam>,
	IP extends Record<string, InputTaskParam>,
> = TP & AddNameToParams<IP>

type ExtractNamedParams<TP extends Record<string, TaskParam>> = {
	[K in keyof TP]: Extract<TP[K], NamedParam>
}

export type ExtractPositionalParams<TP extends Record<string, TaskParam>> =
	Extract<TP[keyof TP], PositionalParam>[]

// Utility to add the 'name' property to the inferred Input Params
export type AddNameToParams<T extends Record<string, InputTaskParam>> = {
	[K in keyof T]: T[K] & {
		name: K
	}
}

// export type ExtractArgsFromTaskParams<TP extends TaskParams> = {
// 	// TODO: schema needs to be typed as StandardSchemaV1
// 	[K in keyof TP]: TP[K] extends { isOptional: true }
// 		? StandardSchemaV1.InferOutput<TP[K]["type"]> | undefined
// 		: StandardSchemaV1.InferOutput<TP[K]["type"]>
// }

// export type TaskParamsToArgs<T extends Task> = {
// 	[K in keyof T["params"]]: T["params"][K] extends TaskParam
// 		? StandardSchemaV1.InferOutput<T["params"][K]["type"]>
// 		: never
// }

// // TODO: doesnt take into consideration flags like isOptional, isVariadic, etc.
// export type ExtractArgsFromTaskParams<TP extends TaskParams> = {
// 	// TODO: schema needs to be typed as StandardSchemaV1
// 	[K in keyof TP]: StandardSchemaV1.InferOutput<TP[K]["type"]>
// }

type TaskParams = Record<string, NamedParam | PositionalParam>
type InputParams = Record<string, InputTaskParam>

type GetParamType<T> = T extends "string"
	? string
	: T extends "number"
		? number
		: T extends "boolean"
			? boolean
			: T extends StandardSchemaV1<infer Out>
				? Out
				: never

type ValidateInputParams<T extends Record<string, InputTaskParam>> = {
	[K in keyof T]: T[K] extends infer U
		? U extends InputNamedParam
			? InputNamedParam<GetParamType<U["type"]>>
			: U extends InputPositionalParam
				? InputPositionalParam<GetParamType<U["type"]>>
				: never
		: never
}

/**
 * Normalizes InputTaskParam types to full TaskParam types, preserving literal isOptional types.
 */
type NormalizeInputParams<T extends Record<string, InputTaskParam>> = {
	[K in keyof T]: T[K] extends InputNamedParam<infer U>
		? NamedParam<U>
		: T[K] extends InputPositionalParam<infer U>
			? PositionalParam<U>
			: never
}

/**
 * Creates a default decoder function based on the schema type.
 * Attempts to infer the appropriate decoder for common types (string, number, boolean).
 * Falls back to identity function for unknown types.
 */
// [Imports remain unchanged...]

// [Types remain unchanged...]

/**
 * Creates a default decoder function based on the schema type or string literal.
 */
function createDefaultDecoder<T>(
	schema: StandardSchemaV1<T> | "string" | "number" | "boolean",
): (value: string) => T {
	// Handle built-in string types
	if (schema === "string") {
		return (value: string) => value as T
	}
	if (schema === "number") {
		return (value: string) => {
			const num = Number(value)
			return (isNaN(num) ? value : num) as T
		}
	}
	if (schema === "boolean") {
		return (value: string) => {
			const lower = value.toLowerCase().trim()
			if (lower === "true" || lower === "1") return true as T
			if (lower === "false" || lower === "0" || lower === "")
				return false as T
			return value as T // fallback
		}
	}

	// Handle StandardSchemaV1
	// Try to detect type from schema structure
	const schemaAny = schema as any
	if (schemaAny?.["~standard"]?.types?.output) {
		const outputType = schemaAny["~standard"].types.output
		// Check if it's a boolean type
		if (outputType === Boolean || outputType === "boolean") {
			return (value: string) => {
				const lower = value.toLowerCase().trim()
				// Only treat as boolean if it's explicitly "true" or "false"
				if (lower === "true" || lower === "1") {
					return true as T
				}
				if (lower === "false" || lower === "0" || lower === "") {
					return false as T
				}
				// If not a clear boolean, fall through to identity
				return value as T
			}
		}
		// Check if it's a number type
		if (outputType === Number || outputType === "number") {
			return (value: string) => {
				const num = Number(value)
				if (isNaN(num)) {
					return value as T
				}
				return num as T
			}
		}
		// Check if it's a string type
		if (outputType === String || outputType === "string") {
			return (value: string) => value as T
		}
	}

	// [ArkType check logic remains the same...]

	// Default: identity function
	return (value: string) => value as T
}

// [normalizeInputParam and rest of file remains unchanged...]

/**
 * Normalizes an InputTaskParam to a full TaskParam by applying defaults.
 */
function normalizeInputParam<T>(
	input: InputTaskParam<T>,
	name: string,
): TaskParam<T> {
	const result: TaskParam<T> = {
		name,
		type: input.type,
		decode: input.decode ?? createDefaultDecoder(input.type),
		isOptional: input.isOptional ?? false,
		isVariadic: input.isVariadic ?? false,
	}
	if (input.description !== undefined) {
		result.description = input.description
	}
	if (input.default !== undefined) {
		result.default = input.default
	}
	return result
}

/**
 * Normalizes an InputNamedParam to a full NamedParam.
 */
function normalizeInputNamedParam<T>(
	input: InputNamedParam<T>,
	name: string,
): NamedParam<T> {
	const base = normalizeInputParam(input, name)
	return {
		...base,
		aliases: input.aliases ?? [],
		isFlag: true,
	}
}

/**
 * Normalizes an InputPositionalParam to a full PositionalParam.
 */
function normalizeInputPositionalParam<T>(
	input: InputPositionalParam<T>,
	name: string,
): PositionalParam<T> {
	const base = normalizeInputParam(input, name)
	return {
		...base,
		isFlag: false,
	}
}

const matchParam = match
	.in<NamedParam | PositionalParam>()
	// NamedParam
	.case(
		{
			// name: string
			// type: StandardSchemaV1<T> // TODO: ship built in types like "string" | "number" etc.
			// description?: string
			// default?: T
			// decode: (value: string) => T
			// isOptional: boolean
			// isVariadic: boolean
			isFlag: "true",
			aliases: "string[]",
			description: "string",
			isOptional: "boolean",
			isVariadic: "boolean",
		},
		(param) => ({ namedParam: param as NamedParam }),
	)
	// PositionalParam
	.case(
		{
			isFlag: "false",
			description: "string",
			isOptional: "boolean",
			isVariadic: "boolean",
		},
		(param) => ({ positionalParam: param as PositionalParam }),
	)
	.default("assert")

/**
 * A builder for defining ICE tasks with typed parameters, dependencies, and execution logic.
 *
 * This class is not instantiated directly. Use the {@link task} function to start building a task.
 *
 * @example
 * ```typescript
 * import { task } from "@ice.ts/runner"
 *
 * export const greet = task("greet")
 *   .params({
 *     name: { type: "string", default: "World" }
 *   })
 *   .run(async ({ args }) => {
 *     console.log(`Hello, ${args.name}!`)
 *   })
 *   .make()
 * ```
 *
 * @group Essentials
 */
export class TaskBuilder<
	T extends Task,
	TP extends Record<string, TaskParam>,
	TCtx extends TaskCtx = TaskCtx,
> {
	#task: T
	constructor(task: T) {
		this.#task = task
	}

	// We use `const` generic to infer exact literals (e.g. isOptional: true)
	/**
	 * Defines the parameters that this task accepts.
	 * Parameters can be named (flags) or positional.
	 *
	 * @param inputParams - An object defining the parameters.
	 * @returns The builder instance with updated parameter types.
	 *
	 * @example
	 * ```typescript
	 * task("greet")
	 *   .params({
	 *     name: { type: "string", description: "Who to greet" },
	 *     loud: { type: "boolean", isFlag: true, default: false }
	 *   })
	 * ```
	 */
	params<const IP extends ValidateInputParams<IP>>(inputParams: IP) {
		const namedParams: Record<string, NamedParam> = {}
		const positionalParams: Array<PositionalParam> = []
		const normalizedParams: Record<string, TaskParam> = {}

		// Runtime normalization (creates the TaskParam objects)
		for (const [name, inputParam] of Object.entries(inputParams)) {
			// [Same normalization logic as before...]
			const param = inputParam as InputTaskParam
			if (param.isPositional === true) {
				const normalized = normalizeInputPositionalParam(
					param as InputPositionalParam,
					name,
				)
				positionalParams.push(normalized)
				normalizedParams[name] = normalized
			} else {
				const normalized = normalizeInputNamedParam(
					param as InputNamedParam,
					name,
				)
				namedParams[name] = normalized
				normalizedParams[name] = normalized
			}
		}

		// Merge runtime params into the task
		const updatedTask = {
			...this.#task,
			namedParams: { ...this.#task.namedParams, ...namedParams },
			positionalParams: [
				...this.#task.positionalParams,
				...positionalParams,
			],
			params: { ...this.#task.params, ...normalizedParams },
		} satisfies Task

		// Return new builder with merged Inference Types (TP & IP)
		return new TaskBuilder(updatedTask) as unknown as TaskBuilder<
			typeof updatedTask,
			MergeTaskInferenceParams<TP, IP>,
			TCtx
		>
	}

	/**
	 * Declares local dependencies (tasks or canisters) that will be injected into the `run` context.
	 *
	 * These dependencies are *not* automatically executed before this task.
	 * Instead, they are made available in the `deps` object for manual invocation.
	 *
	 * @param providedDeps - A map of dependencies to inject.
	 * @returns The builder instance with updated dependency types.
	 *
	 * @example
	 * ```typescript
	 * task("integration-test")
	 *   .deps({ backend: backendCanister })
	 *   .run(async ({ deps }) => {
	 *     const { backend } = deps
	 *     await backend.actor.init()
	 *   })
	 * ```
	 */
	deps<UP extends Record<string, AllowedDep>, NP extends NormalizeDeps<UP>>(
		providedDeps: ValidProvidedDeps<T["dependsOn"], UP>,
	) {
		const updatedDeps = normalizeDepsMap(providedDeps) as NP
		const updatedTask = {
			...this.#task,
			dependencies: updatedDeps,
		} satisfies Task as MergeTaskDependencies<T, NP>
		return new TaskBuilder(updatedTask) as TaskBuilder<
			typeof updatedTask,
			TP,
			TCtx
		>
	}

	/**
	 * Declares execution dependencies. These tasks/canisters MUST complete successfully
	 * before this task is allowed to run.
	 *
	 * Their results are also available in the `deps` object.
	 *
	 * @param dependencies - A map of dependencies to await.
	 * @returns The builder instance.
	 *
	 * @example
	 * ```typescript
	 * task("deploy-all")
	 *   .dependsOn({ backend: backend.children.deploy })
	 *   .run(async ({ deps }) => {
	 *     // Backend deploy is guaranteed to be finished here
	 *     console.log("Backend deployed:", deps.backend)
	 *   })
	 * ```
	 */
	dependsOn<
		UD extends Record<string, AllowedDep>,
		ND extends NormalizeDeps<UD>,
	>(dependencies: UD): TaskBuilder<MergeTaskDependsOn<T, ND>, TP, TCtx> {
		const updatedDeps = normalizeDepsMap(dependencies) as ND
		const updatedTask = {
			...this.#task,
			dependsOn: updatedDeps,
		} satisfies Task as MergeTaskDependsOn<T, ND>
		return new TaskBuilder(updatedTask) as TaskBuilder<
			typeof updatedTask,
			TP,
			TCtx
		>
	}

	/**
	 * Defines the execution logic for the task.
	 *
	 * @param fn - An async function that receives the task context.
	 * @returns The builder instance.
	 *
	 * @example
	 * ```typescript
	 * .run(async ({ args, deps, ctx }) => {
	 *   console.log("Running task with", args)
	 *   return "success"
	 * })
	 * ```
	 */
	run<Output>(
		fn: (env: {
			args: ParamsToArgs<TP>
			ctx: TCtx
			deps: ExtractScopeSuccesses<T["dependencies"]> &
				ExtractScopeSuccesses<T["dependsOn"]>
		}) => Promise<Output> | Output,
	) {
		const newTask = {
			...this.#task,

			effect: (taskCtx) =>
				defaultBuilderRuntime.runPromise(
					Effect.fn("task_effect")(function* () {
						const deps = Record.map(
							taskCtx.depResults,
							(dep) => dep.result,
						)
						const maybePromise = fn({
							args: taskCtx.args as ParamsToArgs<TP>,
							ctx: taskCtx as TCtx,
							deps: deps as ExtractScopeSuccesses<
								T["dependencies"]
							> &
								ExtractScopeSuccesses<T["dependsOn"]>,
						})
						const result =
							maybePromise instanceof Promise
								? yield* Effect.tryPromise({
										try: () =>
											patchGlobals(() => maybePromise),
										catch: (error) => {
											return new TaskError({
												message: String(error),
											})
											// return error instanceof Error
											// 	? error
											// 	: new Error(String(error))
										},
									})
								: maybePromise
						return result
					})(),
				),
			// TODO: create a task constructor for this, which fixes the type errors
		} satisfies Task

		// TODO: unknown params?
		// newTask.params

		return new TaskBuilder(newTask) as TaskBuilder<typeof newTask, TP, TCtx>
	}

	/**
	 * Finalizes the task definition and returns the task object.
	 *
	 * @returns The constructed `Task` object.
	 */
	make(): T & { params: TP } {
		const s = {} as TP
		// TODO: relink dependencies?
		return {
			...this.#task,
			id: Symbol("task"),
		} satisfies Task as T & { params: TP }
	}
}

/**
 * Creates a new task builder.
 *
 * @param description - A brief description of what the task does.
 * @returns A {@link TaskBuilder} to configure the task.
 *
 * @example
 * ```typescript
 * import { task } from "@ice.ts/runner"
 *
 * export const myTask = task("My useful task")
 *   .params({ name: { type: "string" } })
 *   .run(({ args }) => console.log(args.name))
 *   .make()
 * ```
 *
 * @group Essentials
 */
export function task(description = "") {
	const baseTask = {
		_tag: "task",
		id: Symbol("task"),
		description,
		dependsOn: {},
		dependencies: {},
		tags: [],
		params: {},
		namedParams: {},
		positionalParams: [],
		effect: async (ctx) => {},
	} satisfies Task
	return new TaskBuilder<Task, {}, TaskCtx>(baseTask)
}
