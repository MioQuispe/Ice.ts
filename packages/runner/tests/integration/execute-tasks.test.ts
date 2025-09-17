import { Effect, Layer, ManagedRuntime, Ref } from "effect"
import { describe, expect, it } from "vitest"
import { layer } from "@effect/vitest"
import { task } from "../../src/builders/task.js"
import { ICEConfigService } from "../../src/services/iceConfig.js"
import {
	makeTaskEffects,
	TaskRuntimeError,
	topologicalSortTasks,
} from "../../src/tasks/lib.js"
import { CachedTask, ICEConfig, Task, TaskTree } from "../../src/types/types.js"
import { makeCachedTask, makeTaskRunner, makeTestEnv } from "./setup.js"
import { runTask, runTasks } from "../../src/tasks/run.js"

describe("executeTasks", () => {
	// const testLayer = (() => {
	// 	const tasks = topologicalSortTasks(
	// 		new Map([
	// 			[a.id, a],
	// 			[b.id, b],
	// 			[c.id, c],
	// 		]),
	// 	)
	// 	// (no replica needed)
	// 	const taskTree = {
	// 		a: a,
	// 		b: b,
	// 		c: c,
	// 	}
	// 	return makeTestLayer({}, taskTree)
	// })()
	it("runs tasks after their dependencies", async () => {
		// Build a small DAG:   C <- A
		//                      C <- B
		const a = task().make()
		const b = task().make()
		const c = task().deps({ one: a, two: b }).make()
		const tasks = [a, b, c]
		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-1")
		const taskTree = {
			a,
			b,
			c,
		}
		let progress: Array<string> = []
		await runtime.runPromise(
			Effect.gen(function* () {
				const { runTask, runTasks } = yield* makeTaskRunner(taskTree)

				yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
					(update) => {
						if (update.status === "completed") {
							progress.push(update.taskPath)
						}
					},
				)
			}),
		)
		// C must be last, order of A / B does not matter
		console.log(progress)
		expect(progress.at(-1)).toBe("c")
		expect(progress.sort()).toEqual(["a", "b", "c"]) // all ran
	})

	it("reads from and writes to the cache only once", async () => {
		const taskTree = {
			cached: makeCachedTask(
				task("cached-task")
					.run(async () => "first")
					.make(),
				"first",
			),
		}
		Effect.gen(function* () {
			// 1st run ⇒ miss + store
			const cached = taskTree["cached"] as CachedTask
			const first = yield* runTask(taskTree["cached"], {})
			// const taskEffects = yield* makeTaskEffects(tasks)
			// const first = yield* Effect.all(taskEffects, {
			// 	concurrency: "unbounded",
			// })

			expect(first).toBe("first")

			// change the effect to prove it is *not* evaluated the 2nd time
			// cached.effect = Effect.dieMessage("should not evaluate")
			cached.effect = async () => {
				throw new Error("should not evaluate")
			}

			// 2nd run ⇒ hit, same value
			const second = yield* runTask(taskTree["cached"], {})
			expect(second).toBe("first")
		})
	})

	it("obeys the global concurrency limit", async () => {
		const counter = Ref.unsafeMake(0)
		const maxSeen = Ref.unsafeMake(0)
		const slow = (name: string) => ({
			...task().make(),
			effect: () =>
				Effect.gen(function* (_) {
					const cur = yield* _(
						Ref.updateAndGet(counter, (n) => n + 1),
					)
					yield* _(Ref.update(maxSeen, (m) => Math.max(m, cur)))
					yield* _(Effect.sleep("20 millis"))
					yield* _(Ref.update(counter, (n) => n - 1))
				}).pipe(Effect.runPromise),
		})
		const tasks = ["t1", "t2", "t3", "t4", "t5"].map(slow)
		// // (no replica needed)
		const taskTree = {
			t1: tasks[0]!,
			t2: tasks[1]!,
			t3: tasks[2]!,
			t4: tasks[3]!,
			t5: tasks[4]!,
		}
		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-2")
		const max = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTask, runTasks } = yield* makeTaskRunner(taskTree)
				yield* runTasks(tasks.map((t) => ({ ...t, args: {} })), undefined, 2)
				const max = yield* Ref.get(maxSeen)
				return max
			}),
		)
		expect(max).toBeLessThanOrEqual(2) // never more than 2 running
	})

	it("handles deep dependency chains correctly", async () => {
		const executionOrder: Array<string> = []

		// Create a chain: root -> level1 -> level2 -> level3
		// const level3 = makeTask("level3", "L3")
		// const level2 = makeTask("level2", "L2")
		// const level1 = makeTask("level1", "L1")
		// const root = makeTask("root", "ROOT")

		const level3 = task("level3")
			.run(async () => "L3")
			.make()
		const level2 = task("level2")
			.deps({ prev: level3 })
			.run(async () => "L2")
			.make()
		const level1 = task("level1")
			.deps({ prev: level2 })
			.run(async () => "L1")
			.make()
		const root = task("root")
			.deps({ prev: level1 })
			.run(async () => "ROOT")
			.make()

		// // TODO: use builder instead
		// level2.dependencies = { prev: level3 }
		// level1.dependencies = { prev: level2 }
		// root.dependencies = { prev: level1 }

		// Track execution order
		const trackingTasks = [level3, level2, level1, root].map<Task>(
			(task) => ({
				...task,
				effect: async (taskCtx) => {
					executionOrder.push(task.description)
					const result = await task.effect(taskCtx)
					return result
				},
			}),
		)

		const taskTree = {
			level3: trackingTasks[0]!,
			level2: trackingTasks[1]!,
			level1: trackingTasks[2]!,
			root: trackingTasks[3]!,
		}

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-3")
		await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					trackingTasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		// Should execute in order: level3, level2, level1, root
		expect(executionOrder).toEqual(["level3", "level2", "level1", "root"])
	})

	it("handles diamond dependencies correctly", async () => {
		const executionOrder: Array<string> = []

		// Create diamond: top -> left/right -> bottom
		const top = task("top")
			.run(async () => "TOP")
			.make()
		const left = task("left")
			.deps({ parent: top })
			.run(async () => "LEFT")
			.make()
		const right = task("right")
			.deps({ parent: top })
			.run(async () => "RIGHT")
			.make()
		const bottom = task("bottom")
			.deps({ leftParent: left, rightParent: right })
			.run(async () => "BOTTOM")
			.make()

		// Track execution order
		const trackingTasks = [top, left, right, bottom].map<Task>((task) => ({
			...task,
			effect: async (taskCtx) => {
				executionOrder.push(task.description)
				const result = await task.effect(taskCtx)
				return result
			},
		}))

		const taskTree = {
			top: trackingTasks[0]!,
			left: trackingTasks[1]!,
			right: trackingTasks[2]!,
			bottom: trackingTasks[3]!,
		}

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-4")

		await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					trackingTasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		// Top should be first, bottom should be last
		expect(executionOrder[0]).toBe("top")
		expect(executionOrder[3]).toBe("bottom")
		// Left and right can run in parallel after top
		expect(executionOrder.slice(1, 3).sort()).toEqual(["left", "right"])
	})

	it("handles task failure propagation", async () => {
		const failingTask = task("failing")
			.run(() => "FAIL")
			.make() as Task
		const dependentTask = task("dependent")
			.run(() => "DEPENDENT")
			.make()

		// Make the first task fail
		failingTask.effect = (taskCtx) =>
			Effect.gen(function* () {
				yield* Effect.fail("Task failed")
			}).pipe(Effect.runPromise)
		dependentTask.dependencies = { prerequisite: failingTask }

		const taskTree = {
			failing: failingTask,
			dependent: dependentTask,
		}
		const tasks = [failingTask, dependentTask]

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-5")

		// The execution should fail when the dependency fails
		await expect(
			runtime.runPromise(
				Effect.gen(function* () {
					const { runTasks } = yield* makeTaskRunner(taskTree)
					const results = yield* runTasks(
						tasks.map((t) => ({
							...t,
							args: {},
						})),
					)
					return results
				}),
			),
		).rejects.toThrow()
	})

	it("handles mixed cached and non-cached tasks with dependencies", async () => {
		const executionOrder: Array<string> = []

		// Create mixed scenario: cached -> non-cached -> cached

		const t = task()
			.run(async (ctx) => "CACHED_ROOT")
			.make()

		const cachedRoot = makeCachedTask(t, "CACHED_ROOT")
		const nonCachedMiddle = task()
			.deps({ root: cachedRoot })
			.run(async () => "NON_CACHED_MIDDLE")
			.make()
		const cachedLeaf = makeCachedTask(
			task()
				.deps({ middle: nonCachedMiddle })
				.run(async () => "CACHED_LEAF")
				.make(),
			"CACHED_LEAF",
		)

		// // Set up dependencies
		// nonCachedMiddle.dependencies = { root: cachedRoot }
		// cachedLeaf.dependencies = { middle: nonCachedMiddle }

		// Track execution order for the non-cached task
		const trackingNonCached: Task = {
			...nonCachedMiddle,
			effect: (taskCtx) =>
				Effect.gen(function* () {
					executionOrder.push("NON_CACHED_MIDDLE")
					const result = yield* Effect.tryPromise(() =>
						nonCachedMiddle.effect(taskCtx),
					)
					return result
				}).pipe(Effect.runPromise),
		}

		const taskTree = {
			cachedRoot,
			trackingNonCached,
			cachedLeaf,
		}

		const tasks = [cachedRoot, trackingNonCached, cachedLeaf]

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-6")

		// First run - all should execute
		const firstResults = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		expect(executionOrder).toEqual(["NON_CACHED_MIDDLE"])
		expect(firstResults.length).toBe(3)

		// Reset execution order
		executionOrder.length = 0

		// Second run - cached tasks should use cache, non-cached should run again
		const secondResults = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		expect(executionOrder).toEqual(["NON_CACHED_MIDDLE"]) // Only non-cached ran
		expect(secondResults.length).toBe(3)
	})

	it("handles cache invalidation with different cache keys", async () => {
		let cacheKeyCounter = 0

		const dynamicCachedTask = {
			...task()
				.run(async () => {
					return `result-${cacheKeyCounter}`
				})
				.make(),
			effect: async (taskCtx) => {
				return `result-${cacheKeyCounter}`
			},
			computeCacheKey: () => `dynamic-key-${cacheKeyCounter}`,
			input: () => Effect.succeed(undefined).pipe(Effect.runPromise),
			encode: (taskCtx, v) => Effect.succeed(v).pipe(Effect.runPromise),
			decode: (taskCtx, v) =>
				Effect.succeed(v as string).pipe(Effect.runPromise),
			encodingFormat: "string",
		} satisfies CachedTask<string>

		const taskTree = {
			dynamicCachedTask,
		}
		const tasks = [dynamicCachedTask]

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-7")

		// First run with cacheKeyCounter = 0
		const firstResults = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		expect(firstResults[0]).toBe("result-0")

		// Change cache key counter
		cacheKeyCounter = 1

		// Second run with different cache key should re-execute
		const secondResults = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		expect(secondResults[0]).toBe("result-1")
	})

	it("maintains concurrency limits with complex dependency tree", async () => {
		const concurrentCounter = Ref.unsafeMake(0)
		const maxConcurrent = Ref.unsafeMake(0)

		const createTimedTask = (
			name: string,
			dependencies: Record<string, Task> = {},
		): Task => ({
			...task().make(),
			description: name,
			dependencies,
			effect: (taskCtx) =>
				Effect.gen(function* () {
					const current = yield* Ref.updateAndGet(
						concurrentCounter,
						(n) => n + 1,
					)
					yield* Ref.update(maxConcurrent, (max) =>
						Math.max(max, current),
					)
					yield* Effect.sleep("30 millis")
					yield* Ref.update(concurrentCounter, (n) => n - 1)
					return name
				}).pipe(Effect.runPromise),
		})

		// Create tree: root -> [branch1, branch2] -> leaf
		const root = createTimedTask("root")
		const branch1 = createTimedTask("branch1", { parent: root })
		const branch2 = createTimedTask("branch2", { parent: root })
		const leaf = createTimedTask("leaf", { b1: branch1, b2: branch2 })

		const taskTree = {
			root,
			branch1,
			branch2,
			leaf,
		}
		const tasks = [root, branch1, branch2, leaf]

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-8")

		await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				).pipe(Effect.withConcurrency(2))
				return results
			}),
		)

		const maxReached = runtime.runSync(Ref.get(maxConcurrent))
		expect(maxReached).toBeLessThanOrEqual(2)
	})

	it("handles independent task groups with concurrency", async () => {
		const executionTimes: Array<{
			task: string
			start: number
			end: number
		}> = []

		const createTrackingTask = (name: string): Task => ({
			...task().make(),
			description: name,
			effect: (taskCtx) =>
				Effect.gen(function* () {
					const start = Date.now()
					yield* Effect.sleep("25 millis")
					const end = Date.now()
					executionTimes.push({ task: name, start, end })
					return name
				}).pipe(Effect.runPromise),
		})

		// Create two independent groups
		const group1 = ["g1t1", "g1t2", "g1t3"].map(createTrackingTask)
		const group2 = ["g2t1", "g2t2", "g2t3"].map(createTrackingTask)

		const tasks = [...group1, ...group2]

		const taskTree = Object.fromEntries(
			tasks.map((task) => [task.description, task]),
		)

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-9")

		await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				).pipe(Effect.withConcurrency(3))
				return results
			}),
		)

		expect(executionTimes.length).toBe(6)

		// Check that tasks ran concurrently (some should overlap)
		const sortedByStart = executionTimes.sort((a, b) => a.start - b.start)
		const hasOverlap = sortedByStart.some((task, index) => {
			if (index === 0) return false
			const prevTask = sortedByStart[index - 1]!
			return task.start < prevTask.end
		})
		expect(hasOverlap).toBe(true)
	})

	it("handles very deep dependency chains (canister-like)", async () => {
		const executionOrder: Array<string> = []

		// Simulate canister dependency chain: create -> build -> bindings -> install_args -> install -> deploy
		const create = task("create")
			.run(() => "CREATED")
			.make()
		const build = task("build")
			.run(() => "BUILT")
			.make()
		const bindings = task("bindings")
			.run(() => "BINDINGS")
			.make()
		const install = task("install")
			.run(() => "INSTALLED")
			.make()
		const deploy = task("deploy")
			.run(() => "DEPLOYED")
			.make()

		// Set up chain dependencies
		build.dependencies = { create }
		bindings.dependencies = { build }
		install.dependencies = { bindings }
		deploy.dependencies = { install }

		// Track execution order
		const trackingTasks = [
			create,
			build,
			bindings,
			install,
			deploy,
		].map<Task>((task) => ({
			...task,
			effect: (taskCtx) =>
				Effect.gen(function* () {
					executionOrder.push(task.description)
					const result = yield* Effect.tryPromise(() =>
						task.effect(taskCtx),
					)
					return result
				}).pipe(Effect.runPromise),
		}))

		const taskTree = Object.fromEntries(
			trackingTasks.map((task) => [task.description, task]),
		)

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-10")

		await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					trackingTasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		// TODO: this might be wrong because we changed the order of the tasks
		// fix the test, double check
		// Should execute in strict order
		expect(executionOrder).toEqual([
			"create",
			"build",
			"bindings",
			"install",
			"deploy",
		])
	})

	it("handles parameterized tasks with dynamic values", async () => {
		const executionResults: Array<{ task: string; params: any }> = []

		const createParameterizedTask = (name: string): Task => {
			const baseTask = task(name)
				.run(() => "PARAM_RESULT")
				.make()
			return {
				...baseTask,
				effect: (taskCtx) =>
					Effect.gen(function* () {
						const params = { amount: 50, mode: "reinstall" } // Simulate runtime params
						executionResults.push({ task: name, params })
						return `${name}_executed_with_params`
					}).pipe(Effect.runPromise),
			}
		}

		const paramTask1 = createParameterizedTask("param_task_1")
		const paramTask2 = createParameterizedTask("param_task_2")
		const dependentTask = task("dependent_task")
			.run(() => "DEPENDENT")
			.make()

		dependentTask.dependencies = { task1: paramTask1, task2: paramTask2 }

		const tasks = [paramTask1, paramTask2, dependentTask]

		const taskTree = {
			param_task_1: paramTask1,
			param_task_2: paramTask2,
			dependent_task: dependentTask,
		}

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-11")

		const results = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		expect(executionResults.length).toBe(2)
		expect(executionResults[0]!.params.amount).toBe(50)
		expect(executionResults[1]!.params.amount).toBe(50)
		expect(results.length).toBe(3)
	})

	it("handles dynamic task execution (task calling other tasks)", async () => {
		const executionOrder: Array<string> = []

		// Create a task that dynamically calls other tasks
		const baseTask = task("base_task")
			.run(() => "BASE")
			.make()
		const dynamicTask: Task = {
			...task().make(),
			description: "dynamic_caller",
			effect: (taskCtx) =>
				Effect.gen(function* () {
					executionOrder.push("dynamic_caller_start")
					// Simulate calling another task
					const baseResult = yield* Effect.tryPromise(() =>
						baseTask.effect(taskCtx),
					)
					executionOrder.push("dynamic_caller_end")
					return `called_${baseResult}`
				}).pipe(Effect.runPromise),
		}

		// Track base task execution
		const trackingBaseTask: Task = {
			...baseTask,
			effect: (taskCtx) =>
				Effect.gen(function* () {
					executionOrder.push("base_task")
					const result = yield* Effect.tryPromise(() =>
						baseTask.effect(taskCtx),
					)
					return result
				}).pipe(Effect.runPromise),
		}

		const tasks = [trackingBaseTask, dynamicTask]

		const taskTree = {
			base_task: trackingBaseTask,
			dynamic_caller: dynamicTask,
		}

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-12")

		const results = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		expect(executionOrder).toEqual([
			"base_task",
			"dynamic_caller_start",
			"dynamic_caller_end",
		])
		expect(results.find((r) => r === "called_BASE")).toBeTruthy()
	})

	it("handles cache behavior with different encoding formats", async () => {
		const stringCachedTask = {
			...task()
				.run(() => "string_result")
				.make(),
			computeCacheKey: () => "string_task_key",
			effect: (taskCtx) =>
				Effect.gen(function* () {
					return "string_result"
				}).pipe(Effect.runPromise),
			input: () => Effect.succeed(undefined).pipe(Effect.runPromise),
			encode: (taskCtx, v) =>
				Effect.succeed(v as string).pipe(Effect.runPromise),
			decode: (taskCtx, v) =>
				Effect.succeed(v as string).pipe(Effect.runPromise),
			encodingFormat: "string",
		} satisfies CachedTask<string>

		const binaryCachedTask = {
			...task()
				.run(() => new Uint8Array([1, 2, 3, 4]))
				.make(),
			effect: async (taskCtx) => new Uint8Array([1, 2, 3, 4]),
			computeCacheKey: () => "binary_task_key",
			input: () => Effect.succeed(undefined).pipe(Effect.runPromise),
			encode: (taskCtx, v) => Effect.succeed(v).pipe(Effect.runPromise),
			decode: (taskCtx, v) =>
				Effect.succeed(v as Uint8Array).pipe(Effect.runPromise),
			encodingFormat: "uint8array",
		} satisfies CachedTask<Uint8Array>

		const taskTree = {
			string_cached: stringCachedTask,
			binary_cached: binaryCachedTask,
		}

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-13")
		const tasks = [stringCachedTask, binaryCachedTask]

		// First run - should cache both
		const firstResults = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		expect(firstResults[0]).toBe("string_result")
		expect(firstResults[1]).toEqual(new Uint8Array([1, 2, 3, 4]))

		// Modify effects to verify cache is used
		stringCachedTask.effect = (taskCtx) =>
			Effect.gen(function* () {
				return "modified_string"
			}).pipe(Effect.runPromise)
		binaryCachedTask.effect = (taskCtx) =>
			Effect.gen(function* () {
				return new Uint8Array([5, 6, 7, 8])
			}).pipe(Effect.runPromise)

		// Second run - should use cache
		const secondResults = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		expect(secondResults[0]).toBe("string_result") // From cache
		expect(secondResults[1]).toEqual(new Uint8Array([1, 2, 3, 4])) // From cache
	})

	it("handles error propagation in very deep chains", async () => {
		// Create a 6-level deep chain where the 4th level fails
		const level1 = task("level1")
			.run(() => "L1")
			.make()
		const level2 = task("level2")
			.run(() => "L2")
			.make()
		const level3 = task("level3")
			.run(() => "L3")
			.make()
		const level4 = task("level4")
			.run(() => "L4")
			.make() as Task // This will fail
		const level5 = task("level5")
			.run(() => "L5")
			.make()
		const level6 = task("level6")
			.run(() => "L6")
			.make()

		// Set up dependencies
		level2.dependencies = { prev: level1 }
		level3.dependencies = { prev: level2 }
		level4.dependencies = { prev: level3 }
		level5.dependencies = { prev: level4 }
		level6.dependencies = { prev: level5 }

		// Make level4 fail
		level4.effect = (taskCtx) =>
			Effect.gen(function* () {
				yield* Effect.fail("Deep chain failure")
			}).pipe(Effect.runPromise)

		const tasks = [level1, level2, level3, level4, level5, level6]

		const taskTree = {
			level1,
			level2,
			level3,
			level4,
			level5,
			level6,
		}

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-14")

		await expect(
			runtime.runPromise(
				Effect.gen(function* () {
					const { runTasks } = yield* makeTaskRunner(taskTree)
					const results = yield* runTasks(
						tasks.map((t) => ({ ...t, args: {} })),
					)
					return results
				}),
			),
		).rejects.toThrow()
	})

	it("handles multiple independent cached task chains", async () => {
		// Create two independent chains, each with cached tasks
		const chain1Root = makeCachedTask(
			task("chain1_root")
				.run(async () => "C1_ROOT")
				.make(),
			"C1_ROOT",
		)
		const chain1Middle = makeCachedTask(
			task("chain1_middle")
				.run(async () => "C1_MIDDLE")
				.make(),
			"C1_MIDDLE",
		)
		const chain1Leaf = makeCachedTask(
			task("chain1_leaf")
				.run(async () => "C1_LEAF")
				.make(),
			"C1_LEAF",
		)

		const chain2Root = makeCachedTask(
			task("chain2_root")
				.run(async () => "C2_ROOT")
				.make(),
			"C2_ROOT",
		)
		const chain2Middle = makeCachedTask(
			task("chain2_middle")
				.run(async () => "C2_MIDDLE")
				.make(),
			"C2_MIDDLE",
		)
		const chain2Leaf = makeCachedTask(
			task("chain2_leaf")
				.run(async () => "C2_LEAF")
				.make(),
			"C2_LEAF",
		)

		// // Set up dependencies within each chain
		// chain1Middle.dependencies = { root: chain1Root }
		// chain1Leaf.dependencies = { middle: chain1Middle }
		// chain2Middle.dependencies = { root: chain2Root }
		// chain2Leaf.dependencies = { middle: chain2Middle }

		const tasks = [
			chain1Root,
			chain1Middle,
			chain1Leaf,
			chain2Root,
			chain2Middle,
			chain2Leaf,
		]

		const taskTree = {
			chain1Root,
			chain1Middle,
			chain1Leaf,
			chain2Root,
			chain2Middle,
			chain2Leaf,
		}

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-15")

		// First run - all should execute
		const firstResults = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		expect(firstResults.length).toBe(6)

		// Modify all effects to verify caching
		tasks.forEach((task) => {
			task.effect = async (taskCtx) => {
				throw new Error("Should not execute")
			}
		})

		// Second run - should use cache for all
		const secondResults = await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		expect(secondResults.length).toBe(6)

		// Verify all expected results are present
		const resultValues = secondResults.sort()
		expect(resultValues).toEqual([
			"C1_LEAF",
			"C1_MIDDLE",
			"C1_ROOT",
			"C2_LEAF",
			"C2_MIDDLE",
			"C2_ROOT",
		])

		// Verify dependency ordering within each chain
		const resultsByTask = new Map(secondResults.map((r) => [r, r]))
		const chain1Tasks = ["C1_ROOT", "C1_MIDDLE", "C1_LEAF"]
		const chain2Tasks = ["C2_ROOT", "C2_MIDDLE", "C2_LEAF"]

		// Check that within each chain, tasks completed in dependency order
		// (We can't check exact timing, but we can verify the results are all present)
		chain1Tasks.forEach((task) =>
			expect(resultsByTask.has(task)).toBe(true),
		)
		chain2Tasks.forEach((task) =>
			expect(resultsByTask.has(task)).toBe(true),
		)
	})

	it("handles complex branching with mixed execution times", async () => {
		const executionOrder: Array<string> = []

		// Create complex branching: root -> [fast, slow] -> convergence
		const root = task("root")
			.run(() => "ROOT")
			.make()
		const fastBranch = task("fast")
			.run(() => "FAST")
			.make()
		const slowBranch = task("slow")
			.run(() => "SLOW")
			.make()
		const convergence = task("convergence")
			.run(() => "CONVERGENCE")
			.make()

		// Set up dependencies
		fastBranch.dependencies = { parent: root }
		slowBranch.dependencies = { parent: root }
		convergence.dependencies = { fast: fastBranch, slow: slowBranch }

		// Create tracking tasks with different execution times
		const tasks: Task[] = [
			{
				...root,
				effect: (taskCtx) =>
					Effect.gen(function* () {
						executionOrder.push("root")
						yield* Effect.tryPromise(() => root.effect(taskCtx))
					}).pipe(Effect.runPromise),
			},
			{
				...fastBranch,
				effect: (taskCtx) =>
					Effect.gen(function* () {
						yield* Effect.sleep("10 millis")
						executionOrder.push("fast")
						yield* Effect.tryPromise(() =>
							fastBranch.effect(taskCtx),
						)
					}).pipe(Effect.runPromise),
			},
			{
				...slowBranch,
				effect: (taskCtx) =>
					Effect.gen(function* () {
						yield* Effect.sleep("50 millis")
						executionOrder.push("slow")
						yield* Effect.tryPromise(() =>
							slowBranch.effect(taskCtx),
						)
					}).pipe(Effect.runPromise),
			},
			{
				...convergence,
				effect: (taskCtx) =>
					Effect.gen(function* () {
						executionOrder.push("convergence")
						yield* Effect.tryPromise(() =>
							convergence.effect(taskCtx),
						)
					}).pipe(Effect.runPromise),
			},
		]

		const taskTree = {
			root,
			fastBranch,
			slowBranch,
			convergence,
		}

		const { runtime, telemetryExporter } = makeTestEnv(".ice_test/execute-tasks-16")

		await runtime.runPromise(
			Effect.gen(function* () {
				const { runTasks } = yield* makeTaskRunner(taskTree)
				const results = yield* runTasks(
					tasks.map((t) => ({ ...t, args: {} })),
				)
				return results
			}),
		)

		// Root should be first, convergence should be last
		expect(executionOrder[0]).toBe("root")
		expect(executionOrder[3]).toBe("convergence")
		// Fast should complete before slow
		expect(executionOrder.indexOf("fast")).toBeLessThan(
			executionOrder.indexOf("slow"),
		)
	})
})
