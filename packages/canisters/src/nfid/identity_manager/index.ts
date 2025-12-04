import { canister, Opt } from "@ice.ts/runner"
import * as url from "node:url"
import path from "node:path"
import type { TaskCtx } from "@ice.ts/runner"
import { Principal } from "@dfinity/principal"
import type { _SERVICE } from "./identity_manager.types.js"

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

type NFIDIdentityManagerInitArgs = {
	canisterId?: string
}

const Ids = {
	local: "74gpt-tiaaa-aaaak-aacaa-cai",
	ic: "74gpt-tiaaa-aaaak-aacaa-cai",
}
// TODO:
type InitArgs = []

const canisterName = "identity_manager"

export const NFIDIdentityManager = (
	initArgsOrFn?:
		| NFIDIdentityManagerInitArgs
		| ((args: { ctx: TaskCtx }) => NFIDIdentityManagerInitArgs),
) => {
	return canister
		.custom(({ ctx }) => {
			const initArgs =
				typeof initArgsOrFn === "function"
					? initArgsOrFn({ ctx })
					: initArgsOrFn
			return {
				canisterId: initArgs?.canisterId ?? Ids.local,
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
			// TODO: optional cap canister?
			// dependencies: [...providers],
			const initArgs =
				typeof initArgsOrFn === "function"
					? initArgsOrFn({ ctx })
					: initArgsOrFn
			// TODO: proper types
			return []
		})
}

NFIDIdentityManager.remote = (canisterId?: string) => {
	return canister.remote({
		canisterId: canisterId ?? Ids.ic,
		candid: path.resolve(
			__dirname,
			`./nfid/${canisterName}/${canisterName}.did`,
		),
	}).as<_SERVICE, InitArgs>()
}

NFIDIdentityManager.provides = NFIDIdentityManager().make().children.install

// TODO: initialize
// dfx canister call identity_manager configure '(record {env = opt "test"})'
