import {
	Effect,
	Layer,
	Context,
	Data,
	Config,
	Ref,
	Schedule,
	Stream,
	Fiber,
	Scope,
} from "effect"
import { Command, CommandExecutor, Path, FileSystem } from "@effect/platform"
import { Principal } from "@icp-sdk/core/principal"
import {
	Actor,
	ActorSubclass,
	HttpAgent,
	MANAGEMENT_CANISTER_ID,
	type SignIdentity,
} from "@icp-sdk/core/agent"
import find from "find-process"
import { idlFactory } from "../../canisters/management_latest/management.did.js"
import { Opt } from "../../index.js"
import type { ManagementActor } from "../../types/types.js"
import type { PlatformError } from "@effect/platform/Error"
import os from "node:os"
import psList from "ps-list"
import { PocketIc, PocketIcServer, createActorClass } from "@dfinity/pic"
import { PocketIcClient as CustomPocketIcClient } from "./pocket-ic-client.js"
import {
	ChunkHash,
	encodeInstallCodeChunkedRequest,
} from "../../canisters/pic_management/index.js"
import {
	AgentError,
	CanisterCreateError,
	CanisterDeleteError,
	CanisterInstallError,
	CanisterStatusError,
	CanisterStopError,
	CanisterStatus,
	Replica,
	CanisterInfo,
	CanisterStatusResult,
	isCanisterIdInSubnet,
	isCanisterIdInRanges,
	subnetRanges,
	CanisterCreateRangeError,
	ReplicaError,
} from "../replica.js"
import { sha256 } from "js-sha256"
import * as url from "node:url"
import {
	EffectivePrincipal,
	SubnetStateType,
} from "./pocket-ic-client-types.js"
import type * as ActorTypes from "../../types/actor.js"
import { pocketIcPath, pocketIcVersion } from "@ice.ts/pocket-ic"
import { decodeText, runFold } from "effect/Stream"
import {
	makeMonitor,
	Monitor,
} from "./pic-process.js"

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

// TODO: never finishes after tasks have run.
// we need to kill it?
export const picReplicaImpl = ({
	background,
	ip = "0.0.0.0",
	port = 8081,
	ttlSeconds = 9_999_999_999,
}: {
	background: boolean
	ip: string
	port: number
	ttlSeconds: number
}) =>
	Effect.gen(function* () {
		// TODO: make it configurable
		// const DEFAULT_IP = "0.0.0.0"
		// const DEFAULT_PORT = 8081

		// Decide mode & ensure server
		let resolvedHost: string
		let resolvedPort: number
		// let port: number
		let monitorFiber:
			| Fiber.Fiber<never, ReplicaError | PlatformError>
			| undefined

		let monitor: Monitor = yield* makeMonitor({
			ip,
			port,
			ttlSeconds: 9_999_999_999,
			background,
		})
		resolvedHost = monitor.host
		resolvedPort = monitor.port

		// TODO: why logDebug not working???
		yield* Effect.logDebug(
			`[pocket-ic] background ${monitor.reused ? "reused" : "started"} pid ${monitor.pid} @ ${resolvedHost}:${resolvedPort}`,
		)
		// const NNS_SUBNET_ID =
		// 	"nt6ha-vabpm-j6nog-bkr62-vbgbt-swwzc-u54zn-odtoy-igwlu-ab7uj-4qe"
		const CustomPocketIcClientEffect = Effect.tryPromise({
			try: () =>
				// TODO: creates a new instance every time?
				CustomPocketIcClient.create(`${resolvedHost}:${resolvedPort}`, {
					nns: {
						state: {
							type: SubnetStateType.New,
							// TODO: save state
							// "path": "/nns/subnet/state",
							// "path": "/.ice/subnets/",
							// subnetId: Principal.fromText(NNS_SUBNET_ID),
						},
					},
					ii: {
						state: {
							type: SubnetStateType.New,
						},
					},
					fiduciary: {
						state: {
							type: SubnetStateType.New,
						},
					},
					bitcoin: {
						state: {
							type: SubnetStateType.New,
						},
					},
					sns: {
						state: {
							type: SubnetStateType.New,
						},
					},
					// TODO:
					// system: vec![],
					// verified_application: [
					// 	// { state: { type: SubnetStateType.New } },
					// 	// { state: { type: SubnetStateType.New } },
					// ],
					// application: vec![],
					application: [
						{ state: { type: SubnetStateType.New } },
						// { state: { type: SubnetStateType.New } },
						// { state: { type: SubnetStateType.New } },
						// { state: { type: SubnetStateType.New } },
						// { state: { type: SubnetStateType.New } },
						// { state: { type: SubnetStateType.New } },
						// { state: { type: SubnetStateType.New } },
						// { state: { type: SubnetStateType.New } },
						// { state: { type: SubnetStateType.New } },
					],
				}),
			catch: (error) =>
				new AgentError({
					message: `Failed to create custom pocket-ic client: ${error instanceof Error ? error.message : String(error)}`,
				}),
		}).pipe(
			Effect.retry(
				Schedule.intersect(
					Schedule.union(
						Schedule.exponential("10 millis"),
						Schedule.spaced("1 second"),
					),
					Schedule.recurs(10),
				),
			),
		)

		const customPocketIcClient = yield* Effect.race(
			!background
				? Fiber.join(monitor.stdErrFiber!)
				: Effect.forever(Effect.never),
			CustomPocketIcClientEffect,
		)
		// monitor.onReady
		// ? // Foreground: race monitor stderr fatal watcher vs client readiness
		// : // Background: just wait for the client
		// 	yield* CustomPocketIcClientEffect

		// Needed because the constructor is set as private, but we need to instantiate it this way
		// @ts-ignore
		const pic: PocketIc = new PocketIc(customPocketIcClient)

		// /{id}/auto_progress
		// pic.makeLive()
		// pub struct AutoProgressConfig {
		// 	pub artificial_delay_ms: Option<u64>,
		// }
		yield* Effect.tryPromise({
			try: () =>
				customPocketIcClient.makeLive({
					artificialDelayMs: 0,
				}),
			catch: (error) =>
				new AgentError({
					message: `Failed to make pic live: ${error instanceof Error ? error.message : String(error)}`,
				}),
		}).pipe(Effect.ignore)

		// const applicationSubnets = yield* Effect.tryPromise({
		// 	try: () => pic.getApplicationSubnets(),
		// 	catch: (error) =>
		// 		new AgentError({
		// 			message: `Failed to get application subnets: ${error instanceof Error ? error.message : String(error)}`,
		// 		}),
		// })

		// const nnsSubnet = Object.values(topology).find(
		// 	(subnet) => subnet.type === "NNS",
		// )
		// const appSubnet = Object.values(topology).find(
		// 	(subnet) => subnet.type === "Application",
		// )

		// TODO: cache?
		const getMgmt = (identity: SignIdentity) =>
			Effect.gen(function* () {
				const Mgmt = createActorClass<ManagementActor>(
					idlFactory,
					Principal.fromText("aaaaa-aa"),
					// @ts-ignore
					customPocketIcClient,
				)
				const mgmt = new Mgmt()
				// TODO: ???
				mgmt.setIdentity(identity)
				return mgmt
			})

		// TODO: create errors
		const getCanisterStatus = ({
			canisterId,
			identity,
		}: {
			canisterId: string
			identity: SignIdentity
		}) =>
			Effect.gen(function* () {
				const mgmt = yield* getMgmt(identity)
				const canisterInfo = yield* Effect.tryPromise({
					try: async () => {
						// TODO: throw error instead? not sure
						if (!canisterId) {
							return { status: CanisterStatus.NOT_FOUND }
						}
						try {
							return await mgmt.canister_status({
								canister_id: Principal.fromText(canisterId),
							})
						} catch (error) {
							return { status: CanisterStatus.NOT_FOUND }
						}
					},
					catch: (error) => {
						return new CanisterStatusError({
							message: `Failed to get canister status: ${error instanceof Error ? error.message : String(error)}`,
						})
					},
				})

				let canisterStatus: CanisterStatus = CanisterStatus.NOT_FOUND
				switch (Object.keys(canisterInfo.status)[0]) {
					case CanisterStatus.NOT_FOUND:
						canisterStatus = CanisterStatus.NOT_FOUND
						break
					case CanisterStatus.STOPPED:
						canisterStatus = CanisterStatus.STOPPED
						break
					case CanisterStatus.RUNNING:
						canisterStatus = CanisterStatus.RUNNING
						break
				}
				return canisterStatus
			})

		const getCanisterInfo = ({
			canisterId,
			identity,
		}: {
			canisterId: string
			identity: SignIdentity
		}): Effect.Effect<CanisterStatusResult, CanisterStatusError> =>
			Effect.gen(function* () {
				const mgmt = yield* getMgmt(identity)

				if (!canisterId) {
					return {
						status: CanisterStatus.NOT_FOUND,
					} as const
				}
				const canisterInfo = yield* Effect.tryPromise<
					CanisterStatusResult,
					CanisterStatusError
				>({
					try: async () => {
						if (!canisterId) {
							return { status: CanisterStatus.NOT_FOUND }
						}
						try {
							const result = await mgmt.canister_status({
								canister_id: Principal.fromText(canisterId),
							})
							switch (Object.keys(result.status)[0]) {
								case CanisterStatus.NOT_FOUND:
									return {
										// ...result,
										status: CanisterStatus.NOT_FOUND,
									} satisfies CanisterStatusResult
								case CanisterStatus.STOPPED:
									// canisterInfo
									return {
										...result,
										status: CanisterStatus.STOPPED,
									} satisfies CanisterStatusResult
								case CanisterStatus.RUNNING:
									return {
										...result,
										status: CanisterStatus.RUNNING,
									} satisfies CanisterStatusResult
								default:
									throw new Error("Unknown canister status")
							}
						} catch (error) {
							if (
								error instanceof Error &&
								(error.message.includes(
									"does not belong to any subnet",
								) ||
									error.message.includes("CanisterNotFound"))
							) {
								return { status: CanisterStatus.NOT_FOUND }
							}
							throw error
						}
					},
					catch: (error) => {
						// TODO: ?? success anyway?
						return new CanisterStatusError({
							message: `Failed to get canister status: ${error instanceof Error ? error.message : String(error)}`,
						})
					},
				})

				return canisterInfo
			})

		return Replica.of({
			host: resolvedHost,
			port: resolvedPort,
			// start: () =>
			// 	Effect.gen(function* () {
			// 		const command = Command.make("./pocket-ic", "--port", dfxPort)
			// 		pocketIcProcess = yield* commandExecutor
			// 			.start(command)
			// 			.pipe(Effect.scoped)
			// 	}),

			stop: () =>
				Effect.sync(() => {
					console.log(
						"stop called on replica",
						background,
						monitor.pid,
					)
					if (!background) {
						try {
							monitor.shutdown()
						} catch {}
					}
				}),

			getTopology: () =>
				Effect.gen(function* () {
					const topology = yield* Effect.tryPromise({
						try: () => pic.getTopology(),
						catch: (error) =>
							new AgentError({
								message: `Failed to get topology: ${error instanceof Error ? error.message : String(error)}`,
							}),
					})
					return topology
				}),

			installCode: ({ canisterId, wasm, encodedArgs, identity, mode }) =>
				Effect.gen(function* () {
					const maxSize = 3670016
					const isOverSize = wasm.length > maxSize
					const wasmModuleHash = sha256.arrayBuffer(wasm)
					const mgmt = yield* getMgmt(identity)
					const targetSubnetId = undefined
					const modePayload: {
						reinstall?: null
						upgrade?: null
						install?: null
					} = { [mode]: null }
					if (isOverSize) {
						// TODO: proper error handling if fails?
						const chunkSize = 1048576
						const chunkHashes: ChunkHash[] = []
						const chunkUploadEffects = []
						for (let i = 0; i < wasm.length; i += chunkSize) {
							const chunk = wasm.slice(i, i + chunkSize)
							const chunkHash = sha256.arrayBuffer(chunk)
							chunkHashes.push({
								hash: new Uint8Array(chunkHash),
							})
							chunkUploadEffects.push(
								Effect.tryPromise({
									try: () =>
										mgmt.upload_chunk({
											chunk: Array.from(chunk),
											canister_id:
												Principal.fromText(canisterId),
										}),
									catch: (error) =>
										new CanisterInstallError({
											message: `Failed to upload chunk: ${
												error instanceof Error
													? error.message
													: String(error)
											}`,
										}),
								}).pipe(
									Effect.tap(() =>
										Effect.logDebug(
											`Uploading chunk ${i} of ${wasm.length} for ${canisterId}`,
										),
									),
								),
							)
						}
						yield* Effect.all(chunkUploadEffects, {
							concurrency: "unbounded",
						})
						// TODO: retry policy?

						yield* Effect.tryPromise({
							try: () => {
								const payload = {
									arg: encodedArgs,
									canister_id: Principal.fromText(canisterId),
									target_canister:
										Principal.fromText(canisterId),
									sender_canister_version: Opt<bigint>(),
									mode: modePayload,
									chunk_hashes_list: chunkHashes,
									store_canister: Opt<Principal>(),
									wasm_module_hash: new Uint8Array(
										wasmModuleHash,
									),
								}
								const encodedPayload =
									encodeInstallCodeChunkedRequest(payload)

								const req = {
									canisterId: Principal.fromText("aaaaa-aa"),
									sender: identity.getPrincipal(),
									method: "install_chunked_code",
									payload: encodedPayload,
									effectivePrincipal: (targetSubnetId
										? {
												subnetId:
													Principal.fromText(
														targetSubnetId,
													),
											}
										: undefined) as EffectivePrincipal,
								}
								return customPocketIcClient.updateCall(req)
							},
							catch: (error) =>
								new CanisterInstallError({
									message: `Failed to install code: ${error instanceof Error ? error.message : String(error)}`,
								}),
						})
					} else {
						yield* Effect.tryPromise({
							try: () => {
								if (mode === "reinstall") {
									return pic.reinstallCode({
										arg: encodedArgs.buffer,
										sender: identity.getPrincipal(),
										canisterId:
											Principal.fromText(canisterId),
										wasm: wasm.buffer,
										// targetSubnetId: nnsSubnet?.id!,
									})
								} else if (mode === "install") {
									return pic.installCode({
										arg: encodedArgs.buffer,
										sender: identity.getPrincipal(),
										canisterId:
											Principal.fromText(canisterId),
										wasm: wasm.buffer,
										// targetSubnetId: nnsSubnet?.id!,
									})
								} else {
									return pic.upgradeCanister({
										arg: encodedArgs.buffer,
										sender: identity.getPrincipal(),
										canisterId:
											Principal.fromText(canisterId),
										wasm: wasm.buffer,
										// targetSubnetId: nnsSubnet?.id!,
									})
								}
							},
							catch: (error) => {
								return new CanisterInstallError({
									message: `Failed to install code: ${error instanceof Error ? error.message : String(error)}`,
								})
							},
						})
					}
				}),
			createCanister: ({ canisterId, identity }) =>
				Effect.gen(function* () {
					// TODO: get stack trace somehow
					const controller = identity.getPrincipal()
					if (canisterId) {
						// TODO: canisterId is set but its not created, causes error?
						const canisterStatus = yield* getCanisterStatus({
							canisterId,
							identity,
						})
						// TODO: wrong!?
						if (canisterStatus !== CanisterStatus.NOT_FOUND) {
							return canisterId
						}
					}
					const topology = yield* Effect.tryPromise({
						try: () => pic.getTopology(),
						catch: (error) =>
							new AgentError({
								message: `Failed to get topology: ${error instanceof Error ? error.message : String(error)}`,
							}),
					})
					const replicaRanges = topology
						.map((subnet) =>
							subnet.canisterRanges.map(
								(range) =>
									[
										range.start.toHex(),
										range.end.toHex(),
									] as [string, string],
							),
						)
						.flat()

					// targetSubnetId related:
					// Canister ranges:
					// https://wiki.internetcomputer.org/wiki/Subnet_splitting_forum_announcement_template#firstHeading

					const sender = identity.getPrincipal()
					const targetCanisterId = canisterId
						? Principal.fromText(canisterId)
						: undefined

					// const isInRange =

					// TODO: need to check if target is in subnet range
					if (
						targetCanisterId &&
						!isCanisterIdInRanges({
							canisterId: targetCanisterId.toText(),
							// TODO: get from config?
							// ranges: [
							// 	// ...subnetRanges.NNS,
							// 	// TODO: not working?
							// 	// ...subnetRanges.Application,

							// 	// ...subnetRanges.Fiduciary,
							// 	// ...subnetRanges.SNS,
							// 	// ...subnetRanges.Bitcoin,
							// ],
							ranges: replicaRanges,
						})
					) {
						// TODO: prompt new canisterId?
						return yield* Effect.fail(
							new CanisterCreateRangeError({
								message: `Target canister id is not in subnet range`,
							}),
						)
					}

					const targetSubnetId = targetCanisterId
						? topology.find((subnet) =>
								subnet.canisterRanges.some((range) =>
									isCanisterIdInRanges({
										canisterId: targetCanisterId.toText(),
										ranges: [
											[
												range.start.toHex(),
												range.end.toHex(),
											],
										],
									}),
								),
							)?.id
						: undefined

					const createResult = yield* Effect.tryPromise({
						try: () =>
							pic.createCanister({
								// computeAllocation: 100n,
								// computeAllocation: 0n,
								controllers: [controller],
								cycles: 1_000_000_000_000_000_000n,
								// 164_261_999_000_000_000_000_000_000 additional cycles are required.
								// freezingThreshold: 1_000_000_000_000_000_000n,
								// memoryAllocation: 0n,
								// memoryAllocation: 543_313_362_944n,
								// memoryAllocation: 313_362_944n,
								// reservedCyclesLimit: 1_000_000_000_000_000_000n,
								// reservedCyclesLimit: 0n,
								...(targetCanisterId
									? { targetCanisterId }
									: {}),
								// TODO:
								// targetSubnetId: nnsSubnet?.id!,
								...(targetSubnetId ? { targetSubnetId } : {}),
								sender,
							}),
						catch: (error) => {
							if (
								error instanceof Error &&
								error.message.includes(
									"is invalid because it belongs to the canister allocation ranges of the test environment",
								)
							) {
								return new CanisterCreateRangeError({
									message: `Target canister id is in test environment range`,
								})
							}
							return new CanisterCreateError({
								message: `Failed to create canister: ${error instanceof Error ? error.message : String(error)}`,
								cause: new Error("Failed to create canister"),
							})
						},
					})
					// pic.addCycles(createResult, 1_000_000_000_000_000)
					return createResult.toText()
				}),
			stopCanister: ({ canisterId, identity }) =>
				Effect.gen(function* () {
					const mgmt = yield* getMgmt(identity)
					yield* Effect.tryPromise({
						try: () =>
							mgmt.stop_canister({
								canister_id: Principal.fromText(canisterId),
							}),
						catch: (error) =>
							new CanisterStopError({
								message: `Failed to stop canister: ${error instanceof Error ? error.message : String(error)}`,
							}),
					})
				}),
			removeCanister: ({ canisterId, identity }) =>
				Effect.gen(function* () {
					const mgmt = yield* getMgmt(identity)
					yield* Effect.tryPromise({
						try: () =>
							mgmt.delete_canister({
								canister_id: Principal.fromText(canisterId),
							}),
						catch: (error) =>
							new CanisterDeleteError({
								message: `Failed to delete canister: ${error instanceof Error ? error.message : String(error)}`,
							}),
					})
				}),
			getCanisterStatus,
			getCanisterInfo,
			createActor: <_SERVICE>({
				canisterId,
				canisterDID,
				identity,
			}: {
				canisterId: string
				canisterDID: any
				identity: SignIdentity
			}) =>
				Effect.gen(function* () {
					const actor = pic.createActor(
						canisterDID.idlFactory,
						Principal.fromText(canisterId),
					)
					actor.setIdentity(identity)
					// TODO: fix this. ActorInterface<_SERVICE>
					return actor as unknown as ActorTypes.ActorSubclass<_SERVICE>
				}),
		})
	})
