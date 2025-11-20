import * as url from "node:url"
import path from "node:path"
import { Principal } from "@dfinity/principal"
import { canister, type TaskCtx } from "@ice.ts/runner"
import { CapRouter } from "../cap"
import type { _SERVICE } from "./dip20.types.js"

export type {
	_SERVICE as DIP20Service,
	DIP20InitArgs,
	InitArgsSimple as DIP20InitArgsSimple,
}

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

// TODO: bigint?
type DIP20InitArgs = [
	logo: string, // logo: String
	name: string, // name: String
	symbol: string, // symbol: String
	decimals: bigint, // decimals: u8,
	totalSupply: bigint, // total_supply: Nat,
	owner: Principal, // owner: Principal,
	fee: bigint, // fee: Nat,
	feeTo: Principal, // fee_to: Principal,
	// TODO: optional dependency:
	capRouterId?: Principal, // cap: Principal,
]

type InitArgsSimple = {
	canisterId?: string
	logo: string // logo: String
	name: string // name: String
	symbol: string // symbol: String
	decimals: number // decimals: u8,
	totalSupply: number // total_supply: Nat,
	owner: string // owner: Principal,
	fee: number // fee: Nat,
	feeTo: string // fee_to: Principal,
	// TODO: optional dependency:
	capRouterId?: string // cap: Principal,
}

const canisterName = "dip20"

// type DIP20Builder = ReturnType<typeof customCanister<CanisterInitArgs, _SERVICE>>
export const DIP20 = () => {
	const result = canister
		.custom<_SERVICE, DIP20InitArgs>(async ({ ctx }) => {
			// const initArgs =
			// 	typeof initArgsOrFn === "function" ? initArgsOrFn({ ctx }) : initArgsOrFn
			return {
				// canisterId: initArgs.canisterId,
				wasm: path.resolve(
					__dirname,
					`./${canisterName}/${canisterName}.wasm.gz`,
				),
				candid: path.resolve(
					__dirname,
					`./${canisterName}/${canisterName}.did`,
				),
			}
		})
		.dependsOn({ CapRouter: CapRouter().make() })
	// .installArgs(async ({ ctx, mode, deps }) => {
	// 	const { CapRouter } = deps
	// 	const initArgs =
	// 		typeof initArgsOrFn === "function"
	// 			? initArgsOrFn({ ctx })
	// 			: initArgsOrFn
	// 	return initArgs
	// })
	return result
}

DIP20.remote = (canisterId: string) => {
	return canister.remote<_SERVICE>({
		canisterId,
		candid: path.resolve(
			__dirname,
			`./${canisterName}/${canisterName}.did`,
		),
	})
}

DIP20.makeArgs = (initArgs: InitArgsSimple): DIP20InitArgs => {
	return [
		initArgs.logo,
		initArgs.name,
		initArgs.symbol,
		BigInt(initArgs.decimals),
		BigInt(initArgs.totalSupply),
		Principal.from(initArgs.owner),
		BigInt(initArgs.fee),
		Principal.from(initArgs.feeTo),
		Principal.from(initArgs.capRouterId),
	]
}

// TODO:
// _metadata: {
//   standard: "DIP20",
// },
