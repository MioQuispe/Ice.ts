import { Effect, Layer, Context, Data, Config } from "effect"
import { Command, CommandExecutor, Path, FileSystem } from "@effect/platform"
import { Principal } from "@icp-sdk/core/principal"
import {
	type Identity,
	type ActorSubclass,
} from "@icp-sdk/core/agent"
import { sha256 } from "js-sha256"
import { IDL } from "@icp-sdk/core/candid"
import find from "find-process"
import { idlFactory } from "../canisters/management_latest/management.did.js"
import type {
	canister_install_mode,
	canister_settings,
	canister_status_result,
	log_visibility,
} from "../canisters/management_latest/management.types.js"
import type { DfxJson } from "../types/schema.js"
import type { ICEGlobalArgs } from "../types/types.js"
import type { PlatformError } from "@effect/platform/Error"
import os from "node:os"
import psList from "ps-list"
import {
	CanisterStatus,
	CanisterStatusError,
	CanisterInstallError,
	CanisterCreateError,
	CanisterStopError,
	CanisterDeleteError,
	Replica,
	AgentError,
	type ReplicaServiceClass,
	type CanisterInfo,
	type InstallModes,
	getCanisterInfoFromStateTree,
} from "./replica.js"
import {
	HttpAgent,
	Actor,
} from "@dfinity/agent"
import { Opt } from "../canister.js"
import type * as ActorTypes from "../types/actor.js"
import type { SubnetTopology } from "@dfinity/pic"
import * as nodeChildProcess from "node:child_process"
import { idlFactory as cyclesLedgerIdlFactory } from "../canisters/cycles_ledger/cycles_ledger.did.js"
import {
	type _SERVICE as CyclesLedgerService,
	CmcCreateCanisterArgs,
} from "../canisters/cycles_ledger/cycles_ledger.types.js"

export type ManagementActor = import("@dfinity/agent").ActorSubclass<
	import("../canisters/management_latest/management.types.js")._SERVICE
>

export const dfxDefaults: DfxJson = {
	defaults: {
		build: {
			packtool: "",
			args: "--force-gc",
		},
		replica: {
			subnet_type: "system",
		},
	},
	networks: {
		local: {
			bind: "127.0.0.1:8080",
			type: "ephemeral",
		},
		staging: {
			providers: ["https://ic0.app"],
			type: "persistent",
		},
		ic: {
			providers: ["https://ic0.app"],
			type: "persistent",
		},
	},
	version: 1,
}

const ENHANCED_PERSISTENCE_ERROR =
	"upgrade option requires that the new canister module supports enhanced orthogonal persistence"

const buildInstallModePayload = (
	mode: InstallModes,
	useEnhancedPersistence: boolean,
): canister_install_mode => {
	switch (mode) {
		case "reinstall":
			return { reinstall: null }
		case "upgrade":
			if (!useEnhancedPersistence) {
				return { upgrade: [] }
			}
			return {
				upgrade: [
					{
						wasm_memory_persistence: Opt<
							{ keep: null } | { replace: null }
						>({
							keep: null,
						}),
						skip_pre_upgrade: Opt<boolean>(),
					},
				],
			}
		default:
			return { install: null }
	}
}

const shouldRetryInstallWithoutEap = (
	mode: InstallModes,
	error: unknown,
): boolean => {
	return (
		mode === "upgrade" &&
		String(error ?? "").includes(ENHANCED_PERSISTENCE_ERROR)
	)
}

// Error types
export class DfxError extends Data.TaggedError("DfxError")<{
	readonly message: string
}> {}

export class ICReplica implements ReplicaServiceClass {
	public readonly host: string = "http://0.0.0.0"
	public readonly port: number = 8080
	public readonly manual?: boolean
	public readonly isDev: boolean
	public ctx?: ICEGlobalArgs
	public proc?: nodeChildProcess.ChildProcess

	// Cache agents per identity to avoid expensive re-creation
	private readonly agentCache = new Map<string, HttpAgent>()

	// Cache canister info with 500ms TTL to cover runner's internal "revalidate->execute" gap
	// 500ms is indistinguishable from network latency variance on mainnet
	private readonly cacheTTL = 500

	// The Cache: Timestamped data
	private readonly canisterInfoCache = new Map<
		string,
		{ timestamp: number; data: CanisterInfo }
	>()

	// The Deduplicator: Stores pending promises so concurrent tasks share 1 network call
	private readonly inflightRequests = new Map<string, Promise<CanisterInfo>>()

	constructor(opts: {
		host: string
		port: number
		manual?: boolean
		isDev?: boolean
	}) {
		this.host = opts.host
		this.port = opts.port
		this.manual = opts.manual ?? true
		this.isDev = opts.isDev !== undefined ? opts.isDev : true
	}

	private getIdentityKey(identity: Identity): string {
		return identity.getPrincipal().toText()
	}

	/**
	 * Generate a unique cache key per canister and identity.
	 * Different users see different statuses, so identity must be part of the key.
	 */
	private getCacheKey(canisterId: string, identity: Identity): string {
		return `${canisterId}:${identity.getPrincipal().toText()}`
	}

	/**
	 * SAFETY MECHANISM - Call this whenever we write/mutate state.
	 * Invalidates the cache for a specific canister+identity combination.
	 */
	private invalidateCache(canisterId: string, identity: Identity): void {
		const key = this.getCacheKey(canisterId, identity)
		this.canisterInfoCache.delete(key)
	}

	private getHostUrl(): string {
		// Host may include http:// or https://, extract the protocol and hostname
		if (
			this.host.startsWith("http://") ||
			this.host.startsWith("https://")
		) {
			return this.host
		}
		return `http://${this.host}`
	}

	/**
	 * Get DfinityHttpAgent (from @dfinity/agent) - cached per identity.
	 * This is the unified agent getter used throughout the codebase.
	 * Returns DfinityHttpAgent which works with both Actor.createActor from @dfinity/agent
	 * and DfinityCanisterStatus.request for state tree queries.
	 */
	private async getAgent(identity: Identity): Promise<HttpAgent> {
		const identityKey = this.getIdentityKey(identity)
		
		// Return cached agent if available
		const cached = this.agentCache.get(identityKey)
		if (cached) {
			return cached
		}

		try {
			const hostUrl = this.getHostUrl()
			const agent = await HttpAgent.create({
				identity,
				host: `${hostUrl}${this.port === 80 ? "" : `:${this.port}`}`,
			})
			await agent.fetchRootKey()
			
			// Cache the agent
			this.agentCache.set(identityKey, agent)
			return agent
		} catch (error) {
			throw new AgentError({
				message: `Failed to create agent: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}

	private async getMgmt(identity: Identity): Promise<ManagementActor> {
		const agent = await this.getAgent(identity)
		const mgmt = Actor.createActor<ManagementActor>(idlFactory, {
			canisterId: "aaaaa-aa",
			agent,
		})
		return mgmt
	}

	private async getCyclesLedger(
		identity: Identity,
	): Promise<CyclesLedgerService> {
		const agent = await this.getAgent(identity)
		const cyclesLedger = Actor.createActor<CyclesLedgerService>(
			cyclesLedgerIdlFactory,
			{
				canisterId: "um5iw-rqaaa-aaaaq-qaaba-cai",
				agent,
			},
		)
		return cyclesLedger
	}

	public async getCanisterStatus({
		canisterId,
		identity,
	}: {
		canisterId: string
		identity: Identity
	}): Promise<CanisterStatus> {
		try {
			if (!canisterId) {
				return CanisterStatus.NOT_FOUND
			}
			const agent = await this.getAgent(identity)
			const info = await getCanisterInfoFromStateTree(
				agent,
				canisterId,
				identity,
				agent,
			)
			return info.status as CanisterStatus
		} catch (error) {
			throw new CanisterStatusError({
				message: `Failed to get canister status: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}

	public async getCanisterInfo({
		canisterId,
		identity,
	}: {
		canisterId: string
		identity: Identity
	}): Promise<CanisterInfo> {
		if (!canisterId) {
			return { status: CanisterStatus.NOT_FOUND } as const
		}

		const key = this.getCacheKey(canisterId, identity)
		const now = Date.now()

		// A. CHECK CACHE (Micro-Cache)
		const cached = this.canisterInfoCache.get(key)
		if (cached && now - cached.timestamp < this.cacheTTL) {
			return cached.data
		}

		// B. CHECK IN-FLIGHT (Deduplication)
		// If a request is already running (e.g. from a parallel task), join it.
		if (this.inflightRequests.has(key)) {
			return this.inflightRequests.get(key)!
		}

		// C. FETCH FRESH
		const fetchPromise = (async () => {
			try {
				const agent = await this.getAgent(identity)
				const stateTreeInfo = await getCanisterInfoFromStateTree(
					agent,
					canisterId,
					identity,
					agent,
				)
				// If canister not found, return early
				if (stateTreeInfo.status === CanisterStatus.NOT_FOUND) {
					return { status: CanisterStatus.NOT_FOUND } as const
				}
				// Try to get full info from management canister if we're a controller
				// and status allows it (not out_of_cycles or not_controller)
				if (
					stateTreeInfo.status !== CanisterStatus.NOT_CONTROLLER &&
					stateTreeInfo.status !== CanisterStatus.OUT_OF_CYCLES
				) {
					try {
						const mgmt = await this.getMgmt(identity)
						const result = await mgmt.canister_status({
							canister_id: Principal.fromText(canisterId),
						})
						const fullInfo = {
							...result,
							status: Object.keys(result.status)[0] as CanisterStatus,
						}
						return fullInfo
					} catch (error) {
						// Fall through to return state tree info
					}
				}
				// Return minimal info from state tree for cases where we can't get full info
				const minimalInfo = {
					status: stateTreeInfo.status as CanisterStatus,
					memory_size: 0n,
					cycles: 0n,
					settings: {
						freezing_threshold: 0n,
						controllers: stateTreeInfo.controllers.map((c) =>
							Principal.fromText(c),
						),
						reserved_cycles_limit: 0n,
						log_visibility: { controllers: null },
						wasm_memory_limit: 0n,
						memory_allocation: 0n,
						compute_allocation: 0n,
					},
					query_stats: {
						response_payload_bytes_total: 0n,
						num_instructions_total: 0n,
						num_calls_total: 0n,
						request_payload_bytes_total: 0n,
					},
					idle_cycles_burned_per_day: 0n,
					module_hash:
						stateTreeInfo.module_hash.length > 0
							? [
									Array.from(
										Buffer.from(
											stateTreeInfo.module_hash[0]!.replace(
												/^0x/,
												"",
											),
											"hex",
										),
									),
								]
							: [],
					reserved_cycles: 0n,
				} as CanisterInfo
				return minimalInfo
			} catch (error) {
				throw new CanisterStatusError({
					message: `Failed to get canister info: ${error instanceof Error ? error.message : String(error)}`,
				})
			} finally {
				// Cleanup in-flight marker immediately after finish
				this.inflightRequests.delete(key)
			}
		})()

		// Register the promise so concurrent calls can share it
		this.inflightRequests.set(key, fetchPromise)

		const result = await fetchPromise

		// Save to cache
		this.canisterInfoCache.set(key, {
			timestamp: Date.now(),
			data: result,
		})

		return result
	}

	public async installCode({
		canisterId,
		wasm,
		encodedArgs,
		identity,
		mode,
	}: {
		canisterId: string
		wasm: Uint8Array
		encodedArgs: Uint8Array
		identity: Identity
		mode: InstallModes
	}): Promise<void> {
		try {
			const maxSize = 3670016
			const isOverSize = wasm.length > maxSize
			const wasmModuleHash = Array.from(sha256.array(wasm))
			const agent = await this.getAgent(identity)
			const mgmt = Actor.createActor<ManagementActor>(idlFactory, {
				canisterId: "aaaaa-aa",
				effectiveCanisterId: Principal.fromText(canisterId),
				agent,
			})
			// const mgmt = await this.getMgmt(identity)
			const enhancedModePayload = buildInstallModePayload(mode, true)
			const fallbackModePayload =
				mode === "upgrade"
					? buildInstallModePayload(mode, false)
					: enhancedModePayload
			console.debug(`Installing code for ${canisterId}`)
			if (isOverSize) {
				const chunkSize = 1048576
				const chunkHashes: Array<{ hash: Array<number> }> = []
				const chunkUploadPromises = []
				for (let i = 0; i < wasm.length; i += chunkSize) {
					const chunk = wasm.slice(i, i + chunkSize)
					const chunkHash = Array.from(sha256.array(chunk))
					chunkHashes.push({ hash: chunkHash })
					chunkUploadPromises.push(
						mgmt
							.upload_chunk({
								chunk: Array.from(chunk),
								canister_id: Principal.fromText(canisterId),
							})
							.then(() => {
								console.debug(
									`Uploading chunk ${i} of ${wasm.length} for ${canisterId}`,
								)
							})
							.catch((error) => {
								throw new CanisterInstallError({
									message: `Failed to upload chunk: ${
										error instanceof Error
											? error.message
											: String(error)
									}`,
								})
							}),
					)
				}
				await Promise.all(chunkUploadPromises)
				const runChunkedInstall = async (
					modePayload: canister_install_mode,
				) => {
					await mgmt.install_chunked_code({
						arg: Array.from(encodedArgs),
						target_canister: Principal.fromText(canisterId),
						sender_canister_version: Opt<bigint>(),
						mode: modePayload,
						chunk_hashes_list: chunkHashes,
						store_canister: [],
						wasm_module_hash: wasmModuleHash,
					})
				}
				try {
					await runChunkedInstall(enhancedModePayload)
				} catch (error) {
					if (shouldRetryInstallWithoutEap(mode, error)) {
						await runChunkedInstall(fallbackModePayload)
					} else {
						throw error
					}
				}
			} else {
				const runInstall = async (modePayload: canister_install_mode) =>
					mgmt.install_code({
						arg: Array.from(encodedArgs),
						canister_id: Principal.fromText(canisterId),
						sender_canister_version: Opt<bigint>(),
						wasm_module: Array.from(wasm),
						mode: modePayload,
					})
				try {
					await runInstall(enhancedModePayload)
				} catch (error) {
					if (shouldRetryInstallWithoutEap(mode, error)) {
						await runInstall(fallbackModePayload)
					} else {
						throw error
					}
				}
			}
			console.debug(`Code installed for ${canisterId}`)
		} catch (error) {
			throw new CanisterInstallError({
				message: `Failed to install code: ${error instanceof Error ? error.message : String(error)}`,
			})
		} finally {
			// SAFE: Code installed, hash changed. Invalidate immediately.
			this.invalidateCache(canisterId, identity)
		}
	}
	public async createCanister({
		canisterId,
		identity,
	}: {
		canisterId: string | undefined
		identity: Identity
	}): Promise<string> {
		// Optimistic invalidation before we start, just in case
		if (canisterId) {
			this.invalidateCache(canisterId, identity)
		}

		try {
			const mgmt = await this.getMgmt(identity)
			const controller = identity.getPrincipal()
			if (canisterId) {
				const canisterStatus = await this.getCanisterStatus({
					canisterId,
					identity,
				})
				// Only return existing canister if it exists AND we are a controller
				// If we're not a controller, we can't install code, so treat it as not found
				if (
					canisterStatus !== CanisterStatus.NOT_FOUND &&
					canisterStatus !== CanisterStatus.NOT_CONTROLLER
				) {
					return canisterId
				}
			}
			const settings = [
				{
					compute_allocation: Opt<bigint>(),
					memory_allocation: Opt<bigint>(),
					freezing_threshold: Opt<bigint>(),
					controllers: Opt<Principal[]>([controller]),
					reserved_cycles_limit: Opt<bigint>(),
					log_visibility: Opt<log_visibility>(),
					wasm_memory_limit: Opt<bigint>(),
				},
			] as [canister_settings]
			if (this.isDev) {
				const createResult =
					await (mgmt.provisional_create_canister_with_cycles({
						settings,
						amount: Opt<bigint>(1_000_000_000_000_000_000n),
						specified_id: Opt<Principal>(
							canisterId
								? Principal.fromText(canisterId)
								: undefined,
						),
						sender_canister_version: Opt<bigint>(0n),
					}) as Promise<{ canister_id: Principal }>)
				const newCanisterId = createResult.canister_id.toText()
				// Invalidate the new ID to ensure next read gets fresh data
				this.invalidateCache(newCanisterId, identity)
				return newCanisterId
			} else {
				const cyclesLedger = await this.getCyclesLedger(identity)
				const createResult = await cyclesLedger.create_canister_from({
					spender_subaccount: [],
					from: {
						owner: identity.getPrincipal(),
						subaccount: [],
					},
					created_at_time: [],
					amount: 500_000_000_000n,
					creation_args: Opt<CmcCreateCanisterArgs>({
						subnet_selection: [],
						settings: settings,
					}),
				})
				if ("Ok" in createResult) {
					const newCanisterId = createResult.Ok.canister_id.toText()
					// Invalidate the new ID to ensure next read gets fresh data
					this.invalidateCache(newCanisterId, identity)
					return newCanisterId
				}
				const errorMsg = JSON.stringify(createResult, (_, value) => {
					if (typeof value === "bigint") {
						return { __type__: "bigint", value: value.toString() }
					}
					return value
				})
				throw new CanisterCreateError({
					message: `Failed to create canister: ${errorMsg}`,
				})
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			if (
				errorMessage.includes("canister_not_found") ||
				errorMessage.includes("The specified canister does not exist")
			) {
				throw new CanisterCreateError({
					message: `Failed to create canister on mainnet. This error typically indicates that the caller's account does not have sufficient cycles. On mainnet, create_canister requires cycles to be transferred from the caller's account balance. Ensure your identity has cycles before creating canisters. Original error: ${errorMessage}`,
				})
			}
			throw new CanisterCreateError({
				message: `Failed to create canister: ${errorMessage}`,
			})
		}
	}
	public async stopCanister({
		canisterId,
		identity,
	}: {
		canisterId: string
		identity: Identity
	}): Promise<void> {
		try {
			const mgmt = await this.getMgmt(identity)
			await mgmt.stop_canister({
				canister_id: Principal.fromText(canisterId),
			})
		} catch (error) {
			throw new CanisterStopError({
				message: `Failed to stop canister: ${error instanceof Error ? error.message : String(error)}`,
			})
		} finally {
			// SAFE: Status changed. Invalidate immediately.
			this.invalidateCache(canisterId, identity)
		}
	}

	public async removeCanister({
		canisterId,
		identity,
	}: {
		canisterId: string
		identity: Identity
	}): Promise<void> {
		try {
			const mgmt = await this.getMgmt(identity)
			await mgmt.delete_canister({
				canister_id: Principal.fromText(canisterId),
			})
		} catch (error) {
			throw new CanisterDeleteError({
				message: `Failed to delete canister: ${error instanceof Error ? error.message : String(error)}`,
			})
		} finally {
			// SAFE: Canister removed. Invalidate immediately.
			this.invalidateCache(canisterId, identity)
		}
	}

	public async createActor<_SERVICE>({
		canisterId,
		canisterDID,
		identity,
	}: {
		canisterId: string
		canisterDID: any
		identity: Identity
	}): Promise<ActorSubclass<_SERVICE>> {
		const agent = await this.getAgent(identity)
		return Actor.createActor<_SERVICE>(canisterDID.idlFactory, {
			agent,
			canisterId,
		})
	}

	public async getTopology(): Promise<SubnetTopology[]> {
		// TODO: implement
		return []
	}

	public async start(ctx: ICEGlobalArgs): Promise<void> {
		this.ctx = ctx
		// TODO: implement?
		// if (!this.manual) {
		// 	// TODO: start dfx
		// 	let args = [
		// 		"start",
		// 	]
		// 	if (ctx.background) {
		// 		args.push("--background")
		// 	}
		// 	// args.push("--clean")
		//     console.log("spawning dfx")
		// 	this.proc = spawn("dfx", args, {
		// 		cwd: ctx.iceDirPath,
		// 	})
		//     console.log("dfx spawned", this.proc?.pid)
		//     await new Promise(resolve => setTimeout(resolve, 1000))
		// }
	}

	public async stop(args?: {
		scope: "background" | "foreground"
	}): Promise<void> {
		// if (!this.manual) {
		// 	if (args?.scope === "background" && this.ctx?.background) {
		// 		this.proc?.kill("SIGTERM")
		// 	}
		//     if (args?.scope === "background" && !this.ctx?.background) {
		// 		this.proc?.kill("SIGTERM")
		//     }
		//     if (args?.scope === "foreground" && this.ctx?.background) {
		//     }
		//     if (args?.scope === "foreground" && !this.ctx?.background) {
		//         this.proc?.kill("SIGTERM")
		//     }
		// }
	}
}

const dfxReplicaImpl = Effect.gen(function* () {
	const commandExecutor = yield* CommandExecutor.CommandExecutor
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const service = new ICReplica({
		host: "http://0.0.0.0",
		port: 8080,
	})
	return Replica.of(service)
})

export const DfxReplica = Layer.effect(Replica, dfxReplicaImpl)
