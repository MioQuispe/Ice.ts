import { Opt } from "../types"
import * as url from "node:url"
import path from "node:path"
import type {
	InitArgs,
	LedgerArg,
	UpgradeArgs,
	Account,
	MetadataValue,
	FeatureFlags,
	_SERVICE,
} from "./icrc1_ledger.types"
import { canister, type TaskCtx } from "@ice.ts/runner"
import { Principal } from "@dfinity/principal"

export type {
	InitArgs as ICRC1LedgerInitArgs,
	LedgerArg as ICRC1LedgerArg,
	UpgradeArgs as ICRC1LedgerUpgradeArgs,
	Account as ICRC1LedgerAccount,
	MetadataValue as ICRC1LedgerMetadataValue,
	FeatureFlags as ICRC1LedgerFeatureFlags,
	_SERVICE as ICRC1LedgerService,
}

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))
// const __dirname = url.fileURLToPath(import.meta.url)

// $ dfx deploy icrc1-ledger --argument "(record {
// token_symbol = \"TEX\";
// token_name = \"Token example\";
// minting_account = record { owner = principal \"$PRINCIPAL\"  };
//   transfer_fee = 10_000;
//   metadata = vec {};
//   initial_balances = vec {};
//   archive_options = record {
//     num_blocks_to_archive = 2000;
//     trigger_threshold = 1000;
//     controller_id = principal \"$PRINCIPAL\";
//   };
// },)"

// It’s finally time to mint some tokens! Let’s mint 1_000_000 tokens to the principal akllx-q5q7v-sgdck-cjd7y-izqql-ck5rp-ee3c7-kzrea-k3fnf-pcuaw-pqe.
//
//     $ dfx canister call icrc1-ledger icrc1_transfer '(record {
// to = record {owner = principal "akllx-q5q7v-sgdck-cjd7y-izqql-ck5rp-ee3c7-kzrea-k3fnf-pcuaw-pqe"};
// amount=1_000_000
// },)'

const canisterName = "icrc1_ledger"

// TODO: make nicer?
export type InitArgsSimple = {
	custodians?: Account[]
	logo?: string
	name?: string
	symbol?: string
	minting_account: string
	controller_id: string
	canisterId?: string
}

export const ICRC1Ledger = (
	initArgsOrFn?:
		| InitArgsSimple
		| ((args: { ctx: TaskCtx }) => InitArgsSimple),
) => {
	// <_SERVICE, [LedgerArg]>
	return canister
		.custom(({ ctx }) => {
			const initArgs =
				typeof initArgsOrFn === "function"
					? initArgsOrFn({ ctx })
					: initArgsOrFn
			const args = ICRC1Ledger.makeArgs(
				initArgs ?? {
					minting_account: ctx.roles.deployer.principal,
					controller_id: ctx.roles.deployer.principal,
				},
			)
			return {
				canisterId: initArgs?.canisterId,
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
		.as<_SERVICE, [{ Init: InitArgs }], [{ Upgrade: [] | [UpgradeArgs] }]>()
		.installArgs(async ({ ctx }) => {
			const initArgs =
				typeof initArgsOrFn === "function"
					? initArgsOrFn({ ctx })
					: initArgsOrFn
			const args = ICRC1Ledger.makeArgs(
				initArgs ?? {
					minting_account: ctx.roles.deployer.principal,
					controller_id: ctx.roles.deployer.principal,
				},
			)
			return args
		})
		.upgradeArgs(async ({ ctx }) => {
			const args = ICRC1Ledger.makeUpgradeArgs()
			return args
		})
}

ICRC1Ledger.remote = (canisterId: string) => {
	return canister
		.remote({
			canisterId,
			candid: path.resolve(
				__dirname,
				`./${canisterName}/${canisterName}.did`,
			),
		})
		.as<_SERVICE>()
}

ICRC1Ledger.makeUpgradeArgs = (): [{ Upgrade: [] | [UpgradeArgs] }] => [
	{
		Upgrade: [],
	},
]

ICRC1Ledger.makeArgs = (initArgs: InitArgsSimple): [{ Init: InitArgs }] => {
	const mintingAccount: Account = {
		owner: Principal.from(initArgs.minting_account),
		subaccount: [],
	}
	const controllerId = Principal.from(initArgs.controller_id)
	// TODO: proper types
	return [
		{
			Init: {
				// Opt({
				// custodians: Opt(custodians),
				// logo: Opt(logo),
				// name: Opt(name),
				// symbol: Opt(symbol),
				// }),
				decimals: Opt<number>(8),
				token_symbol: "TOKEN",
				transfer_fee: BigInt(0),
				// metadata : Array<[string, MetadataValue]>,
				metadata: [],
				minting_account: mintingAccount,
				// TODO:
				// initial_balances: Array<[Account, bigint]>,
				initial_balances: [],
				maximum_number_of_accounts: Opt<bigint>(),
				accounts_overflow_trim_quantity: Opt<bigint>(),
				fee_collector_account: Opt<Account>(),
				archive_options: {
					num_blocks_to_archive: BigInt(10000n),
					max_transactions_per_response: Opt<bigint>(BigInt(0)),
					trigger_threshold: BigInt(1000n),
					max_message_size_bytes: Opt<bigint>(BigInt(10000)),
					cycles_for_archive_creation: Opt<bigint>(BigInt(0)),
					node_max_memory_size_bytes: Opt<bigint>(BigInt(10000000)),
					controller_id: controllerId,
				},
				max_memo_length: Opt<number>(32),
				token_name: "Token",
				feature_flags: Opt<FeatureFlags>({ icrc2: true }),
			},
		},
	]
	// satisfies InitArgs
}

// ICRC1Ledger().make().children.install.effect

// TODO:
//   _metadata: {
//   standard: "icrc1",
// },
