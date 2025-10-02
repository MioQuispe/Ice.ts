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

export type ReplicaService = {
	// TODO:
	// topology: Topology
	// subnet: Subnet?
	host: string
	port: number
	// readonly createCanister: (params: {
	//   canisterName: string
	//   args?: any[]
	// }) => Effect.Effect<string, DfxError>
	// readonly installCanister: (params: {
	//   canisterName: string
	//   args?: any[]
	// }) => Effect.Effect<string, DfxError>
	// readonly mgmt: ManagementActor
	installCode: (params: {
		canisterId: string
		wasm: Uint8Array
		encodedArgs: Uint8Array
		identity: SignIdentity
		mode: InstallModes
		// TODO: progress callback?
	}) => Effect.Effect<
		void,
		CanisterInstallError | AgentError | CanisterStatusError
	>
	// uninstallCode: (canisterId: string) => Effect.Effect<void, unknown, unknown>
	getCanisterStatus: (params: {
		canisterId: string
		identity: SignIdentity
	}) => Effect.Effect<CanisterStatus, CanisterStatusError | AgentError>
	getCanisterInfo: (params: {
		canisterId: string
		identity: SignIdentity
	}) => Effect.Effect<CanisterInfo, CanisterStatusError | AgentError>
	stopCanister: (params: {
		canisterId: string
		identity: SignIdentity
	}) => Effect.Effect<void, CanisterStopError | AgentError>
	removeCanister: (params: {
		canisterId: string
		identity: SignIdentity
	}) => Effect.Effect<void, CanisterDeleteError | AgentError>
	createCanister: (params: {
		canisterId: string | undefined
		identity: SignIdentity
	}) => Effect.Effect<
		string,
		| CanisterCreateError
		| CanisterCreateRangeError
		| CanisterStatusError
		| AgentError
	> // returns canister id
	createActor: <_SERVICE>(params: {
		canisterId: string
		canisterDID: any
		identity: SignIdentity
	}) => Effect.Effect<ActorSubclass<_SERVICE>, AgentError>
	getTopology: () => Effect.Effect<SubnetTopology[], AgentError>
	stop: () => Effect.Effect<void, ReplicaError>
}

export type ReplicaServiceClass = {
	// TODO:
	// topology: Topology
	// subnet: Subnet?
	host: string
	port: number
	// readonly createCanister: (params: {
	//   canisterName: string
	//   args?: any[]
	// }) => Effect.Effect<string, DfxError>
	// readonly installCanister: (params: {
	//   canisterName: string
	//   args?: any[]
	// }) => Effect.Effect<string, DfxError>
	// readonly mgmt: ManagementActor
	installCode: (params: {
		canisterId: string
		wasm: Uint8Array
		encodedArgs: Uint8Array
		identity: SignIdentity
		mode: InstallModes
		// TODO: progress callback?
	}) => Promise<void>
	// uninstallCode: (canisterId: string) => Effect.Effect<void, unknown, unknown>
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
	start: () => Promise<void>
	stop: () => Promise<void>
}

export class Replica extends Context.Tag("Replica")<
	Replica,
	ReplicaServiceClass
>() {}

export class DefaultReplica extends Context.Tag("DefaultReplica")<
	DefaultReplica,
	ReplicaServiceClass
>() {}

// ---------- small error helpers (pass through if already one of your types) ----------

function asInstallErr(
	e: unknown,
): CanisterInstallError | AgentError | CanisterStatusError {
	if (
		e instanceof CanisterInstallError ||
		e instanceof CanisterStatusError ||
		e instanceof AgentError
	)
		return e
	return new AgentError({ message: `installCode failed: ${fmt(e)}` })
}

function asStatusErr(e: unknown): CanisterStatusError | AgentError {
	if (e instanceof CanisterStatusError || e instanceof AgentError) return e
	return new AgentError({ message: `status failed: ${fmt(e)}` })
}

function asStopErr(e: unknown): CanisterStopError | AgentError {
	if (e instanceof CanisterStopError || e instanceof AgentError) return e
	return new AgentError({ message: `stopCanister failed: ${fmt(e)}` })
}

function asDeleteErr(e: unknown): CanisterDeleteError | AgentError {
	if (e instanceof CanisterDeleteError || e instanceof AgentError) return e
	return new AgentError({ message: `removeCanister failed: ${fmt(e)}` })
}

function asCreateErr(
	e: unknown,
):
	| CanisterCreateError
	| CanisterCreateRangeError
	| CanisterStatusError
	| AgentError {
	if (
		e instanceof CanisterCreateError ||
		e instanceof CanisterCreateRangeError ||
		e instanceof CanisterStatusError ||
		e instanceof AgentError
	)
		return e
	return new AgentError({ message: `createCanister failed: ${fmt(e)}` })
}

const fmt = (e: unknown) =>
	e instanceof Error
		? e.message
		: typeof e === "string"
			? e
			: JSON.stringify(e)

// ---------- core helper: wrap a Promise-based replica into the Effect service ----------

export function effectifyReplica(replica: ReplicaServiceClass): ReplicaService {
	return {
		host: replica.host,
		port: replica.port,

		installCode: (p) =>
			Effect.tryPromise({
				try: () => replica.installCode(p),
				catch: asInstallErr,
			}),

		getCanisterStatus: (p) =>
			Effect.tryPromise({
				try: () => replica.getCanisterStatus(p),
				catch: asStatusErr,
			}),

		getCanisterInfo: (p) =>
			Effect.tryPromise({
				try: () => replica.getCanisterInfo(p),
				catch: asStatusErr,
			}),

		stopCanister: (p) =>
			Effect.tryPromise({
				try: () => replica.stopCanister(p),
				catch: asStopErr,
			}),

		removeCanister: (p) =>
			Effect.tryPromise({
				try: () => replica.removeCanister(p),
				catch: asDeleteErr,
			}),

		createCanister: (p) =>
			Effect.tryPromise({
				try: () => replica.createCanister(p),
				catch: asCreateErr,
			}),

		createActor: <_SERVICE>(p: {
			canisterId: string
			canisterDID: any
			identity: SignIdentity
		}) =>
			Effect.tryPromise<ActorSubclass<_SERVICE>, AgentError>({
				try: () => replica.createActor<_SERVICE>(p),
				catch: (e) =>
					e instanceof AgentError
						? e
						: new AgentError({
								message: `createActor failed: ${fmt(e)}`,
							}),
			}),

		getTopology: () =>
			Effect.tryPromise<SubnetTopology[], AgentError>({
				try: () => replica.getTopology(),
				catch: (e) =>
					e instanceof AgentError
						? e
						: new AgentError({
								message: `getTopology failed: ${fmt(e)}`,
							}),
			}),

		stop: () =>
			Effect.tryPromise({
				try: () => replica.stop(),
				catch: (e) =>
					// keep it simple: rethrow as AgentError (your PlatformError type is a union in practice)
					new ReplicaError({
						message: `replica.stop failed: ${fmt(e)}`,
					}),
			}),
	}
}

// ---------- convenience: build a scoped Layer from an async class with start/stop ----------
//
// Usage:
//   const pic = new PICReplica(ctx, opts)
//   const layer = layerFromAsyncReplica(pic)
//   // provide Layer to your runtime; it will call start() on acquire and stop() on release
//
// export function layerFromAsyncReplica(replica: ReplicaServiceClass) {
// 	return Layer.scoped(
// 		DefaultReplica,
// 		Effect.acquireRelease(
// 			Effect.tryPromise({
// 				try: async () => {
// 					await replica.start()
// 					return effectifyReplica(replica)
// 				},
// 				catch: (e) =>
// 					new ReplicaError({
// 						message: `replica.start failed: ${fmt(e)}`,
// 					}),
// 			}),
// 			// On scope release, stop the *original* replica (not the wrapped one),
// 			// so we always hit the class' real shutdown logic.
// 			() => Effect.tryPromise(() => replica.stop()).pipe(Effect.ignore),
// 		),
// 	)
// }


export function layerFromAsyncReplica(replica: ReplicaServiceClass) {
	return Layer.scoped(
		DefaultReplica,
		Effect.acquireRelease(
			Effect.tryPromise({
				try: async () => {
					await replica.start()
					return replica
				},
				catch: (e) =>
					new ReplicaError({
						message: `replica.start failed: ${fmt(e)}`,
					}),
			}),
			// On scope release, stop the *original* replica (not the wrapped one),
			// so we always hit the class' real shutdown logic.
			() => Effect.tryPromise(() => replica.stop()).pipe(Effect.ignore),
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
	Layer.succeed(DefaultReplica, replica)
