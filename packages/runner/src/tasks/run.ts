import { Context, Effect } from "effect"
import type { Task } from "../types/types.js"
import {
	collectDependencies,
	makeTaskEffects,
	findTaskInTaskTree,
	getTaskPathById,
	type ProgressUpdate,
	TaskParamsToArgs,
	TaskRuntimeError,
	TaskSuccess,
	topologicalSortTasks,
	ParamsToArgs,
} from "./lib.js"
import { isTaskCancelled, TaskCancelled } from "../builders/lib.js"

export interface RunTaskOptions {
	forceRun?: boolean
}

// TODO: runTasks? we need to collect all deps once
export const runTask = Effect.fn("run_task")(function* <T extends Task>(
	task: T,
	args?: TaskParamsToArgs<T>,
	progressCb: (update: ProgressUpdate<unknown>) => void = () => {},
) {
	// TODO:
	// yield* Effect.logDebug("Getting task path...", task.description)
	const taskPath = yield* getTaskPathById(task.id)
	// yield* Effect.annotateCurrentSpan({
	// 	taskPath: path,
	// })
	yield* Effect.logDebug("run_task:", taskPath, { args })
	const taskWithArgs = {
		...task,
		// TODO: this adds args: undefined. fix
		args: args ?? {},
	}
	yield* Effect.logDebug("Collecting dependencies...")
	const collectedTasks = collectDependencies([taskWithArgs])
	yield* Effect.logDebug("Collected dependencies")
	// collectedTasks.set(task.id, taskWithArgs)
	yield* Effect.logDebug("Sorting tasks...")
	const sortedTasks = yield* Effect.try({
		try: () => topologicalSortTasks(collectedTasks),
		catch: (error) => {
			return new TaskRuntimeError({
				message: "Error sorting tasks",
				error,
			})
		},
	})
	yield* Effect.logDebug("Sorted tasks")
	yield* Effect.logDebug("Executing tasks...")
	const taskEffects = yield* makeTaskEffects(sortedTasks, progressCb)
	const results = yield* Effect.all(taskEffects, {
		concurrency: "inherit",
	}).pipe(
		// Effect.mapError((error) => {
		// 	return new TaskRuntimeError({
		// 		message: "Error executing tasks",
		// 		error,
		// 	})
		// }),
		Effect.annotateLogs("taskPath", taskPath),
	)
	yield* Effect.logDebug("Tasks executed")
	// TODO: get all input task results
	const maybeResult = results.find((r) => r.taskId === task.id)
	if (!maybeResult) {
		return yield* Effect.fail(
			new TaskRuntimeError({
				message: `Task ${task.description} not found in results`,
				error: maybeResult,
			}),
		)
	}
	return maybeResult.result as TaskSuccess<T>
})

export const runTasks = Effect.fn("run_tasks")(function* <T extends Task>(
	tasks: Array<T & { args: TaskParamsToArgs<T> }>,
	progressCb: (update: ProgressUpdate<unknown>) => void = () => {},
) {
	// TODO:
	// yield* Effect.logDebug("Getting task path...", task.description)
	// const path = yield* getTaskPathById(task.id)
	// yield* Effect.annotateCurrentSpan({
	// 	taskPath: path,
	// })
	// yield* Effect.logDebug("Got task path:", path)
	yield* Effect.logDebug("Collecting dependencies...")
	const collectedTasks = collectDependencies(tasks)
	yield* Effect.logDebug("Collected dependencies")
	yield* Effect.logDebug("Sorting tasks...")
	const sortedTasks = yield* Effect.try({
		try: () => topologicalSortTasks(collectedTasks),
		catch: (error) => {
			return new TaskRuntimeError({
				message: "Error sorting tasks",
				error,
			})
		},
	})
	yield* Effect.logDebug("Sorted tasks")
	yield* Effect.logDebug("Executing tasks...")
	const taskEffects = yield* makeTaskEffects(sortedTasks, progressCb)
	const results = yield* Effect.all(taskEffects, {
		concurrency: "inherit",
	})
	yield* Effect.logDebug("Tasks executed")
	// const cancelledResults = results.filter((r) => isTaskCancelled(r.result))
	const finishedResults = results.filter((r) => !isTaskCancelled(r.result))

	return finishedResults.map((r) => r.result) as Array<TaskSuccess<T>>
})
