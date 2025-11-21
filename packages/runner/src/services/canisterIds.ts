import { FileSystem, Path } from "@effect/platform"
import { Config, Context, Effect, Layer, Record, Ref } from "effect"
import { IceDir } from "./iceDir.js"

/**
 * Represents the canister IDs stored in memory.
 */
export type CanisterIds = Record<string, Record<string, string>>

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/**
 * Live implementation of the CanisterIdsService.
 *
 * This service maintains the mutable in-memory state of canister IDs and
 * provides methods to get, update, remove, and flush the state to disk.
 *
 * It also provides an auto flush mechanism so that you can periodically persist
 * your in-memory changes.
 */
export class CanisterIdsService extends Context.Tag("CanisterIdsService")<
	CanisterIdsService,
	{
		// readonly canisterIds: CanisterIds
		/**
		 * Retrieves the current in-memory canister IDs.
		 */
		getCanisterIds: () => Effect.Effect<CanisterIds>
		/**
		 * Updates the canister ID for a specific canister and network.
		 */
		setCanisterId: (params: {
			canisterName: string
			network: string
			canisterId: string
		}) => Effect.Effect<void>
		/**
		 * Removes the canister ID for the given canister name.
		 */
		removeCanisterId: (canisterName: string) => Effect.Effect<void>
		/**
		 * Flushes the in-memory canister IDs to the canister_ids.json file.
		 */
		flush: () => Effect.Effect<void>
	}
>() {
	static readonly Live = Layer.scoped(
		CanisterIdsService,
		Effect.gen(function* () {
			yield* Effect.logInfo("[TIMING] CanisterIdsService.Live started")
			const start = performance.now()
			// Initialize the state from disk
			const initialIds = yield* readInitialCanisterIds
			yield* Effect.logInfo(
				`[TIMING] CanisterIdsService readInitialCanisterIds took ${performance.now() - start}ms`,
			)
			const ref = yield* Ref.make(initialIds)
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const { path: iceDirPath } = yield* IceDir

			/**
			 * Flushes in-memory canister IDs to disk only if there are changes.
			 */
			const flush = Effect.gen(function* () {
				const canisterIdsPath = path.join(iceDirPath, "canister_ids.json")
				const currentIds = yield* Ref.get(ref)

				yield* fs.writeFile(
					canisterIdsPath,
					Buffer.from(JSON.stringify(currentIds, null, 2)),
					// {
					//   flag: "w",
					// }
				)
			}).pipe(
				Effect.catchAll((error) =>
					Effect.logError("Failed to flush canister IDs to disk", error),
				),
			)

			// Ensure a final flush on shutdown
			yield* Effect.addFinalizer(() => flush)

			return {
				getCanisterIds: () => Ref.get(ref),
				setCanisterId: ({ canisterName, network, canisterId }) =>
					Effect.gen(function* () {
						yield* Ref.update(ref, (ids) => ({
							...ids,
							[canisterName]: {
								...(ids[canisterName] ?? {}),
								[network]: canisterId,
							},
						}))
						// TODO: not a bottleneck?
						yield* flush
					}),
				removeCanisterId: (canisterName: string) =>
					Effect.gen(function* () {
						yield* Ref.update(ref, (ids) => {
							const newIds = Object.fromEntries(
								Object.entries(ids).filter(([name]) => name !== canisterName),
							)
							return newIds
						})
						yield* flush
					}),
				flush: () => flush,
			}
		}),
	)

	static readonly Test = Layer.effect(
		CanisterIdsService,
		Effect.gen(function* () {
			let testCanisterIds: CanisterIds = {}
			return CanisterIdsService.of({
				getCanisterIds: () => Effect.gen(function* () {
					return testCanisterIds
				}),
				setCanisterId: (params: {
					canisterName: string
					network: string
					canisterId: string
				}) =>
					Effect.gen(function* () {
						testCanisterIds = {
							...testCanisterIds,
							[params.canisterName]: {
								...(testCanisterIds[params.canisterName] ?? {}),
								[params.network]: params.canisterId,
							},
						}
					}),
				removeCanisterId: (canisterName: string) =>
					Effect.gen(function* () {
						testCanisterIds = Record.filter(
							testCanisterIds,
							(_, key) => key !== canisterName,
						)
					}),
				flush: () => Effect.gen(function* () {}),
			})
		}),
	)
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Reads the initial canister IDs from disk.
 * If the file does not exist, an empty object is returned.
 */
const readInitialCanisterIds = Effect.gen(function* readInitialCanisterIds() {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const {path: iceDirPath} = yield* IceDir
	const canisterIdsPath = path.join(iceDirPath, "canister_ids.json")
	const exists = yield* fs.exists(canisterIdsPath)
	if (!exists) return {}
	const content = yield* fs.readFileString(canisterIdsPath)
	const result = yield* Effect.try(
		() => JSON.parse(content) as CanisterIds,
	).pipe(Effect.orElseSucceed(() => ({}) as CanisterIds))
	return result
})
