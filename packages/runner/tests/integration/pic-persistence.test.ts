import path from "node:path"
import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity"
import { Principal } from "@icp-sdk/core/principal"

import { makeTestEnvEffect, makeTaskRunner } from "./setup.js"
import fs from "node:fs"
import { customCanister } from "../../src/builders/index.js"
import { DefaultReplica } from "../../src/services/replica.js"

import { idlFactory as exampleIdlFactory } from "../fixtures/canister/example.did.js"
import type { _SERVICE as ExampleService } from "../fixtures/canister/example.did.ts"
import { KeyValueStore } from "@effect/platform"
import { DeploymentsService } from "../../src/services/deployments.js"
import { ICEConfigService } from "../../src/services/iceConfig.js"
import { ICEConfig } from "../../src/types/types.js"
import { makeTaskLayer, TaskRuntime } from "../../src/services/taskRuntime.js"
import { runTask } from "../../src/tasks/run.js"

const exampleWasm = path.resolve(__dirname, "../fixtures/canister/example.wasm")
const exampleDid = path.resolve(__dirname, "../fixtures/canister/example.did")

const globalArgs = {
	network: "local",
	logLevel: "info",
	background: false,
} as const

const canisterKey = "canister"
const can = customCanister({
	wasm: exampleWasm,
	candid: exampleDid,
}).make()
const taskTree = { can }

describe("PocketIC persistence", () => {
	it("persists canister state across replica restart", async () => {
		const iceDirName = ".ice_test/persist_1"
		// ensure clean state before first run
		try {
			fs.rmSync(
				path.resolve(process.cwd(), iceDirName, "replica-state"),
				{
					recursive: true,
					force: true,
				},
			)
		} catch {}

		// Run A: deploy, set state, verify, shutdown
		const { runtime: runtimeA } = makeTestEnvEffect(iceDirName)

		const { canisterId: canisterIdA } = await runtimeA.runPromise(
			Effect.gen(function* () {
				const config = {} satisfies Partial<ICEConfig>
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const ICEConfig = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const { runtime, taskLayer } = yield* makeTaskLayer(
					globalArgs,
				).pipe(
					Effect.provide(ICEConfig),
					Effect.provide(DeploymentsLayer),
				)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: runtime,
					taskLayer: taskLayer,
				})
				const { canisterId } = yield* runTask(can.children.deploy).pipe(
					Effect.provide(ICEConfig),
					Effect.provide(DeploymentsLayer),
					Effect.provide(ChildTaskRuntimeLayer),
				)
				const replica = yield* DefaultReplica
				const identity = Ed25519KeyIdentity.generate()
				console.log("creating actor")
				const actor = yield* Effect.tryPromise({
					try: () =>
						replica.createActor<ExampleService>({
							canisterId: canisterId,
							canisterDID: { idlFactory: exampleIdlFactory },
							identity,
						}),
					catch: (e) => e as Error,
				})
				console.log("setting name")
				yield* Effect.tryPromise({
					try: () => actor.set_name("Alice"),
					catch: (e) => e as Error,
				})
				console.log("calling greet")
				const greeted = yield* Effect.tryPromise({
					try: () => actor.greet(),
					catch: (e) => e as Error,
				})
				console.log("greeted", greeted)
				expect(greeted).toContain("Alice")
				return { canisterId }
			}),
		)

		// // mutate state in a separate effect using DefaultReplica only
		// await runtimeA.runPromise(
		// 	Effect.gen(function* () {
		// 		const replica = yield* DefaultReplica
		// 		const identity = Ed25519KeyIdentity.generate()
		// 		const actor = yield* Effect.tryPromise({
		// 			try: () =>
		// 				replica.createActor<ExampleService>({
		// 					canisterId: canisterIdA,
		// 					canisterDID: { idlFactory: exampleIdlFactory },
		// 					identity,
		// 				}),
		// 			catch: (e) => e as Error,
		// 		})
		// 		yield* Effect.tryPromise({
		// 			try: () => actor.set_name("Alice"),
		// 			catch: (e) => e as Error,
		// 		})
		// 		const greeted = yield* Effect.tryPromise({
		// 			try: () => actor.greet(),
		// 			catch: (e) => e as Error,
		// 		})
		// 		expect(greeted).toContain("Alice")
		// 	}),
		// )

		console.log("disposing runtimeA")
		await runtimeA.dispose()
		console.log("disposed runtimeA")
		// Give filesystem a brief moment to flush state to disk before restart
		await new Promise((r) => setTimeout(r, 200))

		// Run B: new runtime, same iceDir, verify state is restored
		const { runtime: runtimeB } = makeTestEnvEffect(iceDirName)
		await runtimeB.runPromise(
			Effect.gen(function* () {
				const replica = yield* DefaultReplica
				const identity = Ed25519KeyIdentity.generate()
				// Wait until canister becomes visible after instance restore
				for (let i = 0; i < 50; i++) {
					const status = yield* Effect.tryPromise({
						try: () =>
							replica.getCanisterStatus({
								canisterId: canisterIdA,
								identity,
							}),
						catch: (e) => e as Error,
					})
					if (status !== "not_found") break
					// sleep 100ms within Effect
					yield* Effect.async<void>((resume) => {
						setTimeout(() => resume(Effect.succeed(undefined)), 100)
					})
				}
				const actor = yield* Effect.tryPromise({
					try: () =>
						replica.createActor<ExampleService>({
							canisterId: canisterIdA,
							canisterDID: { idlFactory: exampleIdlFactory },
							identity,
						}),
					catch: (e) => e as Error,
				})

				const greeted = yield* Effect.tryPromise({
					try: () => actor.greet(),
					catch: (e) => e as Error,
				})
				expect(greeted).toContain("Alice")
			}),
		)

		await runtimeB.dispose()
	})

	it("persists topology across replica restart (smoke)", async () => {
		const iceDirName = ".ice_test/persist_2"
		// ensure clean state before first run
		try {
			fs.rmSync(
				path.resolve(process.cwd(), iceDirName, "replica-state"),
				{
					recursive: true,
					force: true,
				},
			)
		} catch {}

		// Run A: start, deploy once to ensure subnets exist, read topology
		const { runtime: runtimeA } = makeTestEnvEffect(iceDirName)
		// deploy
		await runtimeA.runPromise(
			Effect.gen(function* () {
				const config = {} satisfies Partial<ICEConfig>
				const KVStorageImpl = yield* KeyValueStore.KeyValueStore
				const KVStorageLayer = Layer.succeed(
					KeyValueStore.KeyValueStore,
					KVStorageImpl,
				)
				const DeploymentsLayer = DeploymentsService.Live.pipe(
					Layer.provide(KVStorageLayer),
				)
				const ICEConfig = ICEConfigService.Test(
					globalArgs,
					taskTree,
					config,
				)
				const { runtime, taskLayer } = yield* makeTaskLayer(
					globalArgs,
				).pipe(
					Effect.provide(ICEConfig),
					Effect.provide(DeploymentsLayer),
				)
				const ChildTaskRuntimeLayer = Layer.succeed(TaskRuntime, {
					runtime: runtime,
					taskLayer: taskLayer,
				})
				yield* runTask(can.children.deploy).pipe(
					Effect.provide(ICEConfig),
					Effect.provide(DeploymentsLayer),
					Effect.provide(ChildTaskRuntimeLayer),
				)
			}).pipe(Effect.scoped),
		)
		// read topology
		const snapshotA = await runtimeA.runPromise(
			Effect.gen(function* () {
				const replica = yield* DefaultReplica
				const topo = yield* Effect.tryPromise({
					try: () => replica.getTopology(),
					catch: (e) => e as Error,
				})
				return topo
			}),
		)
		expect(Array.isArray(snapshotA)).toBe(true)
		expect(snapshotA.length).toBeGreaterThan(0)
		await runtimeA.dispose()

		// Run B: same iceDir, topology should be non-empty and consistent type-wise
		const { runtime: runtimeB } = makeTestEnvEffect(iceDirName)
		const snapshotB = await runtimeB.runPromise(
			Effect.gen(function* () {
				const replica = yield* DefaultReplica
				const topo = yield* Effect.tryPromise({
					try: () => replica.getTopology(),
					catch: (e) => e as Error,
				})
				return topo
			}),
		)

		expect(snapshotB.length).toBeGreaterThan(0)
		// Ensure Application subnet type exists in both snapshots
		const hasAppA = snapshotA.some((s) => s.type === "Application")
		const hasAppB = snapshotB.some((s) => s.type === "Application")
		expect(hasAppA).toBe(true)
		expect(hasAppB).toBe(true)

		await runtimeB.dispose()
	})
})
