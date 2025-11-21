import { Effect, Data, Layer, Context } from "effect"
import { CommandExecutor, Command, Path, FileSystem } from "@effect/platform"
import * as Motoko from "motoko"
import { PlatformError } from "@effect/platform/Error"

// Error types
export class MocError extends Data.TaggedError("MocError")<{
	readonly message: string
}> {}

export class Moc extends Context.Tag("Moc")<
	Moc,
	{
		readonly compile: (
			src: string,
			wasmOutputFilePath: string,
			outCandidPath: string,
		) => Effect.Effect<void, MocError | PlatformError>
		readonly version: string
	}
>() {
	static Live = Layer.effect(
		Moc,
		Effect.gen(function* () {
			const start = performance.now()
			const moc = Motoko.default.default
			const fs = yield* FileSystem.FileSystem

			return Moc.of({
				version: moc.version,
				compile: (src, outWasmPath, outCandidPath) =>
					Effect.gen(function* () {
                        // TODO: child_process?
                        const moFile = moc.file(src)
                        const srcContents = yield* fs.readFileString(src)
                        moFile.write(srcContents)
                        const wasmResult = moFile.wasm("ic")
                        yield* fs.writeFile(outWasmPath, wasmResult.wasm)
                        yield* fs.writeFileString(outCandidPath, wasmResult.candid)
					}),
			})
		}),
	)

	static Dfx = Layer.effect(
		Moc,
		Effect.gen(function* () {
			const start = performance.now()
			const commandExecutor = yield* CommandExecutor.CommandExecutor
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const mocPath = process.env["DFX_MOC_PATH"]
			const command = Command.make("dfx", "cache", "show")
			const dfxCachePath = `${(yield* commandExecutor.string(command)).trim()}/moc`
			const resolvedMocPath = mocPath || dfxCachePath || "moc"

			const startVersion = performance.now()
			const versionCommand = Command.make(resolvedMocPath, "--version")
			const version = yield* commandExecutor.string(versionCommand)

			if (!resolvedMocPath) {
				return yield* Effect.fail(
					new MocError({
						message: "Moc not found",
					}),
				)
			}

			return Moc.of({
				version,
				// // TODO: investigate if these can run in parallel
				// generateCandid: (src, output) =>
				//   Effect.gen(function* () {
				//     const command = Command.make(
				//       resolvedPath,
				//       "--idl",
				//       src,
				//       "-o",
				//       output,
				//     )
				//     yield* commandExecutor.string(command).pipe(
				//       Effect.mapError(
				//         (err) =>
				//           new MocError({
				//             message: `Failed to generate IDL: ${err.message}`,
				//           }),
				//       ),
				//     )
				//   }),
				compile: (src, output) =>
					Effect.gen(function* () {
						const command = Command.make(
							resolvedMocPath,
							"--idl",
							"-c",
							"-v",
							src,
							"-o",
							output,
						)
						// TODO: this swallows all errors!
						yield* commandExecutor.string(command).pipe(
							Effect.mapError((err) => {
								console.error("Failed to compile Motoko", err)
								return new MocError({
									message: `Failed to compile Motoko: ${err.message}`,
								})
							}),
						)
					}),
			})
		}),
	)
}
