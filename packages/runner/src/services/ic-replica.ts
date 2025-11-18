import { Effect, Layer, Context, Data, Config } from "effect"
import { Command, CommandExecutor, Path, FileSystem } from "@effect/platform"
import { Principal } from "@icp-sdk/core/principal"
import {
	Actor,
	HttpAgent,
	type SignIdentity,
	type ActorSubclass,
} from "@icp-sdk/core/agent"
import { sha256 } from "js-sha256"
import { IDL } from "@icp-sdk/core/candid"
import find from "find-process"
import { idlFactory } from "../canisters/management_latest/management.did.js"
import type {
	canister_install_mode,
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
} from "./replica.js"
import { Opt } from "../canister.js"
import type * as ActorTypes from "../types/actor.js"
import type { SubnetTopology } from "@dfinity/pic"
import { spawn, type ChildProcess } from "node:child_process"

export type ManagementActor = import("@icp-sdk/core/agent").ActorSubclass<
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
	public ctx?: ICEGlobalArgs
	public proc?: ChildProcess

	constructor(opts: { host: string; port: number; manual?: boolean }) {
		this.host = opts.host
		this.port = opts.port
		this.manual = opts.manual ?? true
	}

	private async getAgent(identity: SignIdentity): Promise<HttpAgent> {
		try {
			const agent = await HttpAgent.create({
				identity,
				host: `${this.host}${this.port === 80 ? "" : `:${this.port}`}`,
			})
			console.log("agent created", agent)
			await agent.fetchRootKey()
			console.log("root key fetched", agent)
			return agent
		} catch (error) {
			throw new AgentError({
				message: `Failed to create agent: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}

	private async getMgmt(identity: SignIdentity): Promise<ManagementActor> {
		const agent = await this.getAgent(identity)
		const mgmt = Actor.createActor<ManagementActor>(idlFactory, {
			canisterId: "aaaaa-aa",
			agent,
		})
		return mgmt
	}

	public async getCanisterStatus({
		canisterId,
		identity,
	}: {
		canisterId: string
		identity: SignIdentity
	}): Promise<CanisterStatus> {
		try {
			const mgmt = await this.getMgmt(identity)
			if (!canisterId) {
				return CanisterStatus.NOT_FOUND
			}
			try {
				const canisterInfo = await mgmt.canister_status({
					canister_id: Principal.fromText(canisterId),
				})
				const statusKey = Object.keys(canisterInfo.status)[0]
				switch (statusKey) {
					case CanisterStatus.NOT_FOUND:
						return CanisterStatus.NOT_FOUND
					case CanisterStatus.STOPPED:
						return CanisterStatus.STOPPED
					case CanisterStatus.RUNNING:
						return CanisterStatus.RUNNING
					default:
						return CanisterStatus.NOT_FOUND
				}
			} catch (error) {
				return CanisterStatus.NOT_FOUND
			}
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
		identity: SignIdentity
	}): Promise<CanisterInfo> {
		try {
			const mgmt = await this.getMgmt(identity)
			if (!canisterId) {
				return { status: CanisterStatus.NOT_FOUND } as const
			}
			try {
				const result = await mgmt.canister_status({
					canister_id: Principal.fromText(canisterId),
				})
				return {
					...result,
					status: Object.keys(result.status)[0] as CanisterStatus,
				}
			} catch (error) {
				return { status: CanisterStatus.NOT_FOUND } as const
			}
		} catch (error) {
			throw new CanisterStatusError({
				message: `Failed to get canister info: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
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
		identity: SignIdentity
		mode: InstallModes
	}): Promise<void> {
		try {
			const maxSize = 3670016
			const isOverSize = wasm.length > maxSize
			const wasmModuleHash = Array.from(sha256.array(wasm))
			const mgmt = await this.getMgmt(identity)
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
		}
	}
	public async createCanister({
		canisterId,
		identity,
	}: {
		canisterId: string | undefined
		identity: SignIdentity
	}): Promise<string> {
		try {
			const mgmt = await this.getMgmt(identity)
			const controller = identity.getPrincipal()
			if (canisterId) {
				const canisterStatus = await this.getCanisterStatus({
					canisterId,
					identity,
				})
				if (canisterStatus !== CanisterStatus.NOT_FOUND) {
					return canisterId
				}
			}
			const createResult =
				await (mgmt.provisional_create_canister_with_cycles({
					settings: [
						{
							compute_allocation: Opt<bigint>(),
							memory_allocation: Opt<bigint>(),
							freezing_threshold: Opt<bigint>(),
							controllers: Opt<Principal[]>([controller]),
							reserved_cycles_limit: Opt<bigint>(),
							log_visibility: Opt<log_visibility>(),
							wasm_memory_limit: Opt<bigint>(),
						},
					],
					amount: Opt<bigint>(1_000_000_000_000_000_000n),
					specified_id: Opt<Principal>(
						canisterId ? Principal.fromText(canisterId) : undefined,
					),
					sender_canister_version: Opt<bigint>(0n),
				}) as Promise<{ canister_id: Principal }>)
			return createResult.canister_id.toText()
		} catch (error) {
			throw new CanisterCreateError({
				message: `Failed to create canister: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}
	public async stopCanister({
		canisterId,
		identity,
	}: {
		canisterId: string
		identity: SignIdentity
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
		}
	}

	public async removeCanister({
		canisterId,
		identity,
	}: {
		canisterId: string
		identity: SignIdentity
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
		}
	}

	public async createActor<_SERVICE>({
		canisterId,
		canisterDID,
		identity,
	}: {
		canisterId: string
		canisterDID: any
		identity: SignIdentity
	}): Promise<ActorSubclass<_SERVICE>> {
		console.log("getting agent....")
		const agent = await this.getAgent(identity)
		console.log("agent got", agent)
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
