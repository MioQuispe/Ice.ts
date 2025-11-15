import path from "node:path"
import { Opt } from "../types"
import * as url from "node:url"
import type { ActorSubclass } from "@dfinity/agent"
import { idlFactory } from "./internet_identity.did.js"
import type {
	InternetIdentityInit,
	_SERVICE,
} from "./internet_identity.types.js"
import {
	customCanister,
	CustomCanisterConfig,
	type TaskCtxShape,
} from "@ice.ts/runner"
import { TaskCtx } from "@ice.ts/runner/dist/services/taskRuntime"
// TODO: make subtasks easily overrideable. maybe helpers like withInstall(). or just let users keep chaining the builder api
type InitArgsSimple = {
	owner: string
	assignedUserNumberRange: [bigint, bigint]
}

export type {
	_SERVICE as InternetIdentityService,
	InternetIdentityInit as InternetIdentityInitArgs,
	InitArgsSimple as InternetIdentityInitArgsSimple,
}

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

const InternetIdentityIds = {
	local: "rdmx6-jaaaa-aaaaa-aaadq-cai",
	ic: "rdmx6-jaaaa-aaaaa-aaadq-cai",
	staging: "rdmx6-jaaaa-aaaaa-aaadq-cai",
}

export type CanisterInitArgs = [
	Opt<{
		assigned_user_number_range: [bigint, bigint]
	}>,
]

type Networks = "local" | "ic" | "staging"

export const InternetIdentity = (
	ConfigOrFn?:
		| Partial<CustomCanisterConfig>
		| ((env: TaskCtx) => Partial<CustomCanisterConfig>),
) => {
	// const currentNetwork = "local" // TODO: how?
	return customCanister<_SERVICE, CanisterInitArgs>((env) => ({
		canisterId: InternetIdentityIds[env.ctx.network as Networks],
		candid: path.resolve(
			__dirname,
			"./internet-identity/internet_identity.did",
		),
		wasm: path.resolve(
			__dirname,
			"./internet-identity/internet_identity.wasm.gz",
		),
		...(ConfigOrFn && typeof ConfigOrFn === "function"
			? ConfigOrFn(env.ctx)
			: ConfigOrFn),
	}))
}

InternetIdentity.makeArgs = (initArgs: InitArgsSimple): CanisterInitArgs => {
	// TODO: do we need to install the canister here also?
	const args: InternetIdentityInit = {
		assigned_user_number_range: initArgs.assignedUserNumberRange,
	}
	return [Opt(args)]
	// }
	// TODO: should be error, type is wrong!
	// if (mode === "reinstall") {
	//   return [Opt(initArgs.owner ?? null)]
	// }
	// if (mode === "upgrade") {
	//   // return [Opt(initArgs.owner ?? null)]
	// }
	// -m, --mode <MODE>
	// Specifies the mode of canister installation.
	// If set to 'auto', either 'install' or 'upgrade' will be used, depending on whether the canister is already installed.
	// [possible values: install, reinstall, upgrade, auto]
}

InternetIdentity.id = InternetIdentityIds

InternetIdentity.idlFactory = idlFactory

export type InternetIdentityActor = ActorSubclass<
	import("./internet_identity.types")._SERVICE
>

// InternetIdentity({ owner: "123", assignedUserNumberRange: [1n, 100n] }).installArgs(async ({ mode, ctx }) => {
//   return [[{assigned_user_number_range: [1n, 100n]}]]
// })
