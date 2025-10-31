import { KeyValueStore } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { layerMemory } from "@effect/platform/KeyValueStore"
import fs from "node:fs"
import { Effect, Layer, Logger, LogLevel, ManagedRuntime, Ref } from "effect"
import { Principal } from "@icp-sdk/core/principal"
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
	BindingsTask,
	BuildTask,
	CustomCanisterScope,
	CanisterScopeSimple,
	CreateTask,
	customCanister,
	CustomCanisterConfig,
	InstallTask,
	// telemetryLayer,
} from "../../src/index.js"
import { CanisterIdsService } from "../../src/services/canisterIds.js"
import { DefaultConfig } from "../../src/services/defaultConfig.js"
import { ICEConfigService } from "../../src/services/iceConfig.js"
import { Moc } from "../../src/services/moc.js"
import { Replica } from "../../src/services/replica.js"
import { TaskRegistry } from "../../src/services/taskRegistry.js"
import { DeploymentsService } from "../../src/services/deployments.js"
import { makeTaskLayer, TaskRuntime } from "../../src/services/taskRuntime.js"
import {
	makeTaskEffects,
	TaskParamsToArgs,
	topologicalSortTasks,
} from "../../src/tasks/lib.js"
import { runTask, runTasks } from "../../src/tasks/run.js"
import { ICEConfig, Task, TaskTree } from "../../src/types/types.js"
import { makeTestEnvEffect } from "./setup.js"

// Not needed for now

// const program = Effect.gen(function* () {
// 	const replica = yield* DefaultReplica
// 	const topology = yield* replica.getTopology()
// 	return topology
// }).pipe(Effect.provide(DefaultReplicaService))

// const topology = await Effect.runPromise(program)
// const serializableTopology = topology.map((t) => [
// 	t.type,
// 	t.canisterRanges.map((r) => [r.start.toHex(), r.end.toHex()]),
// ])
// fs.writeFileSync(
// 	"topology.json",
// 	JSON.stringify(serializableTopology, null, 2),
// )


// const makePrincipal = () => {
// 	Ed25519KeyIdentity.generate().getPrincipal()
// }

const makeTestCanister = () => {
	const canisterConfig = {
		wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
		candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
	}
	const test_canister = customCanister(canisterConfig)
		.installArgs(async ({ ctx }) => {
			return []
		})
		.make()

	return {
		canisterConfig,
		canister: test_canister,
	}
}

const initializeCanister = <T extends CustomCanisterScope>(canister: T) =>
	Effect.gen(function* () {
		type TestP = TaskParamsToArgs<typeof canister.children.install>
		const createResult = yield* runTask(canister.children.create)
		const { wasmPath, candidPath } = yield* runTask(canister.children.build)
		const { didJSPath, didTSPath } = yield* runTask(
			canister.children.bindings,
			{},
		)
		return {
			canisterId: createResult,
			wasmPath,
			candidPath,
			didJSPath,
			didTSPath,
		}
	})

describe("custom builder", () => {
	it("deploy should work", async () => {
		const test_canister = customCanister({
			// TODO: no empty strings!
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		}).make()
		const taskTree = {
			test_canister,
		}
		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-1")
		const result = await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(test_canister.children.deploy).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)
		expect(result).toMatchObject({
			canisterId: expect.any(String),
			canisterName: expect.any(String),
		})
	})

	// TODO: If other tests run before this, it breaks.
	// need to make sure side-effects dont affect other tests
	// maybe clean up tasks after each test
	// reset pocket ic state etc.
	it("should execute canister tasks in correct dependency order", async () => {
		const { canister: test_canister22 } = makeTestCanister()

		const taskTree = {
			test_canister22: test_canister22,
		}

		const { runtime, telemetryExporter } = makeTestEnvEffect(".ice_test/custom-builder-2")

		await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				yield* runTask(test_canister22.children.deploy).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
			}).pipe(Effect.scoped),
		)
		const executionOrder = telemetryExporter
			.getFinishedSpans()
			.filter((s) => s.name === "task_execute_effect")

		console.log(telemetryExporter.getFinishedSpans())
		console.log(executionOrder)
		console.log(executionOrder.length)
		expect(executionOrder).toHaveLength(5)

		// Should execute in dependency order: create, build, bindings, install_args, install
		expect(
			executionOrder.filter(
				(s) => s.attributes?.["taskPath"] === "test_canister22:create",
			).length > 0,
		).toBeTruthy()
		expect(
			executionOrder.filter(
				(s) => s.attributes?.["taskPath"] === "test_canister22:build",
			).length > 0,
		).toBeTruthy()
		expect(
			executionOrder.filter(
				(s) =>
					s.attributes?.["taskPath"] === "test_canister22:bindings",
			).length > 0,
		).toBeTruthy()
		expect(
			executionOrder.filter(
				(s) => s.attributes?.["taskPath"] === "test_canister22:install",
			).length > 0,
		).toBeTruthy()

		// Create should be first
		// expect(executionOrder.indexOf("Create custom canister")).toBeLessThan(
		// 	executionOrder.indexOf("Build custom canister"),
		// )
		// expect(executionOrder.indexOf("Build custom canister")).toBeLessThan(
		// 	executionOrder.indexOf("Install canister code"),
		// )
	})

	it("should handle multiple independent canisters", async () => {
		const canister1 = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		}).make()

		const canister2 = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		}).make()

		const taskTree = {
			canister1,
			canister2,
		}

		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-3")

		// Deploy both canisters
		const results = await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result1 = yield* runTask(canister1.children.deploy).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				const result2 = yield* runTask(canister2.children.deploy).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return [result1, result2]
			}).pipe(Effect.scoped),
		)

		expect(results).toHaveLength(2)
		expect(results[0]!).toMatchObject({
			canisterId: expect.any(String),
			canisterName: expect.any(String),
		})
		expect(results[1]!).toMatchObject({
			canisterId: expect.any(String),
			canisterName: expect.any(String),
		})

		// Should have different canister IDs
		expect(results[0]!.canisterId).not.toBe(results[1]!.canisterId)
	})

	it("should handle canister dependencies", async () => {
		const dependency_canister = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		})
			.installArgs(async ({ ctx }) => {
				return []
			})
			.make()

		const main_canister = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		})
			.dependsOn({
				dependency_canister,
			})
			.deps({
				dependency_canister,
			})
			.installArgs(async ({ ctx, deps }) => {
				// Use the dependency canister in install args
				expect(deps.dependency_canister.canisterId).toBeTruthy()
				return []
			})
			.make()

		const taskTree = {
			dependency_canister,
			main_canister,
		}

		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-4")

		const result = await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				// const result1 = yield* runTask(dependency_canister.children.deploy)
				// TODO: deps dont work?
				const result = yield* runTask(main_canister.children.deploy).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		expect(result).toMatchObject({
			canisterId: expect.any(String),
			canisterName: expect.any(String),
		})
	})

	it("should handle task failure propagation", async () => {
		const failing_canister = customCanister(() => {
			throw new Error("Configuration failed")
		}).make()

		const taskTree = {
			failing_canister,
		}

		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-5")

		await expect(
			runtime.runPromise(
				Effect.gen(function* () {
					const globalArgs = {
						network: "local",
						logLevel: "debug",
						background: false,
						policy: "reuse",
						origin: "cli",
					} as const
					const config = {} satisfies Partial<ICEConfig>
					const ICEConfigLayer = ICEConfigService.Test(
						globalArgs,
						taskTree,
						config,
					)
					const KVStorageImpl = yield* KeyValueStore.KeyValueStore
					const KVStorageLayer = Layer.succeed(
						KeyValueStore.KeyValueStore,
						KVStorageImpl,
					)
					const DeploymentsLayer = DeploymentsService.Live.pipe(
						Layer.provide(KVStorageLayer),
					)
					const { taskLayer, runtime: taskRuntime } =
						yield* makeTaskLayer(globalArgs).pipe(
							Effect.provide(ICEConfigLayer),
							Effect.provide(DeploymentsLayer),
						)
					const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
						runtime: taskRuntime,
						taskLayer,
					})
					const result = yield* runTask(
						failing_canister.children.deploy,
					).pipe(
						Effect.provide(ChildTaskRuntimeLayer),
						Effect.provide(taskLayer),
					)
					return result
				}).pipe(Effect.scoped),
			),
		).rejects.toThrow()
	})

	it("should handle complex dependency chains", async () => {
		const executionOrder: Array<string> = []

		const canister1 = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		}).make()

		const canister2 = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		})
			.dependsOn({
				canister1,
			})
			.deps({
				canister1,
			})
			.installArgs(async ({ ctx, deps }) => {
				executionOrder.push("canister2_install_args")
				return []
			})
			.make()

		const canister3 = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		})
			.dependsOn({
				canister2,
			})
			.deps({
				canister2,
			})
			.installArgs(async ({ ctx, deps }) => {
				executionOrder.push("canister3_install_args")
				return []
			})
			.make()

		const taskTree = {
			canister1,
			canister2,
			canister3,
		}

		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-6")

		await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(canister3.children.deploy).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		// Should execute in dependency order
		expect(executionOrder.indexOf("canister2_install_args")).toBeLessThan(
			executionOrder.indexOf("canister3_install_args"),
		)
	})

	it("should handle concurrent canister deployments with limits", async () => {
		const concurrentCounter = Ref.unsafeMake(0)
		const maxConcurrent = Ref.unsafeMake(0)

		const createTimedCanister = (name: string) => {
			return customCanister({
				wasm: path.resolve(
					__dirname,
					"../fixtures/canister/example.wasm",
				),
				candid: path.resolve(
					__dirname,
					"../fixtures/canister/example.did",
				),
			})
				.installArgs(async ({ ctx }) => {
					const current = await Effect.runPromise(
						Ref.updateAndGet(concurrentCounter, (n) => n + 1),
					)
					await Effect.runPromise(
						Ref.update(maxConcurrent, (max) =>
							Math.max(max, current),
						),
					)
					// Simulate work
					await new Promise((resolve) => setTimeout(resolve, 30))
					await Effect.runPromise(
						Ref.update(concurrentCounter, (n) => n - 1),
					)
					return []
				})
				.make()
		}

		const canister1 = createTimedCanister("canister1")
		const canister2 = createTimedCanister("canister2")
		const canister3 = createTimedCanister("canister3")

		const taskTree = {
			canister1,
			canister2,
			canister3,
		}
		const tasks = [
			canister1.children.deploy,
			canister2.children.deploy,
			canister3.children.deploy,
		]

		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-7")

		await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const results = yield* runTasks(
					tasks.map((t) => ({
						...t,
						// TODO?
						args: { mode: "auto" as const },
					})),
				).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return results
			}).pipe(Effect.scoped),
		)

		const maxReached = runtime.runSync(Ref.get(maxConcurrent))
		expect(maxReached).toBeLessThanOrEqual(2)
	})

	it("should handle cache invalidation with different configurations", async () => {
		let configVersion = 1

		const dynamic_canister = customCanister(({ ctx }) => ({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		}))
			.installArgs(async ({ ctx }) => {
				return []
			})
			.make()

		const taskTree = {
			dynamic_canister,
		}

		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-8")

		// First run with configVersion = 1
		const firstResult = await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(dynamic_canister.children.deploy).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		expect(firstResult).toMatchObject({
			canisterId: expect.any(String),
			canisterName: expect.any(String),
		})

		// Change configuration
		configVersion = 2

		// Second run should re-execute due to configuration change
		const secondResult = await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(dynamic_canister.children.deploy).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		expect(secondResult).toMatchObject({
			canisterId: expect.any(String),
			canisterName: expect.any(String),
		})
	})

	it("should handle different install modes", async () => {
		const test_canister_install_mode = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		}).make()

		const taskTree = {
			test_canister_install_mode,
		}

		// Test with install mode
		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-9")

		const result = await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(
					test_canister_install_mode.children.deploy,
				).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		expect(result).toMatchObject({
			canisterId: expect.any(String),
			canisterName: expect.any(String),
			mode: "install",
		})
	})

	it("should handle canister stop and remove tasks", async () => {
		const test_canister = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		}).make()

		const taskTree = {
			test_canister,
		}

		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-10")

		// First deploy the canister
		await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(test_canister.children.deploy).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		// Then stop it
		await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(test_canister.children.stop).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		// Then remove it
		await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(test_canister.children.remove).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		// Should complete without errors
		expect(true).toBe(true)
	})

	it("should handle canister status task", async () => {
		const test_canister = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		}).make()

		const taskTree = {
			test_canister,
		}

		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-11")

		// Deploy the canister first
		await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(test_canister.children.deploy).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		// Check status
		const statusResult = await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(test_canister.children.status).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		expect(statusResult).toMatchObject({
			canisterName: expect.any(String),
			canisterId: expect.any(String),
			status: expect.any(String),
		})
	})

	it("should handle mixed cached and non-cached canister tasks", async () => {
		let executionOrder: Array<string> = []

		const test_canister = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		})
			.installArgs(async ({ ctx }) => {
				executionOrder.push("install_executed")
				return []
			})
			.make()

		const taskTree = {
			test_canister,
		}
		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-12")

		const res = await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const { canisterId } = yield* runTask(
					test_canister.children.deploy,
				).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return canisterId
			}).pipe(Effect.scoped),
		)
		const canisterId = res

		const canisterConfig = {
			canisterId: canisterId,
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		}

		await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(test_canister.children.deploy, {
					mode: "reinstall",
					...canisterConfig,
				}).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		// expect(executionOrder).toContain("install_args_executed")

		// Reset execution order
		executionOrder = []

		// Second run - install_args should be cached, but install might run again
		await runtime.runPromise(
			Effect.gen(function* () {
				// TODO: it runs upgrade even though we set "reinstall"
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(test_canister.children.deploy, {
					mode: "reinstall",
					...canisterConfig,
				}).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		// install should be cached (not executed again)
		expect(executionOrder).not.toContain("install_executed")
	})

	it("should handle error propagation in canister dependency chains", async () => {
		const failing_canister = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		})
			.installArgs(async ({ ctx }) => {
				throw new Error("Install args failed")
			})
			.make()

		const dependent_canister = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		})
			.dependsOn({
				failing: failing_canister.children.install,
			})
			.deps({
				failing: failing_canister.children.install,
			})
			.installArgs(async ({ ctx, deps }) => {
				return []
			})
			.make()

		const taskTree = {
			failing_canister,
			dependent_canister,
		}

		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-13")

		await expect(
			runtime.runPromise(
				Effect.gen(function* () {
					const globalArgs = {
						network: "local",
						logLevel: "debug",
						background: false,
						policy: "reuse",
						origin: "cli",
					} as const
					const config = {} satisfies Partial<ICEConfig>
					const ICEConfigLayer = ICEConfigService.Test(
						globalArgs,
						taskTree,
						config,
					)
					const KVStorageImpl = yield* KeyValueStore.KeyValueStore
					const KVStorageLayer = Layer.succeed(
						KeyValueStore.KeyValueStore,
						KVStorageImpl,
					)
					const DeploymentsLayer = DeploymentsService.Live.pipe(
						Layer.provide(KVStorageLayer),
					)
					const { taskLayer, runtime: taskRuntime } =
						yield* makeTaskLayer(globalArgs).pipe(
							Effect.provide(ICEConfigLayer),
							Effect.provide(DeploymentsLayer),
						)
					const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
						runtime: taskRuntime,
						taskLayer,
					})
					const result = yield* runTask(
						dependent_canister.children.deploy,
					).pipe(
						Effect.provide(ChildTaskRuntimeLayer),
						Effect.provide(taskLayer),
					)
					return result
				}).pipe(Effect.scoped),
			),
		).rejects.toThrow()
	})

	it("should handle complex branching with multiple dependencies", async () => {
		const executionOrder: Array<string> = []

		const branching_root_canister = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		})
			.installArgs(async ({ ctx }) => {
				executionOrder.push("root")
				return []
			})
			.make()

		const branching_branch1_canister = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		})
			.deps({
				branching_root_canister,
			})
			.installArgs(async ({ ctx, deps }) => {
				executionOrder.push("branch1")
				return []
			})
			.make()

		const branching_branch2_canister = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		})
			.deps({
				branching_root_canister,
			})
			.installArgs(async ({ ctx, deps }) => {
				executionOrder.push("branch2")
				return []
			})
			.make()

		const branching_convergence_canister = customCanister({
			wasm: path.resolve(__dirname, "../fixtures/canister/example.wasm"),
			candid: path.resolve(__dirname, "../fixtures/canister/example.did"),
		})
			.deps({
				branching_branch1_canister,
				branching_branch2_canister,
			})
			.installArgs(async ({ ctx, deps }) => {
				executionOrder.push("convergence")
				return []
			})
			.make()

		const taskTree = {
			branching_root_canister,
			branching_branch1_canister,
			branching_branch2_canister,
			branching_convergence_canister,
		}

		const { runtime, telemetryExporter } = makeTestEnvEffect("ice_test/custom-builder-14")

		await runtime.runPromise(
			Effect.gen(function* () {
				const globalArgs = {
					network: "local",
					logLevel: "debug",
					background: false,
					policy: "reuse",
					origin: "cli",
				} as const
				const config = {} satisfies Partial<ICEConfig>
				const ICEConfigLayer = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const { taskLayer, runtime: taskRuntime } =
					yield* makeTaskLayer(globalArgs).pipe(
						Effect.provide(ICEConfigLayer),
						Effect.provide(DeploymentsLayer),
					)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: taskRuntime,
					taskLayer,
				})
				const result = yield* runTask(
					branching_convergence_canister.children.deploy,
				).pipe(
					Effect.provide(ChildTaskRuntimeLayer),
					Effect.provide(taskLayer),
				)
				return result
			}).pipe(Effect.scoped),
		)

		console.log(executionOrder)
		// Root should be first, convergence should be last
		expect(executionOrder[0]).toBe("root")
		expect(executionOrder[3]).toBe("convergence")
		// Branch1 and branch2 can run in parallel after root
		expect(executionOrder.slice(1, 3).sort()).toEqual([
			"branch1",
			"branch2",
		])
	})
})
