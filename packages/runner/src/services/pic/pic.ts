// pic.ts (async/await version, no effect-ts)

import * as url from "node:url"
import { Principal } from "@icp-sdk/core/principal"
import {
	//   ActorSubclass,
	type SignIdentity,
} from "@icp-sdk/core/agent"
import { CreateInstanceOptions, PocketIc, createActorClass } from "@dfinity/pic"
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
	CanisterInfo,
	CanisterStatusResult,
	CanisterCreateRangeError,
	ReplicaError,
    ReplicaServiceClass,
} from "../replica.js"
import { idlFactory } from "../../canisters/management_latest/management.did.js"
import { sha256 } from "js-sha256"
import { Opt } from "../../index.js"
import {
	EffectivePrincipal,
	SubnetStateType,
} from "./pocket-ic-client-types.js"
import { ActorSubclass, Actor } from "../../types/actor.js"
import { makeMonitor, type Monitor } from "./pic-process.js"
import type { ICEConfigContext } from "../../types/types.js"

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

// ---------------- default PIC topology config ----------------

const defaultPicConfig: CreateInstanceOptions = {
	nns: { state: { type: SubnetStateType.New } },
	ii: { state: { type: SubnetStateType.New } },
	fiduciary: { state: { type: SubnetStateType.New } },
	bitcoin: { state: { type: SubnetStateType.New } },
	sns: { state: { type: SubnetStateType.New } },
	application: [{ state: { type: SubnetStateType.New } }],
}

// ---------------- class ----------------

export class PICReplica implements ReplicaServiceClass {
	public readonly host: string // "0.0.0.0" (ip)
	public readonly port: number
	public readonly ttlSeconds: number
	private readonly ctx: ICEConfigContext
	private readonly picConfig: CreateInstanceOptions

	private monitor?: Monitor
	private client?: InstanceType<typeof CustomPocketIcClient>
	private pic?: PocketIc
	private started = false

	constructor(
		ctx: ICEConfigContext,
		opts: {
			host?: string
			port?: number
			ttlSeconds?: number
			picConfig?: CreateInstanceOptions
		} = {},
	) {
		this.ctx = ctx
		this.host = opts.host ?? "0.0.0.0"
		this.port = opts.port ?? 8081
		this.ttlSeconds = opts.ttlSeconds ?? 9_999_999_999
		this.picConfig = opts.picConfig ?? defaultPicConfig
	}

	async start(): Promise<void> {
		if (this.started) return

		// Start/adopt/reuse monitor
		const monitor = await makeMonitor(this.ctx, {
			host: this.host,
			port: this.port,
			ttlSeconds: this.ttlSeconds,
		})
		this.monitor = monitor

		// Build client; in foreground, fail fast on fatal stderr
		const baseUrl = `${monitor.host}:${monitor.port}` // monitor.host already includes http://
		const createClient = CustomPocketIcClient.create(
			baseUrl,
			this.picConfig,
		)

		this.client = (
			monitor.fatalStderr
				? await Promise.race([
						monitor.fatalStderr, // rejects on fatal
						createClient,
					])
				: await createClient
		) as InstanceType<typeof CustomPocketIcClient>

		// Construct PocketIc on top of the custom client
		// @ts-ignore constructor is private in types but needed here
		this.pic = new PocketIc(this.client)

		// makeLive (best effort)
		try {
			await this.client.makeLive({ artificialDelayMs: 0 })
		} catch {
			// ignore best-effort failure
		}

		this.started = true
	}

	async stop(): Promise<void> {
		// Foreground: actively shut down the monitor (which kills the group)
		// Background/adopted: no-op by design
		try {
			this.monitor?.shutdown()
		} catch {}
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

	private async getMgmt(identity: SignIdentity) {
		assertStarted(this.client, "PICReplica.getMgmt")
		const Mgmt = createActorClass<ManagementActor>(
			idlFactory,
			Principal.fromText("aaaaa-aa"),
			// @ts-ignore: we need to inject the client here
			this.client,
		)
		const mgmt = new Mgmt()
		mgmt.setIdentity(identity)
		return mgmt
	}

	async getCanisterStatus(params: {
		canisterId: string
		identity: SignIdentity
	}): Promise<CanisterStatus> {
		const { canisterId, identity } = params
		const mgmt = await this.getMgmt(identity)
		try {
			if (!canisterId) return CanisterStatus.NOT_FOUND
			try {
				const info = await mgmt.canister_status({
					canister_id: Principal.fromText(canisterId),
				})
				const key = Object.keys(info.status)[0]
				if (key === CanisterStatus.RUNNING)
					return CanisterStatus.RUNNING
				if (key === CanisterStatus.STOPPED)
					return CanisterStatus.STOPPED
				return CanisterStatus.NOT_FOUND
			} catch {
				return CanisterStatus.NOT_FOUND
			}
		} catch (error) {
			throw new CanisterStatusError({
				message: `Failed to get canister status: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}

	async getCanisterInfo(params: {
		canisterId: string
		identity: SignIdentity
	}): Promise<CanisterInfo> {
		const { canisterId, identity } = params
		const mgmt = await this.getMgmt(identity)
		if (!canisterId) return { status: CanisterStatus.NOT_FOUND } as const
		try {
			const result = await mgmt.canister_status({
				canister_id: Principal.fromText(canisterId),
			})
			const key = Object.keys(result.status)[0]
			if (key === CanisterStatus.RUNNING)
				return {
					...result,
					status: CanisterStatus.RUNNING,
				} as CanisterInfo
			if (key === CanisterStatus.STOPPED)
				return {
					...result,
					status: CanisterStatus.STOPPED,
				} as CanisterInfo
			return { status: CanisterStatus.NOT_FOUND } as const
		} catch (error) {
			// Not found cases we normalize to NOT_FOUND
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
		}
	}

	async createCanister(params: {
		canisterId: string | undefined
		identity: SignIdentity
	}): Promise<string> {
		assertStarted(this.pic, "PICReplica.createCanister")
		const { canisterId, identity } = params
		const controller = identity.getPrincipal()

		if (canisterId) {
			// If already exists (or is not NOT_FOUND), reuse
			const st = await this.getCanisterStatus({ canisterId, identity })
			if (st !== CanisterStatus.NOT_FOUND) return canisterId
		}

		// compute subnet ranges from topology
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
			return created.toText()
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
		identity: SignIdentity
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
		}
	}

	async removeCanister(params: {
		canisterId: string
		identity: SignIdentity
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
		}
	}

	async installCode(params: {
		canisterId: string
		wasm: Uint8Array
		encodedArgs: Uint8Array
		identity: SignIdentity
		mode: "install" | "upgrade" | "reinstall"
	}): Promise<void> {
		assertStarted(this.pic, "PICReplica.installCode")
		const { canisterId, wasm, encodedArgs, identity, mode } = params
		const mgmt = await this.getMgmt(identity)
		const targetSubnetId = undefined as string | undefined
		const modePayload: {
			reinstall?: null
			upgrade?: null
			install?: null
		} = { [mode]: null }

		const MAX_SIZE = 3_670_016 // same as before

		if (wasm.length > MAX_SIZE) {
			// chunked
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
					: undefined) as EffectivePrincipal,
			}

			try {
				await this.client!.updateCall(req)
			} catch (error) {
				throw new CanisterInstallError({
					message: `Failed to install code: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
			return
		}

		// non-chunked
		try {
			if (mode === "reinstall") {
				await this.pic!.reinstallCode({
					arg: encodedArgs.buffer,
					sender: identity.getPrincipal(),
					canisterId: Principal.fromText(canisterId),
					wasm: wasm.buffer,
				})
			} else if (mode === "install") {
				await this.pic!.installCode({
					arg: encodedArgs.buffer,
					sender: identity.getPrincipal(),
					canisterId: Principal.fromText(canisterId),
					wasm: wasm.buffer,
				})
			} else {
				await this.pic!.upgradeCanister({
					arg: encodedArgs.buffer,
					sender: identity.getPrincipal(),
					canisterId: Principal.fromText(canisterId),
					wasm: wasm.buffer,
				})
			}
		} catch (error) {
			throw new CanisterInstallError({
				message: `Failed to install code: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}

	async createActor<_SERVICE>(params: {
		canisterId: string
		canisterDID: any
		identity: SignIdentity
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

// small utils

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
	// lightweight check for text ranges: hex compare as strings (consistent with earlier approach)
	const id = idText
	return ranges.some(([start, end]) => start <= id && id <= end)
}

function assertStarted<T>(x: T | undefined, where: string): asserts x is T {
	if (!x) throw new ReplicaError({ message: `${where}: replica not started` })
}

// export const 