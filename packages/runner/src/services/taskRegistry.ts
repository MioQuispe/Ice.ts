import { KeyValueStore } from "@effect/platform"
import { PlatformError } from "@effect/platform/Error"
import { Context, Effect, Layer, Option } from "effect"

export class TaskRegistry extends Context.Tag("TaskRegistry")<
	TaskRegistry,
	{
		readonly set: (
			cacheKey: string,
			result: string | Uint8Array<ArrayBufferLike>,
		) => Effect.Effect<void, PlatformError>
		readonly get: (
			cacheKey: string,
			format: "string" | "uint8array",
		) => Effect.Effect<
			Option.Option<string | Uint8Array<ArrayBufferLike>>,
			PlatformError
		>
		readonly has: (
			cacheKey: string,
		) => Effect.Effect<boolean, PlatformError>
	}
>() {
	static Live = Layer.effect(
		TaskRegistry,
		Effect.gen(function* () {
			// TODO: persist certain task results?
			// const kv = new Map<string, unknown>()
			// TODO: cant use symbol as key. use taskPath?

            // TODO: use built-in Cache from effect?
			const kv = yield* KeyValueStore.KeyValueStore
			return {
				set: (cacheKey, result) =>
					Effect.gen(function* () {
						// TODO: Effect.try
						// const serializedResult = yield* Effect.try({
						//   try: () => JSON.stringify(result),
						//   catch: (error) => {
						//     console.error(error)
						//     return Effect.fail(error)
						//   },
						// })
						yield* Effect.logDebug(
							"writing to cache:",
							cacheKey,
							// , result
						)
						yield* kv.set(cacheKey, result)
						// kv.set(cacheKey, result)
					}),
				get: (
					cacheKey: string,
					format: "string" | "uint8array" = "string",
				) =>
					Effect.gen(function* () {
						// return yield* kv.get(cacheKey)
						if (format === "uint8array") {
							const result = yield* kv.getUint8Array(cacheKey)
							return result
						}
						if (format === "string") {
							const result = yield* kv.get(cacheKey)
							return result
						}
						return Option.none()
					}),
				has: (cacheKey) =>
					Effect.gen(function* () {
						const has = yield* kv.has(cacheKey)
						return has
					}),
			}
		}),
	)
}
