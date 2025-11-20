import { canister, Opt } from "@ice.ts/runner"
import * as url from "node:url"
import path from "node:path"
import type { TaskCtx } from "@ice.ts/runner"
import type { _SERVICE } from "./delegation_factory.types"
import { NFIDIdentityManager } from "../identity_manager/index.js"
import { Principal } from "@dfinity/principal"

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

type NFIDDelegationFactoryInitArgs = {
	canisterId?: string
}

// TODO:
type InitArgs = {
	im_canister: Principal
}

const canisterName = "delegation_factory"

export const NFIDDelegationFactory = (
	initArgsOrFn?:
		| NFIDDelegationFactoryInitArgs
		| ((args: { ctx: TaskCtx }) => NFIDDelegationFactoryInitArgs),
) => {
	//   return customCanister<[Opt<InitArgs>], _SERVICE>((ctx) => {
	return canister
		.custom<_SERVICE, [Opt<InitArgs>]>(({ ctx }) => {
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
		.dependsOn({
			NFIDIdentityManager: NFIDIdentityManager.provides,
		})
		.installArgs(async ({ ctx, deps }) => {
			// TODO: optional cap canister?
			// dependencies: [...providers],
			const initArgs =
				typeof initArgsOrFn === "function"
					? initArgsOrFn({ ctx })
					: initArgsOrFn
			// TODO: proper types
			return [
				// [{}]
				// {}
				Opt<InitArgs>({
					im_canister: Principal.fromText(
						deps.NFIDIdentityManager.canisterId,
					),
				}),
			]
			//   return [[{
			//     // im_canister: [Principal.fromText(
			//     //   ctx.dependencies.NFIDIdentityManager.canisterId,
			//     // )],
			//     // im_canister: []
			//     // im_canister: ctx.dependencies.NFIDIdentityManager.canisterId,
			//   }]]
		})
}

NFIDDelegationFactory.remote = (canisterId: string) => {
	return canister.remote<_SERVICE>({
		canisterId,
		candid: path.resolve(
			__dirname,
			`./nfid/${canisterName}/${canisterName}.did`,
		),
	})
}
