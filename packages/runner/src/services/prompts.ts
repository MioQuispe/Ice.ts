import { Context, Effect, Layer } from "effect"
import { confirm, isCancel, ConfirmOptions } from "@clack/prompts"
import { TaskRuntimeError } from "../tasks/lib.js"

export class PromptsService extends Context.Tag("PromptsService")<
	PromptsService,
	{
		confirm: (
			confirmOptions: ConfirmOptions,
		) => Effect.Effect<boolean, TaskRuntimeError>
	}
>() {
	static readonly Live = Layer.effect(
		PromptsService,
		Effect.gen(function* () {
			// TODO: use it
			const mutex = yield* Effect.makeSemaphore(1)
			return {
				confirm: (confirmOptions: ConfirmOptions) =>
					mutex.withPermits(1)(
						Effect.gen(function* () {
							const result = yield* Effect.tryPromise({
								try: () => confirm(confirmOptions),
								catch: (error) =>
									new TaskRuntimeError({
										message: String(error),
										error,
									}),
							})
							if (typeof result === "symbol") {
								if (isCancel(result)) {
									return false
								}
								// TODO: ???
								return false
							}
							return result
						}),
					),
			}
		}),
	)
}
