import { canister, Opt } from "@ice.ts/runner"
import * as url from "node:url"
import path from "node:path"
import type { TaskCtx } from "@ice.ts/runner"
import type { _SERVICE } from "./icrc1_registry.types"
import { Principal } from "@dfinity/principal"
import { NFIDIdentityManager } from "../identity_manager/index.js"
const __dirname = url.fileURLToPath(new URL(".", import.meta.url))
const canisterName = "icrc1_registry"

type NFIDIcrc1RegistryInitArgs = {
	canisterId?: string
}
// const Conf = IDL.Record({ 'im_canister' : IDL.Opt(IDL.Text) });
// return [Conf];
type InitArgs = {
	im_canister: Opt<string>
}

/**
 * Creates an instance of the IcrcRegistry canister.
 * @param initArgsOrFn Initialization arguments or a function returning them.
 * @returns A canister instance.
 */
export const NFIDIcrc1Registry = (
	initArgsOrFn?:
		| NFIDIcrc1RegistryInitArgs
		| ((args: { ctx: TaskCtx }) => NFIDIcrc1RegistryInitArgs),
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
		.as<_SERVICE, [InitArgs]>()
		.dependsOn({ NFIDIdentityManager: NFIDIdentityManager.provides })
		.installArgs(async ({ ctx, deps }) => {
			// TODO: Add installation logic if needed.
			const initArgs =
				typeof initArgsOrFn === "function"
					? initArgsOrFn({ ctx })
					: initArgsOrFn
			return [
				{
					im_canister: Opt<string>(
						deps.NFIDIdentityManager.canisterId,
					),
				},
			]
		})

NFIDIcrc1Registry.remote = (canisterId: string) => {
	return canister.remote({
		canisterId,
		candid: path.resolve(
			__dirname,
			`./nfid/${canisterName}/${canisterName}.did`,
		),
	}).as<_SERVICE, [InitArgs]>()
}
