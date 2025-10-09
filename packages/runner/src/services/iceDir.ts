import { Context, Effect, Layer, Config } from "effect"
import { Path, FileSystem } from "@effect/platform"

export class IceDir extends Context.Tag("IceDir")<
	IceDir,
	{
		// isRootTask: boolean
		// TODO: cli flags etc.
		path: string
	}
>() {
	static Live = ({ iceDirName }: { iceDirName: string }) =>
		Layer.scoped(
			IceDir,
			Effect.gen(function* () {
				const appDir = yield* Config.string("APP_DIR")
				// const iceDirName = yield* Config.string("ICE_DIR_NAME")
				const path = yield* Path.Path
				const fs = yield* FileSystem.FileSystem

				const iceDirPath = path.join(appDir, iceDirName)
				const dirExists = yield* fs.exists(iceDirPath)
				if (!dirExists) {
					yield* fs.makeDirectory(iceDirPath)
				}
				// const iceDirPath =
				return {
					path: iceDirPath,
				}
			}),
		)
	static Test = ({ iceDirName }: { iceDirName: string }) =>
		Layer.scoped(
			IceDir,
			Effect.gen(function* () {
				const appDir = yield* Config.string("APP_DIR")
				// const iceDirName = yield* Config.string("ICE_DIR_NAME")
				const path = yield* Path.Path
				const fs = yield* FileSystem.FileSystem

				const iceDirPath = path.join(appDir, iceDirName)
				// const dirExists = yield* fs.exists(iceDirPath)
				// if (!dirExists) {
				yield* fs.makeDirectory(iceDirPath, { recursive: true })
				yield* Effect.addFinalizer((exit) =>
					Effect.gen(function* () {
						// const result = yield* fs
						// 	.remove(iceDirPath, {
						// 		recursive: true,
						// 		force: true,
						// 	})
						// 	.pipe(
						// 		Effect.catchAll((error) => {
						// 			return Effect.logError(
						// 				"Failed to remove ice dir",
						// 				error,
						// 			)
						// 		}),
						// 	)
						return
					}),
				)
				return {
					path: iceDirPath,
				}
			}),
		)
}
