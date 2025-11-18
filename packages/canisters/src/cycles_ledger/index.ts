import path from "node:path"
import * as url from "node:url"
import { canister, Opt, TaskCtx } from "@ice.ts/runner"
import type {
	_SERVICE,
	LedgerArgs,
	UpgradeArgs,
	InitArgs,
} from "./cycles_ledger.types"
import type { Principal } from "@dfinity/principal"

export type {
	_SERVICE as CyclesLedgerService,
	LedgerArgs as CyclesLedgerLedgerArgs,
	UpgradeArgs as CyclesLedgerUpgradeArgs,
	InitArgs as CyclesLedgerInitArgs,
}

type LedgerUpgradeArgs = { Upgrade: [] | [UpgradeArgs] }
type LedgerInitArgs = { Init: InitArgs }

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

type WrapperInitArgs = {
	canisterId?: string
}

const CyclesLedgerIds = {
	local: "ul4oc-4iaaa-aaaaq-qaabq-cai",
	ic: "ul4oc-4iaaa-aaaaq-qaabq-cai",
}

export const CyclesLedger = (
	initArgsOrFn?:
		| WrapperInitArgs
		| ((args: { ctx: TaskCtx }) => WrapperInitArgs),
) => {
	// TODO: init args
	return canister
		.custom<_SERVICE, [LedgerInitArgs], [LedgerUpgradeArgs]>(({ ctx }) => {
			const initArgs =
				typeof initArgsOrFn === "function"
					? initArgsOrFn({ ctx })
					: initArgsOrFn
			return {
				canisterId: initArgs?.canisterId ?? CyclesLedgerIds.ic,
				type: "custom",
				candid: path.resolve(
					__dirname,
					"./cycles_ledger/cycles_ledger.did",
				),
				wasm: path.resolve(
					__dirname,
					"./cycles_ledger/cycles_ledger.wasm.gz",
				),
			}
		})
		.installArgs(async ({ ctx }) => {
			return [
				{
					Init: {
						index_id: Opt<Principal>(),
						max_blocks_per_request: 1000n,
					},
				},
			]
		})
		.upgradeArgs(async ({ ctx }) => {
			return [
				{
					Upgrade: [],
				},
			]
		})
}

CyclesLedger.remote = (canisterId?: string) => {
	return canister.remote<_SERVICE>({
		canisterId: canisterId ?? CyclesLedgerIds.ic,
		candid: path.resolve(__dirname, "./cycles_ledger/cycles_ledger.did"),
	})
}
