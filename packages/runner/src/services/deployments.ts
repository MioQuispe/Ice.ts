import { FileSystem, KeyValueStore, Path } from "@effect/platform"
import { Config, Context, Effect, Layer, Record, Ref, Option } from "effect"
import { IceDir } from "./iceDir.js"
import { InstallModes } from "./replica.js"
import { PlatformError } from "@effect/platform/Error"

export type Deployment = {
	mode: InstallModes
	installArgsHash: string
	upgradeArgsHash: string
	wasmHash: string
	updatedAt: number
}
export type Deployments = Record<string, Record<string, string>>

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

export class DeploymentsService extends Context.Tag("DeploymentsService")<
	DeploymentsService,
	{
		// readonly canisterIds: CanisterIds
		/**
		 * Retrieves the current in-memory canister IDs.
		 */
		get: (
			canisterName: string,
			network: string,
		) => Effect.Effect<Option.Option<Deployment>, PlatformError>
		/**
		 * Updates the canister ID for a specific canister and network.
		 */
		set: (params: {
			canisterName: string
			network: string
			deployment: Deployment
		}) => Effect.Effect<void, PlatformError>
	}
>() {
	static readonly Live = Layer.scoped(
		DeploymentsService,
		Effect.gen(function* () {
			// Initialize the state from disk
			// const initialIds = yield* readInitialDeployments
			// const ref = yield* Ref.make(initialIds)
			// const fs = yield* FileSystem.FileSystem
			// const path = yield* Path.Path
			// const {path: iceDirPath} = yield* IceDir
			const kv = yield* KeyValueStore.KeyValueStore

			return {
				get: (canisterName, network) =>
					Effect.gen(function* () {
						const deployment = yield* kv.get(
							`${canisterName}:${network}`,
						)
						const parsedDeployment = Option.map(
							deployment,
							(v) => JSON.parse(v) as unknown as Deployment,
						)
						return parsedDeployment
						// return JSON.parse(deployment) as unknown as Deployment
						// kv.get(`${canisterName}:${network}`),
					}),
				set: ({ canisterName, network, deployment }) =>
					Effect.gen(function* () {
						yield* kv.set(
							`${canisterName}:${network}`,
							JSON.stringify(deployment),
						)
					}),
			}
		}),
	)

	// static readonly Test = Layer.effect(
	// 	DeploymentsService,
	// 	Effect.gen(function* () {
	// 		let testDeployments: Deployments = {}
	// 		return DeploymentsService.of({
	// 			getDeployments: () => Effect.gen(function* () {
	// 				return testDeployments
	// 			}),
	// 			setDeployment: (params: {
	// 				canisterName: string
	// 				network: string
	// 				deployment: Deployment
	// 			}) =>
	// 				Effect.gen(function* () {
	// 					testDeployments = {
	// 						...testCanisterIds,
	// 						[params.canisterName]: {
	// 							...(testDeployments[params.canisterName] ?? {}),
	// 							[params.network]: params.deployment,
	// 						},
	// 					}
	// 				}),
	// 		})
	// 	}),
	// )
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Reads the initial canister IDs from disk.
 * If the file does not exist, an empty object is returned.
 */
// const readInitialDeployments = Effect.gen(function* readInitialDeployments() {
// 	const fs = yield* FileSystem.FileSystem
// 	const path = yield* Path.Path
// 	const {path: iceDirPath} = yield* IceDir
// 	const deploymentsPath = path.join(iceDirPath, "deployments.json")
// 	const exists = yield* fs.exists(deploymentsPath)
// 	if (!exists) return {}
// 	const content = yield* fs.readFileString(deploymentsPath)
// 	const result = yield* Effect.try(
// 		() => JSON.parse(content) as Deployments,
// 	).pipe(Effect.orElseSucceed(() => ({}) as CanisterIds))
// 	return result
// })
