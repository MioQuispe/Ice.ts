import { Context, Effect, Layer } from "effect"
import { confirm, isCancel, ConfirmOptions } from "@clack/prompts"
import * as p from "@clack/prompts"
import { TaskRuntimeError } from "../tasks/lib.js"
import {
	setPromptActive,
	uiSpinnerStart,
	uiSpinnerMessage,
	uiSpinnerStop,
} from "./logger.js"
// No coordinator needed with single-writer logger

export class PromptsService extends Context.Tag("PromptsService")<
	PromptsService,
	{
		confirm: (
			confirmOptions: ConfirmOptions,
		) => Effect.Effect<boolean, TaskRuntimeError>
		Spinner: () => Effect.Effect<
			{
				start: (msg?: string) => void
				stop: (msg?: string, code?: number) => void
				message: (msg?: string) => void
			},
			never
		>
	}
>() {
	static readonly Live = Layer.effect(
		PromptsService,
		Effect.gen(function* () {
			// TODO: use it
			const mutex = yield* Effect.makeSemaphore(1)
			return {
				Spinner: () =>
					Effect.gen(function* () {
						return {
							start: (msg?: string) => uiSpinnerStart(msg),
							stop: (msg?: string, code?: number) =>
								uiSpinnerStop(msg, code),
							message: (msg?: string) => uiSpinnerMessage(msg),
						}
					}),
				confirm: (confirmOptions: ConfirmOptions) =>
					mutex.withPermits(1)(
						Effect.gen(function* () {
							setPromptActive(true)
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
									setPromptActive(false)
									return false
								}
								setPromptActive(false)
								return false
							}
							setPromptActive(false)
							return result
						}),
					),
			}
		}),
	)
}
