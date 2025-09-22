import { KeyValueStore } from "@effect/platform"
import { PlatformError } from "@effect/platform/Error"
import { Context, Effect, Layer, Option, Deferred } from "effect"
import { TaskExecResult } from "../tasks/lib.js"

export class InFlight extends Context.Tag("InFlight")<
	InFlight,
	{
		readonly set: (
			cacheKey: string,
			result: Deferred.Deferred<TaskExecResult<unknown>, unknown>,
		) => Effect.Effect<void, PlatformError>
		readonly remove: (
			cacheKey: string,
		) => Effect.Effect<void, PlatformError>
		readonly get: (
			cacheKey: string,
		) => Effect.Effect<Option.Option<Deferred.Deferred<TaskExecResult<unknown>, unknown>>, PlatformError>
		readonly has: (
			cacheKey: string,
		) => Effect.Effect<boolean, PlatformError>
	}
>() {
	static Live = Layer.effect(
		InFlight,
		Effect.gen(function* () {
			// TODO: persist certain task results?
			// const inflight = yield* KeyValueStore.KeyValueStore
			const inflight = new Map<
				string,
				Deferred.Deferred<TaskExecResult<unknown>, unknown>
			>()
			// const store = kv.forSchema
			// TODO: cant use symbol as key. use taskPath?
			// return
			return {
				set: (cacheKey, result) =>
					Effect.gen(function* () {
						inflight.set(cacheKey, result)
					}),
                remove: (cacheKey) =>
					Effect.gen(function* () {
						inflight.delete(cacheKey)
					}),
				get: (cacheKey) =>
					Effect.gen(function* () {
						const result = inflight.get(cacheKey)
						return Option.fromNullable(result)
					}),
				has: (cacheKey) =>
					Effect.gen(function* () {
						return inflight.has(cacheKey)
					}),
			}
		}),
	)
}
