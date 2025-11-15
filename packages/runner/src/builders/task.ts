import { StandardSchemaV1 } from "@standard-schema/spec"
import { match, type } from "arktype"
import { Effect, Record } from "effect"
import { type TaskCtx } from "../services/taskRuntime.js"
import type { ActorSubclass } from "../types/actor.js"
import type {
	InputNamedParam,
	InputPositionalParam,
	Task,
} from "../types/types.js"
import { NamedParam, PositionalParam } from "../types/types.js"
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

type MergeTaskParams<
	T extends Task,
	TP extends AddNameToParams<InputParams>,
> = T & {
	namedParams: ExtractNamedParams<TP>
	positionalParams: ExtractPositionalParams<TP>
	params: TP
}

type ExtractNamedParams<TP extends TaskParams> = {
	[K in keyof TP]: Extract<TP[K], NamedParam>
}

export type ExtractPositionalParams<TP extends TaskParams> = Extract<
	TP[keyof TP],
	PositionalParam
>[]

export type ExtractArgsFromTaskParams<TP extends TaskParams> = {
	// TODO: schema needs to be typed as StandardSchemaV1
	[K in keyof TP]: TP[K] extends { isOptional: true }
		? StandardSchemaV1.InferOutput<TP[K]["type"]> | undefined
		: StandardSchemaV1.InferOutput<TP[K]["type"]>
}

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

export type AddNameToParams<T extends InputParams> = {
	[K in keyof T]: T[K] & {
		name: K
	}
}

type TaskParams = Record<string, NamedParam | PositionalParam>
type InputParams = Record<string, InputPositionalParam | InputNamedParam>

type ValidateInputParams<T extends InputParams> = {
	[K in keyof T]: T[K] extends infer U
		? U extends InputPositionalParam
			? InputPositionalParam<StandardSchemaV1.InferOutput<U["type"]>>
			: U extends InputNamedParam
				? InputNamedParam<StandardSchemaV1.InferOutput<U["type"]>>
				: never
		: never
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
			// parse: (value: string) => T
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

type Has<U, T> = [T] extends [U] ? true : false

/* one segment per flag */
type PSeg<S extends BuilderMethods> =
	`${Has<S, "params"> extends true ? "P1-" : "P0-"}`
type DepSeg<S extends BuilderMethods> =
	`${Has<S, "dependsOn"> extends true ? "Dep1-" : "Dep0-"}`
type DSeg<S extends BuilderMethods> =
	`${Has<S, "deps"> extends true ? "D1-" : "D0-"}`
type RSeg<S extends BuilderMethods> =
	`${Has<S, "run"> extends true ? "R1" : "R0"}`

/* final key ✨ */
type CanonKey<S extends BuilderMethods> =
	`${PSeg<S>}${DepSeg<S>}${DSeg<S>}${RSeg<S>}`

type NextMap = {
	/* Start ─────────────────────────────────────────────────────── */
	"P0-Dep0-D0-R0": "params" | "dependsOn" | "deps" | "run" | "make"

	/* DO (DependsOn only) ---------------------------------------- */
	"P0-Dep1-D0-R0": "deps" | "run" | "params"

	/* DOD  (DependsOn  ➜ Deps) ----------------------------------- */
	"P0-Dep1-D1-R0": "params" | "run" | "make"

	/* DODR  (DependsOn  ➜ Deps ➜ Run) ---------------------------- */
	"P0-Dep1-D1-R1": "make"

	/* DOR  (DependsOn  ➜ Run) ------------------------------------ */
	"P0-Dep1-D0-R1": "deps"

	/* DR   (Deps ➜ Run) ------------------------------------------ */
	"P0-Dep0-D1-R1": "make"

	/* D    (Deps only) ------------------------------------------- */
	"P0-Dep0-D1-R0": "run" | "make" | "params"

	/* P    (Params only) ----------------------------------------- */
	"P1-Dep0-D0-R0": "dependsOn" | "deps" | "run" | "make"

	/* PD   (Params ➜ Deps) --------------------------------------- */
	"P1-Dep0-D1-R0": "run" | "make"

	/* PDR  (Params ➜ Deps ➜ Run) --------------------------------- */
	"P1-Dep0-D1-R1": "make"

	/* PDO  (Params ➜ DependsOn) ---------------------------------- */
	"P1-Dep1-D0-R0": "deps" | "run"

	/* PDOD (Params ➜ DependsOn ➜ Deps) --------------------------- */
	"P1-Dep1-D1-R0": "run" | "make"

	/* PDODR (… ➜ Run) -------------------------------------------- */
	"P1-Dep1-D1-R1": "make"

	/* PDOR  (Params ➜ DependsOn ➜ Run) --------------------------- */
	"P1-Dep1-D0-R1": "deps"

	/* PR   (Params ➜ Run) ---------------------------------------- */
	"P1-Dep0-D0-R1": "make"

	/* R    (Run only) -------------------------------------------- */
	"P0-Dep0-D0-R1": "make"
}
type Start = never
type Next<S extends BuilderMethods> = NextMap[CanonKey<S> extends keyof NextMap
	? CanonKey<S>
	: never]

type BuilderMethods = "start" | "params" | "dependsOn" | "deps" | "run" | "make"

type TaskBuilderOmit<
	S extends BuilderMethods,
	T extends Task,
	TP extends AddNameToParams<InputParams>,
	TCtx extends TaskCtx<any, any> = TaskCtx,
> = Pick<TaskBuilder<S, T, TP, TCtx>, Next<S>>

class TaskBuilder<
	S extends BuilderMethods,
	T extends Task,
	TP extends AddNameToParams<InputParams>,
	TCtx extends TaskCtx<any, any> = TaskCtx,
> {
	#task: T
	constructor(task: T) {
		this.#task = task
	}

	params<const IP extends ValidateInputParams<IP>>(inputParams: IP) {
		const updatedParams = Record.map(
			inputParams as InputParams,
			(v, k) => ({
				...v,
				name: k,
			}),
		) as unknown as AddNameToParams<IP>
		// TODO: use arktype?
		const namedParams: Record<string, NamedParam> = {}
		const positionalParams: Array<PositionalParam> = []
		// TODO: use effect records
		for (const kv of Object.entries(updatedParams)) {
			const [name, param] = kv as [string, NamedParam | PositionalParam]
			// TODO: nicer error?

			const result = matchParam(param)
			if ("namedParam" in result) {
				namedParams[name] = result.namedParam
			} else if ("positionalParam" in result) {
				positionalParams.push(result.positionalParam)
			} else {
				// TODO: do this in a better way
				throw new Error(`Invalid parameter type: ${param}`)
			}
		}
		const updatedTask = {
			...this.#task,
			namedParams,
			positionalParams,
			params: updatedParams,
		} satisfies Task as MergeTaskParams<T, typeof updatedParams>
		return new TaskBuilder(updatedTask) as unknown as TaskBuilderOmit<
			S | "params",
			typeof updatedTask,
			typeof updatedParams,
			TCtx
		>
	}

	deps<UP extends Record<string, AllowedDep>, NP extends NormalizeDeps<UP>>(
		providedDeps: ValidProvidedDeps<T["dependsOn"], UP>,
	) {
		const updatedDeps = normalizeDepsMap(providedDeps) as NP
		const updatedTask = {
			...this.#task,
			dependencies: updatedDeps,
		} satisfies Task as MergeTaskDependencies<T, NP>
		return new TaskBuilder(updatedTask) as unknown as TaskBuilderOmit<
			S | "deps",
			typeof updatedTask,
			TP,
			TCtx
		>
	}

	dependsOn<
		UD extends Record<string, AllowedDep>,
		ND extends NormalizeDeps<UD>,
	>(
		dependencies: UD,
	): TaskBuilderOmit<S | "dependsOn", MergeTaskDependsOn<T, ND>, TP, TCtx> {
		const updatedDeps = normalizeDepsMap(dependencies) as ND
		const updatedTask = {
			...this.#task,
			dependsOn: updatedDeps,
		} satisfies Task as MergeTaskDependsOn<T, ND>
		return new TaskBuilder(updatedTask) as unknown as TaskBuilderOmit<
			S | "dependsOn",
			typeof updatedTask,
			TP,
			TCtx
		>
	}

	run<Output>(
		fn: (env: {
			args: ExtractArgsFromTaskParams<TP>
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
							args: taskCtx.args as ExtractArgsFromTaskParams<TP>,
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

		return new TaskBuilder(newTask) as unknown as TaskBuilderOmit<
			S | "run",
			typeof newTask,
			TP,
			TCtx
		>
	}

	make() {
		// TODO: relink dependencies!!!
		return {
			...this.#task,
			id: Symbol("task"),
		} satisfies Task
	}
}

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
	return new TaskBuilder<Start, typeof baseTask, {}, TaskCtx>(baseTask)
}

/**
 * Creates a typed task builder with a specific TaskCtx type.
 * Use this to get autocomplete for the ctx parameter in the run function.
 * 
 * @example
 * ```ts
 * interface MyTaskCtx extends TaskCtx {
 *   users: {
 *     alice: ICEUser
 *     bob: ICEUser
 *   }
 * }
 * 
 * const taskCtx = createTask<MyTaskCtx>()
 * 
 * taskCtx()
 *   .run(({ctx}) => {
 *     ctx.users.alice.principal // ✅ Full autocomplete!
 *   })
 * ```
 */
export const createTask = <TCtx extends TaskCtx<any, any>>() => {
	return (description = "") => {
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
		return new TaskBuilder<Start, typeof baseTask, {}, TCtx>(baseTask)
	}
}
