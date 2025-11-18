import * as url from "node:url"
import path from "node:path"
import { Principal } from "@dfinity/principal"
import { canister, type TaskCtx } from "@ice.ts/runner"
import { CapRouter } from "../cap"
import type { _SERVICE } from "./candid_ui.types"
import { Effect } from "effect"

export type {
	_SERVICE as CandidUIService,
	CanisterInitArgs as CandidUIInitArgs,
}

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

// TODO: bigint?
type CanisterInitArgs = []

const canisterName = "candid_ui"

const Ids = {
	ic: "a4gq6-oaaaa-aaaab-qaa4q-cai",
}

export const CandidUI = () => {
	const result = canister.custom<_SERVICE, CanisterInitArgs>(
		async ({ ctx }) => {
			return {
				wasm: path.resolve(
					__dirname,
					`./${canisterName}/${canisterName}.wasm.gz`,
				),
				candid: path.resolve(
					__dirname,
					`./${canisterName}/${canisterName}.did`,
				),
				canisterId: Ids.ic,
			}
		},
	)

	return result
}

CandidUI.remote = (canisterId?: string) => {
	return canister.remote<_SERVICE>({
		canisterId: canisterId ?? Ids.ic,
		candid: path.resolve(
			__dirname,
			`./${canisterName}/${canisterName}.did`,
		),
	})
}
