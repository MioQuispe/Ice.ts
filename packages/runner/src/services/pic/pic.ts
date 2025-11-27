// src/services/pic/pic.ts

import * as url from "node:url"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { Principal } from "@icp-sdk/core/principal"
import { type Identity } from "@icp-sdk/core/agent"
import {
	CreateInstanceOptions,
	IcpConfigFlag,
	PocketIc,
	createActorClass,
} from "@dfinity/pic"
import { PocketIcClient as CustomPocketIcClient } from "./pocket-ic-client.js"
import {
	ChunkHash,
	encodeInstallCodeChunkedRequest,
	encodeInstallCodeRequest,
	InstallCodeChunkedRequest,
	InstallCodeRequest,
} from "../../canisters/pic_management/index.js"
import {
	AgentError,
	CanisterCreateError,
	CanisterDeleteError,
	CanisterInstallError,
	CanisterStatusError,
	CanisterStatus,
	CanisterInfo,
	CanisterCreateRangeError,
	ReplicaError,
	ReplicaServiceClass,
	CanisterStopError,
	getCanisterInfoFromManagementCanister,
} from "../replica.js"
import { idlFactory } from "../../canisters/management_latest/management.did.js"
import { sha256 } from "js-sha256"
import { Opt } from "../../index.js"
import {
	CreateInstanceRequest,
	EffectivePrincipal,
	SubnetStateType,
} from "./pocket-ic-client-types.js"
import { ActorSubclass } from "../../types/actor.js"
import {
	acquireSpawnLock,
	Monitor,
	PocketIcState,
	readJsonFile,
} from "./pic-process.js"
import type { ReplicaContext } from "../replica.js"

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

async function resolveEffectiveStateDir(
	stateRoot: string,
): Promise<{ dir: string; incomplete: boolean }> {
	const children = await fs
		.readdir(stateRoot, { withFileTypes: true })
		.catch(() => [])
	const hasCheckpoint = children.some((e) => e.isDirectory())
	return { dir: stateRoot, incomplete: !hasCheckpoint }
}

const defaultPicConfig: CreateInstanceOptions = {
	nns: { state: { type: SubnetStateType.New } },
	ii: { state: { type: SubnetStateType.New } },
	fiduciary: { state: { type: SubnetStateType.New } },
	bitcoin: { state: { type: SubnetStateType.New } },
	sns: { state: { type: SubnetStateType.New } },
	application: [{ state: { type: SubnetStateType.New } }],
}


export class PICReplica implements ReplicaServiceClass {
	public host: string
	public port: number
	public readonly ttlSeconds: number
	public readonly manual?: boolean
	public readonly picConfig: CreateInstanceOptions

	public monitor: Monitor | undefined
	public client?: InstanceType<typeof CustomPocketIcClient>
	public pic?: PocketIc
	public ctx: ReplicaContext | undefined

	// Cache canister info with 500ms TTL to cover runner's internal "revalidate->execute" gap
	// 500ms is indistinguishable from network latency variance on mainnet
	private readonly cacheTTL = 200

	// The Cache: Timestamped data
	private readonly canisterInfoCache = new Map<
		string,
		{ timestamp: number; data: CanisterInfo }
	>()

	// The Deduplicator: Stores pending promises so concurrent tasks share 1 network call
	private readonly inflightRequests = new Map<string, Promise<CanisterInfo>>()

	constructor(opts: {
		host?: string
		port: number
		ttlSeconds?: number
		picConfig?: CreateInstanceOptions
		manual?: boolean
	}) {
		this.host = opts.host ?? "http://0.0.0.0"
		this.port = opts.port
		this.ttlSeconds = opts.ttlSeconds ?? 9_999_999_999
		this.picConfig = opts.picConfig ?? defaultPicConfig
		this.manual = opts.manual ?? false
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

	async start(ctx: ReplicaContext): Promise<void> {
		const start = performance.now()
		this.ctx = ctx

        // TODO: strip protocol from host
        const hostUrl = this.host.replace(/^https?:\/\//, "")
        // const hostUrl = String.
		try {
			let releaseSpawnLock
			if (!this.manual) {
				const startMonitor = performance.now()
				const monitor = new Monitor({
					background: ctx.background,
					policy: ctx.policy,
					iceDirPath: ctx.iceDirPath,
					network: ctx.network,
					host: hostUrl,
					port: this.port,
                    // TODO: ? toggles mainnet flag simply?
                    isDev: true,
				})
				// spawn lock is inside here. how can we cleanest extend it?
				const spawnLockPath = path.resolve(
					ctx.iceDirPath,
					"networks",
					ctx.network,
					"pocketic-server",
					"spawn.lock",
				)
				// spawn fresh
				releaseSpawnLock = await acquireSpawnLock(spawnLockPath)
				await monitor.start()
				this.monitor = monitor
                // TODO: clean up
				this.host = monitor.host
				this.port = monitor.port
			}

            // TODO: clean up
			const baseUrl = `http://${hostUrl}:${this.port}`

			const stateRoot = path.resolve(
				path.join(this.ctx.iceDirPath, "networks", ctx.network, "replica-state"),
			)
			const { dir: effectiveStateDir, incomplete } =
				await resolveEffectiveStateDir(stateRoot)

			const fixedPicConfig = Object.fromEntries(
				Object.entries(this.picConfig).filter(
					([k]) =>
						!["icpFeatures", "icpConfig"].includes(k) &&
						(incomplete
							? true
							: ![
									"nns",
									"application",
									"sns",
									"ii",
									"fiduciary",
									"bitcoin",
								].includes(k)),
				),
			)

			const baseRequest: CreateInstanceRequest = {
				stateDir: effectiveStateDir,
				initialTime: { AutoProgress: { artificialDelayMs: 0 } },
				// icpConfig: {
				//     betaFeatures: IcpConfigFlag.Enabled,
				// },
				...(incomplete ? { incompleteState: true } : {}),
			}

			const createRequest: CreateInstanceRequest = incomplete
				? { ...fixedPicConfig, ...baseRequest }
				: { ...baseRequest }

			this.client = await CustomPocketIcClient.create(
				baseUrl,
				createRequest,
			)
			// @ts-ignore
			this.pic = new PocketIc(this.client)
			// release spawn lock here
			if (!this.manual && releaseSpawnLock) {
				await releaseSpawnLock()
			}
			return
		} catch (err) {
			this.ctx = undefined
			this.monitor = undefined
			throw err
		}
	}

	async stop(
		args: {
			scope: "background" | "foreground"
		} = { scope: "foreground" },
        ctx?: ReplicaContext,
	): Promise<void> {
		if (this.monitor) {
			await this.monitor.stop({ scope: args.scope }) //???
		} else {
			await this.stopExistingMonitor(ctx ?? this.ctx)
		}
	}

	private async stopExistingMonitor(ctx?: ReplicaContext): Promise<void> {
		if (!ctx) {
			return
		}
		const stateFilePath = path.resolve(
			ctx.iceDirPath,
			"networks",
			ctx.network,
			"pocketic-server",
			"monitor.json",
		)
		const state = await readJsonFile<PocketIcState>(stateFilePath)
		if (state) {
			// TODO: dont make it start new ones, only ever reuse!!!
			const monitor = new Monitor({
				background: ctx.background,
				policy: "reuse",
				iceDirPath: ctx.iceDirPath,
				network: ctx.network,
				host: state.bind!,
				port: state.port!,
				isDev: ctx.network !== "ic",
			})
			await monitor.stop({ scope: "background" })
		}
	}

	// ---------------- operations ----------------

	async getTopology() {
		assertStarted(this.pic, "PICReplica.getTopology")
		try {
			return await this.pic!.getTopology()
		} catch (error) {
			throw new AgentError({
				message: `Failed to get topology: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}

	private async getMgmt(identity: Identity) {
		assertStarted(this.client, "PICReplica.getMgmt")
		const Mgmt = createActorClass<ManagementActor>(
			idlFactory,
			Principal.fromText("aaaaa-aa"),
			// @ts-ignore injected client
			this.client,
		)
		const mgmt = new Mgmt()
		mgmt.setIdentity(identity)
		return mgmt
	}

	async getCanisterStatus(params: {
		canisterId: string
		identity: Identity
	}): Promise<CanisterStatus> {
		const { canisterId, identity } = params
		assertStarted(this.client, "PICReplica.getCanisterStatus")
		try {
			if (!canisterId) return CanisterStatus.NOT_FOUND
			const mgmt = await this.getMgmt(identity)
			const info = await getCanisterInfoFromManagementCanister(
				mgmt,
				canisterId,
				identity,
			)
			return info.status as CanisterStatus
		} catch (error) {
			throw new CanisterStatusError({
				message: `Failed to get canister status: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}

	async getCanisterInfo(params: {
		canisterId: string
		identity: Identity
	}): Promise<CanisterInfo> {
		const { canisterId, identity } = params
		assertStarted(this.client, "PICReplica.getCanisterInfo")
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
				const mgmt = await this.getMgmt(identity)
				const stateTreeInfo = await getCanisterInfoFromManagementCanister(
					mgmt,
					canisterId,
					identity,
				)
			// If canister not found, return early
			if (stateTreeInfo.status === CanisterStatus.NOT_FOUND) {
				return { status: CanisterStatus.NOT_FOUND } as const
			}
			// Get full info from management canister if we're a controller
			// and status allows it (not out_of_cycles or not_controller)
			if (
				stateTreeInfo.status !== CanisterStatus.NOT_CONTROLLER &&
				stateTreeInfo.status !== CanisterStatus.OUT_OF_CYCLES
			) {
				try {
					const result = await mgmt.canister_status({
						canister_id: Principal.fromText(canisterId),
					})
					const key = Object.keys(result.status)[0]
					if (key === CanisterStatus.RUNNING) {
						const fullInfo = {
							...result,
							status: CanisterStatus.RUNNING,
						} as CanisterInfo
						return fullInfo
					}
					if (key === CanisterStatus.STOPPED) {
						const fullInfo = {
							...result,
							status: CanisterStatus.STOPPED,
						} as CanisterInfo
						return fullInfo
					}
					if (key === CanisterStatus.STOPPING) {
						const fullInfo = {
							...result,
							status: CanisterStatus.STOPPING,
						} as CanisterInfo
						return fullInfo
					}
				} catch (error) {
					// Fall through to return minimal info
				}
			}
			// Return minimal info for cases where we can't get full info
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
										stateTreeInfo.module_hash[0]!.replace(/^0x/, ""),
										"hex",
									),
								),
							]
						: [],
				reserved_cycles: 0n,
			} as CanisterInfo
				return minimalInfo
			} catch (error) {
				if (
					error instanceof Error &&
					(error.message.includes("does not belong to any subnet") ||
						error.message.includes("CanisterNotFound"))
				) {
					return { status: CanisterStatus.NOT_FOUND } as const
				}
				throw new CanisterStatusError({
					message: `Failed to get canister status: ${error instanceof Error ? error.message : String(error)}`,
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

	async createCanister(params: {
		canisterId: string | undefined
		identity: Identity
	}): Promise<string> {
		assertStarted(this.pic, "PICReplica.createCanister")
		const { canisterId, identity } = params
		const controller = identity.getPrincipal()

		// Optimistic invalidation before we start, just in case
		if (canisterId) {
			this.invalidateCache(canisterId, identity)
		}

		if (canisterId) {
			const st = await this.getCanisterStatus({ canisterId, identity })
			if (st !== CanisterStatus.NOT_FOUND) return canisterId
		}

		const topology = await this.getTopology()
		const replicaRanges = topology
			.map((subnet) =>
				subnet.canisterRanges.map(
					(range) =>
						[range.start.toHex(), range.end.toHex()] as [
							string,
							string,
						],
				),
			)
			.flat()

		const targetCanisterId = canisterId
			? Principal.fromText(canisterId)
			: undefined

		if (targetCanisterId) {
			const inAnyRange = isInRanges(
				targetCanisterId.toText(),
				replicaRanges,
			)
			if (!inAnyRange) {
				throw new CanisterCreateRangeError({
					message: `Target canister id is not in subnet range`,
				})
			}
		}

		const targetSubnetId = targetCanisterId
			? topology.find((subnet) =>
					subnet.canisterRanges.some((range) =>
						isInRanges(targetCanisterId.toText(), [
							[range.start.toHex(), range.end.toHex()],
						]),
					),
				)?.id
			: undefined

		try {
			const created = await this.pic!.createCanister({
				controllers: [controller],
				cycles: 1_000_000_000_000_000_000n,
				...(targetCanisterId ? { targetCanisterId } : {}),
				...(targetSubnetId ? { targetSubnetId } : {}),
				sender: identity.getPrincipal(),
			})
			const newCanisterId = created.toText()
			// Invalidate the new ID to ensure next read gets fresh data
			this.invalidateCache(newCanisterId, identity)
			return newCanisterId
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes(
					"is invalid because it belongs to the canister allocation ranges of the test environment",
				)
			) {
				throw new CanisterCreateRangeError({
					message: `Target canister id is in test environment range`,
				})
			}
			throw new CanisterCreateError({
				message: `Failed to create canister: ${error instanceof Error ? error.message : String(error)}`,
				cause: new Error("Failed to create canister"),
			})
		}
	}

	async stopCanister(params: {
		canisterId: string
		identity: Identity
	}): Promise<void> {
		const mgmt = await this.getMgmt(params.identity)
		try {
			await mgmt.stop_canister({
				canister_id: Principal.fromText(params.canisterId),
			})
		} catch (error) {
			throw new CanisterStopError({
				message: `Failed to stop canister: ${error instanceof Error ? error.message : String(error)}`,
			})
		} finally {
			// SAFE: Status changed. Invalidate immediately.
			this.invalidateCache(params.canisterId, params.identity)
		}
	}

	async removeCanister(params: {
		canisterId: string
		identity: Identity
	}): Promise<void> {
		const mgmt = await this.getMgmt(params.identity)
		try {
			await mgmt.delete_canister({
				canister_id: Principal.fromText(params.canisterId),
			})
		} catch (error) {
			throw new CanisterDeleteError({
				message: `Failed to delete canister: ${error instanceof Error ? error.message : String(error)}`,
			})
		} finally {
			// SAFE: Canister removed. Invalidate immediately.
			this.invalidateCache(params.canisterId, params.identity)
		}
	}

	async installCode(params: {
		canisterId: string
		wasm: Uint8Array
		encodedArgs: Uint8Array
		identity: Identity
		mode: "install" | "upgrade" | "reinstall"
	}): Promise<void> {
		assertStarted(this.pic, "PICReplica.installCode")
		const { canisterId, wasm, encodedArgs, identity, mode } = params
		const mgmt = await this.getMgmt(identity)
		const targetSubnetId = undefined as string | undefined

		const MAX_SIZE = 3_670_016
		let modePayload: InstallCodeRequest["mode"] = { install: null }
		if (mode === "upgrade") {
			// TODO: check for Enhanced orthogonal persistence in wasm metadata?
			modePayload = {
				upgrade: [
					{
						wasm_memory_persistence: [{ keep: null }],
						skip_pre_upgrade: [],
					},
				],
			}
		}
		if (mode === "reinstall") {
			modePayload = {
				reinstall: null,
			}
		}
		let modePayloadNonEAP: InstallCodeRequest["mode"] = { install: null }
		if (mode === "upgrade") {
			// TODO: check for Enhanced orthogonal persistence in wasm metadata?
			modePayloadNonEAP = {
				upgrade: [],
			}
		}
		if (mode === "reinstall") {
			modePayloadNonEAP = {
				reinstall: null,
			}
		}
		// satisfies InstallCodeChunkedRequest["mode"]

		if (wasm.length > MAX_SIZE) {
			const chunkSize = 1_048_576
			const chunkHashes: ChunkHash[] = []
			const uploads: Promise<any>[] = []

			for (let i = 0; i < wasm.length; i += chunkSize) {
				const chunk = wasm.slice(i, i + chunkSize)
				const chunkHash = sha256.arrayBuffer(chunk)
				chunkHashes.push({ hash: new Uint8Array(chunkHash) })
				uploads.push(
					mgmt.upload_chunk({
						chunk: Array.from(chunk),
						canister_id: Principal.fromText(canisterId),
					}),
				)
			}
			await Promise.all(uploads)

			const wasmModuleHash = new Uint8Array(sha256.arrayBuffer(wasm))
			const payload = {
				arg: encodedArgs,
				canister_id: Principal.fromText(canisterId),
				target_canister: Principal.fromText(canisterId),
				sender_canister_version: Opt<bigint>(),
				mode: modePayload,
				chunk_hashes_list: chunkHashes,
				store_canister: Opt<Principal>(),
				wasm_module_hash: wasmModuleHash,
			}
			const encodedPayload = encodeInstallCodeChunkedRequest(payload)

			const req = {
				canisterId: Principal.fromText("aaaaa-aa"),
				sender: identity.getPrincipal(),
				method: "install_chunked_code",
				payload: encodedPayload,
				effectivePrincipal: (targetSubnetId
					? { subnetId: Principal.fromText(targetSubnetId) }
					: {
							canisterId: Principal.fromText(canisterId),
						}) as EffectivePrincipal,
			}

			try {
				await this.client!.updateCall(req)
			} catch (error) {
				const eapError =
					"upgrade option requires that the new canister module supports enhanced orthogonal persistence"
				if (String(error).includes(eapError)) {
					try {
						const payloadNonEAP = {
							arg: encodedArgs,
							canister_id: Principal.fromText(canisterId),
							target_canister: Principal.fromText(canisterId),
							sender_canister_version: Opt<bigint>(),
							mode: modePayloadNonEAP,
							chunk_hashes_list: chunkHashes,
							store_canister: Opt<Principal>(),
							wasm_module_hash: wasmModuleHash,
						}
						const encodedPayloadNonEAP =
							encodeInstallCodeChunkedRequest(payloadNonEAP)
						const reqNonEAP = {
							canisterId: Principal.fromText("aaaaa-aa"),
							sender: identity.getPrincipal(),
							method: "install_chunked_code",
							payload: encodedPayloadNonEAP,
							effectivePrincipal: (targetSubnetId
								? {
										subnetId:
											Principal.fromText(targetSubnetId),
									}
								: {
										canisterId:
											Principal.fromText(canisterId),
									}) as EffectivePrincipal,
						}
						await this.client!.updateCall(reqNonEAP)
					} catch (error) {
						throw new CanisterInstallError({
							message: `Failed to install code (non-EAP): ${error instanceof Error ? error.message : String(error)}`,
						})
					}
				} else {
					throw new CanisterInstallError({
						message: `Failed to install code: ${error instanceof Error ? error.message : String(error)}`,
					})
				}
			}
			return
		}

		try {
			const payload = encodeInstallCodeRequest({
				arg: encodedArgs,
				canister_id: Principal.fromText(canisterId),
				mode: modePayload,
				// mode:
				// 	mode === "reinstall"
				// 		? { reinstall: null }
				// 		: mode === "upgrade"
				// 			? { upgrade: null }
				// 			: { install: null },
				wasm_module: new Uint8Array(wasm),
			})
			await this.client!.updateCall({
				canisterId: Principal.fromText("aaaaa-aa"),
				sender: identity.getPrincipal(),
				method: "install_code",
				payload,
				effectivePrincipal: (targetSubnetId
					? { subnetId: Principal.fromText(targetSubnetId) }
					: {
							canisterId: Principal.fromText(canisterId),
						}) as EffectivePrincipal,
			})
		} catch (error) {
			const eapError =
				"upgrade option requires that the new canister module supports enhanced orthogonal persistence"
			if (String(error).includes(eapError)) {
				try {
					const payloadNonEAP = encodeInstallCodeRequest({
						arg: encodedArgs,
						canister_id: Principal.fromText(canisterId),
						mode: modePayloadNonEAP,
						// mode:
						// 	mode === "reinstall"
						// 		? { reinstall: null }
						// 		: mode === "upgrade"
						// 			? { upgrade: null }
						// 			: { install: null },
						wasm_module: new Uint8Array(wasm),
					})
					await this.client!.updateCall({
						canisterId: Principal.fromText("aaaaa-aa"),
						sender: identity.getPrincipal(),
						method: "install_code",
						payload: payloadNonEAP,
						effectivePrincipal: (targetSubnetId
							? { subnetId: Principal.fromText(targetSubnetId) }
							: {
									canisterId: Principal.fromText(canisterId),
								}) as EffectivePrincipal,
					})
				} catch (error) {
					throw new CanisterInstallError({
						message: `Failed to install code (non-EAP): ${error instanceof Error ? error.message : String(error)}`,
					})
				}
			} else {
				throw new CanisterInstallError({
					message: `Failed to install code: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
		} finally {
			// SAFE: Code installed, hash changed. Invalidate immediately.
			this.invalidateCache(canisterId, identity)
		}
	}

	async createActor<_SERVICE>(params: {
		canisterId: string
		canisterDID: any
		identity: Identity
	}): Promise<ActorSubclass<_SERVICE>> {
		assertStarted(this.client, "PICReplica.createActor")
		const actor = this.pic!.createActor(
			params.canisterDID.idlFactory,
			Principal.fromText(params.canisterId),
		)
		actor.setIdentity(params.identity)
		return actor as unknown as ActorSubclass<_SERVICE>
	}
}

type ManagementActor = {
	canister_status: (p: { canister_id: Principal }) => Promise<any>
	stop_canister: (p: { canister_id: Principal }) => Promise<void>
	delete_canister: (p: { canister_id: Principal }) => Promise<void>
	upload_chunk: (p: {
		canister_id: Principal
		chunk: number[]
	}) => Promise<void>
}

function isInRanges(idText: string, ranges: [string, string][]): boolean {
	const id = idText
	return ranges.some(([start, end]) => start <= id && id <= end)
}

function assertStarted<T>(x: T | undefined, where: string): asserts x is T {
	if (!x) throw new ReplicaError({ message: `${where}: replica not started` })
}
