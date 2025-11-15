import { Opt } from "../types"
import * as url from "node:url"
import path from "node:path"
import { canister, customCanister } from "@ice.ts/runner"
import type { TaskCtx } from "@ice.ts/runner"
import { Principal } from "@dfinity/principal"
import type { InitArgs, _SERVICE } from "./dip721.types.js"

export type {
  _SERVICE as DIP721Service,
  InitArgs as DIP721InitArgs,
}

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

type DIP721InitArgs = {
	canisterId?: string
}

const canisterName = "dip721"

export const DIP721 = (
	initArgsOrFn?:
		| DIP721InitArgs
		| ((args: { ctx: TaskCtx }) => DIP721InitArgs),
) => {
	return canister.custom<_SERVICE, [Opt<InitArgs>]>(({ ctx }) => {
		// TODO: support async?
		const initArgs =
			typeof initArgsOrFn === "function" ? initArgsOrFn({ ctx }) : initArgsOrFn
		return {
			canisterId: initArgs?.canisterId,
			wasm: path.resolve(
				__dirname,
				`./${canisterName}/${canisterName}.wasm.gz`,
			),
			candid: path.resolve(__dirname, `./${canisterName}/${canisterName}.did`),
		}
	})
	// .installArgs(async ({ ctx, mode }) => {
	// 	// TODO: optional cap canister?
	// 	const initArgs =
	// 		typeof initArgsOrFn === "function" ? initArgsOrFn({ ctx }) : initArgsOrFn
	// 	// TODO: proper types
	// 	return [
	// 		Opt({
	// 			// custodians: Opt(initArgs.custodians?.map((p) => Principal.fromText(p))),
	// 			custodians: Opt(),
	// 			logo: Opt(initArgs.logo),
	// 			name: Opt(initArgs.name),
	// 			symbol: Opt(initArgs.symbol),
	// 		}),
	// 	]
	// })
}

type DIP721Args = {
	custodians?: Array<string>
	logo?: string
	name?: string
	symbol?: string
	canisterId?: string
}

DIP721.makeArgs = (args: DIP721Args) => {
	return [
		Opt({
			// custodians: Opt(initArgs.custodians?.map((p) => Principal.fromText(p))),
			custodians: Opt(),
			logo: Opt(args.logo),
			name: Opt(args.name),
			symbol: Opt(args.symbol),
		}),
		// TODO: shouldnt be needed, fix the type param above in the customCanister generic
	] as [Opt<InitArgs>]
}

// TODO:
//   _metadata: {
//   standard: "icrc1",
// },
