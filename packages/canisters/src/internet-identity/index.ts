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
	canister,
	CustomCanisterConfig,
	type TaskCtx,
} from "@ice.ts/runner"
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

const candid = path.resolve(
	__dirname,
	"./internet-identity/internet_identity.did",
)
const wasm = path.resolve(
	__dirname,
	"./internet-identity/internet_identity.wasm.gz",
)

export const InternetIdentity = (
	ConfigOrFn?:
		| Partial<CustomCanisterConfig>
		| ((env: TaskCtx) => Partial<CustomCanisterConfig>),
) => {
	return canister.custom<_SERVICE, CanisterInitArgs>((env) => ({
		canisterId: InternetIdentityIds.ic,
		...(ConfigOrFn && typeof ConfigOrFn === "function"
			? ConfigOrFn(env.ctx)
			: ConfigOrFn),
		wasm,
		candid,
	}))
}

InternetIdentity.remote = (canisterId?: string) => {
	return canister.remote<_SERVICE>({
		canisterId: canisterId ?? InternetIdentityIds.ic,
		candid,
	})
}

InternetIdentity.makeArgs = (initArgs: InitArgsSimple): CanisterInitArgs => {
	const args: InternetIdentityInit = {
		assigned_user_number_range: initArgs.assignedUserNumberRange,
	}
	return [Opt(args)]
}

InternetIdentity.id = InternetIdentityIds

InternetIdentity.idlFactory = idlFactory

export type InternetIdentityActor = ActorSubclass<
	import("./internet_identity.types")._SERVICE
>
