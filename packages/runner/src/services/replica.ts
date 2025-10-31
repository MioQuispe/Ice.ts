import { Effect, Context, Data, Layer } from "effect"
import type {
	ActorSubclass,
	HttpAgent,
	SignIdentity,
} from "@icp-sdk/core/agent"
import type { canister_status_result } from "src/canisters/management_latest/management.types.js"
import { Principal } from "@icp-sdk/core/principal"
import { type } from "arktype"
import { SubnetTopology } from "@dfinity/pic"
import { PlatformError } from "@effect/platform/Error"
import { ICEConfigContext } from "../types/types.js"

export type SubnetType =
	| "II"
	| "Application"
	| "Fiduciary"
	| "NNS"
	| "SNS"
	| "Bitcoin"

export const subnetRanges: Record<SubnetType, [string, string][]> = {
	II: [
		["00000000000000070101", "00000000000000070101"],
		["00000000021000000101", "00000000021FFFFF0101"],
		["FFFFFFFFFFC000000101", "FFFFFFFFFFCFFFFF0101"],
	],
	Application: [["FFFFFFFFFF9000000101", "FFFFFFFFFF9FFFFF0101"]],
	Fiduciary: [
		["00000000023000000101", "00000000023FFFFF0101"],
		["FFFFFFFFFFB000000101", "FFFFFFFFFFBFFFFF0101"],
	],
	NNS: [
		["00000000000000000101", "00000000000000060101"],
		["00000000000000080101", "00000000000FFFFF0101"],
		["FFFFFFFFFFE000000101", "FFFFFFFFFFEFFFFF0101"],
	],
	SNS: [
		["00000000020000000101", "00000000020FFFFF0101"],
		["FFFFFFFFFFD000000101", "FFFFFFFFFFDFFFFF0101"],
	],
	Bitcoin: [
		["0000000001A000000101", "0000000001AFFFFF0101"],
		["FFFFFFFFFFA000000101", "FFFFFFFFFFAFFFFF0101"],
	],
}

export const generateRandomCanisterIdInRange = (
	startHex: string,
	endHex: string,
): string => {
	const start = BigInt(`0x${startHex}`)
	const end = BigInt(`0x${endHex}`)
	const range = end - start + 1n

	// Generate random BigInt within range
	const randomBytes = new Uint8Array(10)
	crypto.getRandomValues(randomBytes)

	let randomBigInt = 0n
	for (let i = 0; i < 10; i++) {
		randomBigInt = (randomBigInt << 8n) + BigInt(randomBytes[i]!)
	}

	const scaledRandom = start + (randomBigInt % range)

	// Convert back to 10-byte array
	const hex = scaledRandom.toString(16).padStart(20, "0")
	const bytes = new Uint8Array(10)
	for (let i = 0; i < 10; i++) {
		bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
	}

	return Principal.fromUint8Array(bytes).toString()
}

export const makeCanisterId = (
	ranges: [string, string][] = subnetRanges.NNS,
): string => {
	const randomRange = ranges[Math.floor(Math.random() * ranges.length)]
	const [startHex, endHex] = randomRange!

	return generateRandomCanisterIdInRange(startHex, endHex)
	//   return generateRandomCanisterIdInSubnet(subnetType)
}

/**
 * Check whether a `canisterId` lies within any of the provided 10-byte ranges.
 * Ranges are inclusive of both start and end.
 */
export const isCanisterIdInRanges = (params: {
	canisterId: string
	ranges: [string, string][]
}): boolean => {
	const { canisterId, ranges } = params
	let bytes: Uint8Array
	try {
		bytes = Principal.fromText(canisterId).toUint8Array()
	} catch {
		return false
	}
	if (bytes.length !== 10) return false
	let value = 0n
	for (let i = 0; i < 10; i++) value = (value << 8n) + BigInt(bytes[i]!)
	for (const [startHex, endHex] of ranges) {
		const start = BigInt(`0x${startHex}`)
		const end = BigInt(`0x${endHex}`)
		if (value >= start && value <= end) return true
	}
	return false
}

/**
 * Convenience wrapper: check whether `canisterId` is in the ranges for a given `SubnetType`.
 */
export const isCanisterIdInSubnet = (params: {
	canisterId: string
	subnetType: SubnetType
}): boolean => {
	const { canisterId, subnetType } = params
	return isCanisterIdInRanges({
		canisterId,
		ranges: subnetRanges[subnetType],
	})
}

export const InstallModes = type("'install' | 'upgrade' | 'reinstall'")
// TODO: this gets a weird type. maybe arktype bug?
// export type InstallModes = typeof InstallModes.infer
export type InstallModes = "install" | "upgrade" | "reinstall"
// import { ActorInterface } from "@dfinity/pic"
/**
 * Typesafe method of a canister.
 *
 * @category Types
 */
export interface ActorMethod<Args extends any[] = any[], Ret = any> {
	(...args: Args): Promise<Ret>
}
/**
 * Candid interface of a canister.
 *
 * @category Types
 */
export type ActorInterface<T = object> = {
	[K in keyof T]: ActorMethod
}

export type CanisterStatus =
	| "not_found"
	// | "not_installed"
	| "stopped"
	| "stopping"
	| "running"

export const CanisterStatus = {
	NOT_FOUND: "not_found",
	// NOT_INSTALLED: "not_installed",
	STOPPED: "stopped",
	STOPPING: "stopping",
	RUNNING: "running",
} as const

type log_visibility =
	| { controllers: null }
	| { public: null }
	| { allowed_viewers: Array<Principal> }

type DefiniteCanisterSettings = {
	freezing_threshold: bigint
	controllers: Array<Principal>
	reserved_cycles_limit: bigint
	log_visibility: log_visibility
	wasm_memory_limit: bigint
	memory_allocation: bigint
	compute_allocation: bigint
}
// TODO: clean this up
export type CanisterStatusResult =
	| {
			status: Exclude<CanisterStatus, typeof CanisterStatus.NOT_FOUND>
			memory_size: bigint
			cycles: bigint
			settings: DefiniteCanisterSettings
			query_stats: {
				response_payload_bytes_total: bigint
				num_instructions_total: bigint
				num_calls_total: bigint
				request_payload_bytes_total: bigint
			}
			idle_cycles_burned_per_day: bigint
			module_hash: [] | [Array<number>]
			reserved_cycles: bigint
	  }
	| { status: typeof CanisterStatus.NOT_FOUND }

export type CanisterInfo = CanisterStatusResult

// TODO: combine these and use reason field
export class CanisterStatusError extends Data.TaggedError(
	"CanisterStatusError",
)<{
	readonly message: string
}> {}

export class CanisterInstallError extends Data.TaggedError(
	"CanisterInstallError",
)<{
	readonly message: string
}> {}

export class CanisterCreateError extends Data.TaggedError(
	"CanisterCreateError",
)<{
	readonly message: string
	readonly cause?: Error
}> {}
export class CanisterCreateRangeError extends Data.TaggedError(
	"CanisterCreateRangeError",
)<{
	readonly message: string
	readonly cause?: Error
}> {}

export class CanisterStopError extends Data.TaggedError("CanisterStopError")<{
	readonly message: string
}> {}

export class CanisterDeleteError extends Data.TaggedError(
	"CanisterDeleteError",
)<{
	readonly message: string
}> {}

export class AgentError extends Data.TaggedError("AgentError")<{
	readonly message: string
}> {}

export class ReplicaError extends Data.TaggedError("ReplicaError")<{
	readonly message: string
}> {}

export class ReplicaStartError extends Data.TaggedError("ReplicaStartError")<{
	readonly reason:
		| "MonitorStateNotFoundError"
		| "PortInUseError"
		| "ManualPocketICPresentError"
		| "ProtectedServerError"
		| "ServerMismatchError"
	readonly message: string
	readonly cause?: Error
}> {}

export type ReplicaServiceClass = {
	// TODO:
	// topology: Topology
	// subnet: Subnet?
	host: string
	port: number
	installCode: (params: {
		canisterId: string
		wasm: Uint8Array
		encodedArgs: Uint8Array
		identity: SignIdentity
		mode: InstallModes
		// TODO: progress callback?
	}) => Promise<void>
	getCanisterStatus: (params: {
		canisterId: string
		identity: SignIdentity
	}) => Promise<CanisterStatus>
	getCanisterInfo: (params: {
		canisterId: string
		identity: SignIdentity
	}) => Promise<CanisterInfo>
	stopCanister: (params: {
		canisterId: string
		identity: SignIdentity
	}) => Promise<void>
	removeCanister: (params: {
		canisterId: string
		identity: SignIdentity
	}) => Promise<void>
	createCanister: (params: {
		canisterId: string | undefined
		identity: SignIdentity
	}) => Promise<string> // returns canister id
	createActor: <_SERVICE>(params: {
		canisterId: string
		canisterDID: any
		identity: SignIdentity
	}) => Promise<ActorSubclass<_SERVICE>>
	getTopology: () => Promise<SubnetTopology[]>
	start: (ctx: ICEConfigContext) => Promise<void>
	stop: (args?: { scope: "background" | "foreground" }) => Promise<void>
}

export class Replica extends Context.Tag("Replica")<
	Replica,
	ReplicaServiceClass
>() {}

// export class DefaultReplica extends Context.Tag("DefaultReplica")<
// 	DefaultReplica,
// 	ReplicaServiceClass
// >() {}

export function layerFromAsyncReplica(
	replica: ReplicaServiceClass,
	ctx: ICEConfigContext,
) {
	return Layer.scoped(
		Replica,
		Effect.acquireRelease(
			Effect.tryPromise({
				try: async () => {
					// await replica.start(ctx)
					return replica
				},
				catch: (e) =>
					new ReplicaError({
						message: `replica.start failed: ${String(e)}`,
					}),
			}),
			// On scope release, stop the *original* replica (not the wrapped one),
			// so we always hit the class' real shutdown logic.
			() =>
				Effect.tryPromise({
					try: async () => {
						await replica.stop({ scope: "foreground" })
					},
					catch: (e) => {
						return new ReplicaError({
							message: `replica.stop failed: ${String(e)}`,
						})
					},
				}).pipe(Effect.ignore),
		),
	)
}

// ---------- if you only need a pure (non-scoped) provider ----------
//
// If your runtime owns lifecycle elsewhere and start/stop are already managed,
// you can just do:
//   const svc = effectifyReplica(awaitAlreadyStartedInstance)
//   const layer = Layer.succeed(DefaultReplica, svc)
//
export const layerFromStartedReplica = (replica: ReplicaServiceClass) =>
	Layer.succeed(Replica, replica)
