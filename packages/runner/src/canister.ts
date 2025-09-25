import { IDL } from "@icp-sdk/core/candid"
import { Command, CommandExecutor, FileSystem, Path } from "@effect/platform"
import * as didc from "@ice.ts/didc_js"
// import d from "@ice.ts/didc_js"
import { Data, Effect } from "effect"
import { Moc } from "./services/moc.js"
import type * as ActorTypes from "./types/actor.js"
import { type TaskCtxShape } from "./services/taskCtx.js"

export class DeploymentError extends Data.TaggedError("DeploymentError")<{
	message: string
}> {}

// TODO: just one place to define this
export type Opt<T> = [T] | []
export const Opt = <T>(value?: T): Opt<T> => {
	return value || value === 0 ? [value] : []
}

export const compileMotokoCanister = (
	src: string,
	canisterName: string,
	wasmOutputFilePath: string,
) =>
	Effect.gen(function* () {
		const moc = yield* Moc
		// Create output directories if they don't exist
		yield* Effect.logDebug(
			`Compiling from ${src}, with name ${canisterName} to ${wasmOutputFilePath}`,
		)
		// TODO: we need to make dirs if they don't exist
		yield* moc.compile(src, wasmOutputFilePath)
		yield* Effect.logDebug(
			`Successfully compiled ${src} ${canisterName} outputFilePath: ${wasmOutputFilePath}`,
		)
		return wasmOutputFilePath
	})


// TODO: types for DIDJS
export const generateDIDJS = (taskCtx: TaskCtxShape, canisterName: string, didPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const { appDir, iceDir } = taskCtx
		const didString = yield* fs.readFileString(didPath)
		const didJSString = didc.did_to_js(didString)
		const didTSString = didc.did_to_ts(didString)
		const didJSPath = path.join(
			iceDir,
			"canisters",
			canisterName,
			`${canisterName}.did.js`,
		)
		const didTSPath = path.join(
			iceDir,
			"canisters",
			canisterName,
			`${canisterName}.did.ts`,
		)
		yield* fs.makeDirectory(path.dirname(didJSPath), { recursive: true })
		yield* fs.writeFile(didJSPath, Buffer.from(didJSString ?? ""))
		yield* fs.writeFile(didTSPath, Buffer.from(didTSString ?? ""))

		const didJS = yield* Effect.tryPromise({
			try: () => import(didJSPath),
			catch: (error) =>
				new DeploymentError({
					message: `Failed to import canister DID: ${error instanceof Error ? error.message : String(error)}`,
				}),
		})

		if (!didJS) {
			return yield* Effect.fail(
				new DeploymentError({ message: "Failed to convert DID to JS" }),
			)
		}
		return {
			didJS,
			didJSPath,
			didTSPath,
		}
	})

/**
 * Represents the expected structure of a dynamically imported DID module.
 */
export interface CanisterDidModule {
	idlFactory: IDL.InterfaceFactory
	init: (args: { IDL: typeof IDL }) => IDL.Type[]
}

export const encodeArgs = (args: unknown[], canisterDID: CanisterDidModule) =>
	Effect.gen(function* () {
		return yield* Effect.try({
			try: () => {
				const encodedArgs = args
					? new Uint8Array(IDL.encode(canisterDID.init({ IDL }), args))
					: new Uint8Array()
				return encodedArgs
			},
			catch: (error) => {
				// TODO: change error type
				return new DeploymentError({
					message: `Failed to encode args: ${error instanceof Error ? error.message : String(error)}, with args: ${args}`,
				})
			},
		})
	})
export const encodeUpgradeArgs = (args: unknown[], canisterDID: CanisterDidModule) =>
	Effect.gen(function* () {
		return yield* Effect.try({
			try: () => {
				const encodedArgs = args
					? new Uint8Array(IDL.encode(canisterDID.init({ IDL }), args))
					: new Uint8Array()
				return encodedArgs
			},
			catch: (error) => {
				// TODO: change error type
				return new DeploymentError({
					message: `Failed to encode args: ${error instanceof Error ? error.message : String(error)}, with args: ${args}`,
				})
			},
		})
	})