import { canister } from "@ice.ts/runner"
import * as url from "node:url"
import path from "node:path"
import type { TaskCtx } from "@ice.ts/runner"
import type { _SERVICE } from "./signer_ic.types.js"

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))
const canisterName = "signer_ic"

type InitArgs = []
/**
 * Creates an instance of the SignerIc canister.
 * @param initArgsOrFn Initialization arguments or a function returning them.
 * @returns A canister instance.
 */
export const NFIDSignerIc = (
	initArgsOrFn?:
		| { canisterId?: string }
		| ((args: { ctx: TaskCtx }) => { canisterId?: string }),
) =>
	canister
		.custom(({ ctx }) => {
			const initArgs =
				typeof initArgsOrFn === "function"
					? initArgsOrFn({ ctx })
					: initArgsOrFn
			return {
				canisterId: initArgs?.canisterId,
				wasm: path.resolve(
					__dirname,
					`./nfid/${canisterName}/${canisterName}.wasm.gz`,
				),
				candid: path.resolve(
					__dirname,
					`./nfid/${canisterName}/${canisterName}.did`,
				),
			}
		})
		.as<_SERVICE, InitArgs>()
		.installArgs(async ({ ctx }) => {
			// TODO: Add installation logic if needed.
			const initArgs =
				typeof initArgsOrFn === "function"
					? initArgsOrFn({ ctx })
					: initArgsOrFn
			return []
		})

NFIDSignerIc.remote = (canisterId: string) => {
	return canister.remote({
		canisterId,
		candid: path.resolve(
			__dirname,
			`./nfid/${canisterName}/${canisterName}.did`,
		),
	}).as<_SERVICE, InitArgs>()
}
