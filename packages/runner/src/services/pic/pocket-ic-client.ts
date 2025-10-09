import { Http2Client } from "./http2-client.js"
import { Principal } from "@icp-sdk/core/principal"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import {
	EncodedAddCyclesRequest,
	EncodedAddCyclesResponse,
	EncodedCanisterCallRequest,
	EncodedCanisterCallResponse,
	EncodedGetSubnetIdRequest,
	EncodedCreateInstanceRequest,
	CreateInstanceResponse,
	EncodedGetCyclesBalanceRequest,
	EncodedGetStableMemoryRequest,
	EncodedGetStableMemoryResponse,
	EncodedGetTimeResponse,
	EncodedSetTimeRequest,
	EncodedGetSubnetIdResponse,
	decodeGetTopologyResponse,
	InstanceTopology,
	GetStableMemoryRequest,
	encodeGetStableMemoryRequest,
	GetStableMemoryResponse,
	decodeGetStableMemoryResponse,
	SetStableMemoryRequest,
	encodeSetStableMemoryRequest,
	AddCyclesRequest,
	encodeAddCyclesRequest,
	AddCyclesResponse,
	decodeAddCyclesResponse,
	EncodedGetCyclesBalanceResponse,
	GetCyclesBalanceResponse,
	decodeGetCyclesBalanceResponse,
	encodeGetCyclesBalanceRequest,
	GetCyclesBalanceRequest,
	GetSubnetIdResponse,
	GetSubnetIdRequest,
	encodeGetSubnetIdRequest,
	decodeGetSubnetIdResponse,
	GetTimeResponse,
	decodeGetTimeResponse,
	SetTimeRequest,
	encodeSetTimeRequest,
	CanisterCallRequest,
	encodeCanisterCallRequest,
	CanisterCallResponse,
	decodeUploadBlobResponse,
	UploadBlobResponse,
	UploadBlobRequest,
	encodeUploadBlobRequest,
	CreateInstanceRequest,
	encodeCreateInstanceRequest,
	GetPubKeyRequest,
	EncodedGetPubKeyRequest,
	encodeGetPubKeyRequest,
	EncodedSetStableMemoryRequest,
	decodeCanisterCallResponse,
	EncodedGetPendingHttpsOutcallsResponse,
	GetPendingHttpsOutcallsResponse,
	decodeGetPendingHttpsOutcallsResponse,
	EncodedMockPendingHttpsOutcallRequest,
	encodeMockPendingHttpsOutcallRequest,
	MockPendingHttpsOutcallRequest,
	EncodedSubmitCanisterCallResponse,
	decodeSubmitCanisterCallResponse,
	SubmitCanisterCallResponse,
	SubmitCanisterCallRequest,
	encodeSubmitCanisterCallRequest,
	EncodedSubmitCanisterCallRequest,
	encodeAwaitCanisterCallRequest,
	AwaitCanisterCallRequest,
	EncodedAwaitCanisterCallRequest,
	AwaitCanisterCallResponse,
	EncodedAwaitCanisterCallResponse,
	decodeAwaitCanisterCallResponse,
	EncodedGetTopologyResponse,
	EncodedGetControllersRequest,
	EncodedGetControllersResponse,
	GetControllersRequest,
	GetControllersResponse,
	decodeGetControllersResponse,
	encodeGetControllersRequest,
	MakeLiveRequest,
	EncodedMakeLiveRequest,
	encodeMakeLiveRequest,
} from "./pocket-ic-client-types.js"
import { existsSync } from "node:fs"
import { readdirSync } from "node:fs"
import { join } from "node:path"


export function inspectStateDir(dir: string) {
    const topo = existsSync(join(dir, "topology.json"));
    const reg  = existsSync(join(dir, "registry.proto"));
    const hasHashed = readdirSync(dir, { withFileTypes: true })
      .some(d => d.isDirectory() && /^[0-9a-f]{64}$/.test(d.name));
    return { topo, reg, hasHashed };
  }
export const logStateDir = async (stateDir: string, tag: string): Promise<void> => {
	if (!stateDir) return
	try {
        const { topo, reg, hasHashed } = inspectStateDir(stateDir)
		console.log(
			`[PocketIcClient] stateDir ${tag}: topo=${topo} reg=${reg} dir=${stateDir} hasHashed=${hasHashed}`,
		)
	} catch {}
}

const PROCESSING_TIME_VALUE_MS = 30_000

export class PocketIcClient {
	private isInstanceDeleted = false
	private readonly stateDir: string | undefined
	private readonly backupDir: string | undefined

	constructor(
		private readonly serverClient: Http2Client,
		private readonly instancePath: string,
		stateDir?: string,
		backupDir?: string,
	) {
		this.stateDir = stateDir
		this.backupDir = backupDir
	}

	public static async create(
		url: string,
		req?: CreateInstanceRequest,
	): Promise<PocketIcClient> {
		const processingTimeoutMs =
			req?.processingTimeoutMs ?? PROCESSING_TIME_VALUE_MS
		const serverClient = new Http2Client(url, processingTimeoutMs)

		await logStateDir(req?.stateDir!, "before create instance")
		// Always create a new instance to ensure desired configuration (e.g., state_dir)
		const body = encodeCreateInstanceRequest(req)
		const t0 = Date.now()
		try {
			console.log(
				`[PocketIcClient] create_instance request: timeoutMs=${processingTimeoutMs} state_dir=${req?.stateDir} incomplete_state=${req?.incompleteState} nonmainnet=${req?.nonmainnetFeatures} system=${body.subnet_config_set.system.length} application=${body.subnet_config_set.application.length} verified_application=${body.subnet_config_set.verified_application.length}`,
			)
		} catch {}
		const res = await serverClient
			.jsonPost<EncodedCreateInstanceRequest, CreateInstanceResponse>({
				path: "/instances",
				body,
			})
			.catch((error) => {
				const detail =
					error instanceof Error
						? `${error.message}${
								error.cause
									? ` (cause=${String(error.cause)})`
									: ""
							}`
						: String(error)
				console.error(
					`[PocketIcClient] create_instance request failed url=${url} stateDir=${req?.stateDir ?? "-"}: ${detail}`,
				)
				throw error
			})
		const t1 = Date.now()
		try {
			console.log(
				`[PocketIcClient] create_instance response in ${t1 - t0}ms: ${"Error" in res ? "Error" : "Created"}`,
			)
		} catch {}

		if ("Error" in res) {
			console.error("Error creating instance", res.Error.message)
			throw new Error(res.Error.message)
		}

		const instanceId = res.Created.instance_id
		// const instanceId = 0
		try {
			console.log(
				`[PocketIcClient] created instance id=${instanceId} url=${url} state_dir=${req?.stateDir} incomplete_state=${req?.incompleteState}`,
			)
		} catch {}
		return new PocketIcClient(
			serverClient,
			`/instances/${instanceId}`,
			req?.stateDir,
		)
	}

	public async deleteInstance(): Promise<void> {
		this.assertInstanceNotDeleted()

		await this.serverClient.request({
			method: "DELETE",
			path: this.instancePath,
		})

		this.isInstanceDeleted = true
		await logStateDir(this.stateDir!, "after DELETE instance")
	}

	public async makeLive(req: MakeLiveRequest): Promise<void> {
		this.assertInstanceNotDeleted()
		await this.post<EncodedMakeLiveRequest, {}>(
			"/auto_progress",
			encodeMakeLiveRequest(req),
		)
		await logStateDir(this.stateDir!, "after /auto_progress")
	}

	public async getControllers(
		req: GetControllersRequest,
	): Promise<GetControllersResponse> {
		this.assertInstanceNotDeleted()

		const res = await this.post<
			EncodedGetControllersRequest,
			EncodedGetControllersResponse
		>("/read/get_controllers", encodeGetControllersRequest(req))

		return decodeGetControllersResponse(res)
	}

	public async tick(): Promise<{}> {
		this.assertInstanceNotDeleted()

		return await this.post<{}, {}>("/update/tick", {})
	}

	public async stopProgress(): Promise<void> {
		this.assertInstanceNotDeleted()
		await this.post<{}, {}>("/stop_progress", {})
		await logStateDir(this.stateDir!, "after /stop_progress")
	}

	public async getPubKey(req: GetPubKeyRequest): Promise<Uint8Array> {
		this.assertInstanceNotDeleted()

		return await this.post<EncodedGetPubKeyRequest, Uint8Array>(
			"/read/pub_key",
			encodeGetPubKeyRequest(req),
		)
	}

	public async getTopology(): Promise<InstanceTopology> {
		this.assertInstanceNotDeleted()

		const res = await this.get<EncodedGetTopologyResponse>("/_/topology")

		return decodeGetTopologyResponse(res)
	}

	// Raw encoded topology (for persisting to state_dir/topology.json)
	public async getTopologyEncoded(): Promise<EncodedGetTopologyResponse> {
		this.assertInstanceNotDeleted()
		return await this.get<EncodedGetTopologyResponse>("/_/topology")
	}

	public async getTime(): Promise<GetTimeResponse> {
		this.assertInstanceNotDeleted()

		const res = await this.get<EncodedGetTimeResponse>("/read/get_time")

		return decodeGetTimeResponse(res)
	}

	public async setTime(req: SetTimeRequest): Promise<void> {
		this.assertInstanceNotDeleted()

		await this.post<EncodedSetTimeRequest, {}>(
			"/update/set_time",
			encodeSetTimeRequest(req),
		)
	}

	public async setCertifiedTime(req: SetTimeRequest): Promise<void> {
		this.assertInstanceNotDeleted()

		await this.post<EncodedSetTimeRequest, {}>(
			"/update/set_certified_time",
			encodeSetTimeRequest(req),
		)
	}

	public async getSubnetId(
		req: GetSubnetIdRequest,
	): Promise<GetSubnetIdResponse> {
		this.assertInstanceNotDeleted()
		const t0 = Date.now()
		const res = await this.post<
			EncodedGetSubnetIdRequest,
			EncodedGetSubnetIdResponse
		>("/read/get_subnet", encodeGetSubnetIdRequest(req))
		const t1 = Date.now()
		const decoded = decodeGetSubnetIdResponse(res)
		try {
			console.log(
				`[PocketIcClient] get_subnet decoded in ${t1 - t0}ms -> ${decoded.subnetId ? decoded.subnetId.toText() : "null"}`,
			)
		} catch {}
		return decoded
	}

	// --- Diagnostics helpers ---

	public async debugTopologySummary(tag: string): Promise<void> {
		try {
			const topo = await this.getTopology()
			const summary = Object.entries(topo).map(([subnetText, info]) => {
				return {
					subnet: subnetText,
					kind: info.type,
					size: info.size,
					rangesCount: info.canisterRanges.length,
					firstRanges: info.canisterRanges.slice(0, 2).map((r) => ({
						start: r.start.toText(),
						end: r.end.toText(),
					})),
				}
			})
			console.log(
				`[PocketIcClient] topo(${tag}) summary=${JSON.stringify(summary)}`,
			)
		} catch {}
	}

	public async debugCheckCanisterRouting(
		canisterIdText: string,
	): Promise<void> {
		try {
			const canisterId = canisterIdText
			const [topology, got] = await Promise.all([
				this.getTopology(),
				this.getSubnetId({
					canisterId: Principal.fromText(canisterId),
				}),
			])
			let inAny = false
			let matchSubnet: string | undefined
			const canBytes = Principal.fromText(canisterId).toUint8Array()
			outer: for (const [subnetText, info] of Object.entries(topology)) {
				for (const r of info.canisterRanges) {
					const start = r.start.toUint8Array()
					const end = r.end.toUint8Array()
					const geStart =
						Buffer.compare(
							Buffer.from(canBytes),
							Buffer.from(start),
						) >= 0
					const leEnd =
						Buffer.compare(
							Buffer.from(canBytes),
							Buffer.from(end),
						) <= 0
					if (geStart && leEnd) {
						inAny = true
						matchSubnet = subnetText
						break outer
					}
				}
			}
			console.log(
				`[PocketIcClient] debug routing canister=${canisterId} inAny=${inAny} matchSubnet=${matchSubnet ?? "-"} get_subnet=${got.subnetId ? got.subnetId.toText() : "null"}`,
			)
		} catch (e) {
			console.log(`[PocketIcClient] debug routing failed: ${String(e)}`)
		}
	}

	public async debugProbeRange(
		canisterIdText: string,
		tag: string,
	): Promise<void> {
		try {
			const topo = await this.getTopology()
			const can = Principal.fromText(canisterIdText)
			const canBytes = can.toUint8Array()
			let foundRange:
				| { subnet: string; start: Uint8Array; end: Uint8Array }
				| undefined
			for (const [subnetText, info] of Object.entries(topo)) {
				for (const r of info.canisterRanges) {
					const start = r.start.toUint8Array()
					const end = r.end.toUint8Array()
					const geStart =
						Buffer.compare(
							Buffer.from(canBytes),
							Buffer.from(start),
						) >= 0
					const leEnd =
						Buffer.compare(
							Buffer.from(canBytes),
							Buffer.from(end),
						) <= 0
					if (geStart && leEnd) {
						foundRange = { subnet: subnetText, start, end }
						break
					}
				}
				if (foundRange) break
			}
			const probes: string[] = []
			if (foundRange) {
				const startP = Principal.fromUint8Array(
					foundRange.start,
				).toText()
				const endP = Principal.fromUint8Array(foundRange.end).toText()
				probes.push(startP, canisterIdText, endP)
			}
			const results: Array<{ id: string; subnet: string | null }> = []
			for (const pid of probes) {
				try {
					const res = await this.getSubnetId({
						canisterId: Principal.fromText(pid),
					})
					results.push({
						id: pid,
						subnet: res.subnetId ? res.subnetId.toText() : null,
					})
				} catch {
					results.push({ id: pid, subnet: null })
				}
			}
			console.log(
				`[PocketIcClient] probe(${tag}) rangeSubnet=${foundRange?.subnet ?? "-"} results=${JSON.stringify(
					results,
				)}`,
			)
		} catch (e) {
			console.log(`[PocketIcClient] probe failed: ${String(e)}`)
		}
	}

	public async debugSnapshotStateDir(tag: string): Promise<void> {
		if (!this.stateDir) return
		try {
			const dir = this.stateDir
			const snapDir = path.resolve(path.join(dir, `debug.${tag}`))
			await fs.mkdir(snapDir, { recursive: true }).catch(() => {})
			// List top-level
			let listing: string[] = []
			try {
				const entries = await fs.readdir(dir, { withFileTypes: true })
				listing = entries.map(
					(e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`,
				)
			} catch {}
			await fs
				.writeFile(
					path.join(snapDir, "listing.txt"),
					listing.join("\n"),
					"utf8",
				)
				.catch(() => {})
			// Save server topology
			try {
				const topo = await this.getTopology()
				await fs
					.writeFile(
						path.join(snapDir, "server_topology.json"),
						JSON.stringify(topo, null, 2),
						"utf8",
					)
					.catch(() => {})
			} catch {}
			// Copy local files if present
			const topoPath = path.resolve(path.join(dir, "topology.json"))
			const regPath = path.resolve(path.join(dir, "registry.proto"))
			const topoExists = await fs
				.access(topoPath)
				.then(() => true)
				.catch(() => false)
			const regExists = await fs
				.access(regPath)
				.then(() => true)
				.catch(() => false)
			await fs
				.writeFile(
					path.join(snapDir, "presence.json"),
					JSON.stringify({ topoExists, regExists }, null, 2),
					"utf8",
				)
				.catch(() => {})
		} catch {}
	}

	public async getCyclesBalance(
		req: GetCyclesBalanceRequest,
	): Promise<GetCyclesBalanceResponse> {
		this.assertInstanceNotDeleted()

		const res = await this.post<
			EncodedGetCyclesBalanceRequest,
			EncodedGetCyclesBalanceResponse
		>("/read/get_cycles", encodeGetCyclesBalanceRequest(req))

		return decodeGetCyclesBalanceResponse(res)
	}

	public async addCycles(req: AddCyclesRequest): Promise<AddCyclesResponse> {
		this.assertInstanceNotDeleted()

		const res = await this.post<
			EncodedAddCyclesRequest,
			EncodedAddCyclesResponse
		>("/update/add_cycles", encodeAddCyclesRequest(req))

		return decodeAddCyclesResponse(res)
	}

	public async uploadBlob(
		req: UploadBlobRequest,
	): Promise<UploadBlobResponse> {
		this.assertInstanceNotDeleted()

		const res = await this.serverClient.request({
			method: "POST",
			path: "/blobstore",
			body: encodeUploadBlobRequest(req),
		})

		const body = await res.text()
		return decodeUploadBlobResponse(body)
	}

	public async setStableMemory(req: SetStableMemoryRequest): Promise<void> {
		this.assertInstanceNotDeleted()

		await this.serverClient.jsonPost<EncodedSetStableMemoryRequest, {}>({
			path: `${this.instancePath}/update/set_stable_memory`,
			body: encodeSetStableMemoryRequest(req),
		})
	}

	public async getStableMemory(
		req: GetStableMemoryRequest,
	): Promise<GetStableMemoryResponse> {
		this.assertInstanceNotDeleted()

		const res = await this.post<
			EncodedGetStableMemoryRequest,
			EncodedGetStableMemoryResponse
		>("/read/get_stable_memory", encodeGetStableMemoryRequest(req))

		return decodeGetStableMemoryResponse(res)
	}

	public async getPendingHttpsOutcalls(): Promise<
		GetPendingHttpsOutcallsResponse[]
	> {
		this.assertInstanceNotDeleted()

		const res = await this.get<EncodedGetPendingHttpsOutcallsResponse[]>(
			"/read/get_canister_http",
		)

		return decodeGetPendingHttpsOutcallsResponse(res)
	}

	public async mockPendingHttpsOutcall(
		req: MockPendingHttpsOutcallRequest,
	): Promise<void> {
		this.assertInstanceNotDeleted()

		await this.post<EncodedMockPendingHttpsOutcallRequest, {}>(
			"/update/mock_canister_http",
			encodeMockPendingHttpsOutcallRequest(req),
		)
	}

	public async updateCall(
		req: CanisterCallRequest,
	): Promise<CanisterCallResponse> {
		this.assertInstanceNotDeleted()
		const finalReq: SubmitCanisterCallRequest = { ...req }
		if (
			!finalReq.effectivePrincipal &&
			finalReq.canisterId.toText() !== "aaaaa-aa"
		) {
			finalReq.effectivePrincipal = { canisterId: finalReq.canisterId }
		}
		try {
			console.log(
				`[PocketIcClient] update canister=${finalReq.canisterId.toText()} method=${finalReq.method} eff=${JSON.stringify(finalReq.effectivePrincipal ?? "none")}`,
			)
		} catch {}
		const res = await this.submitCall(finalReq)
		return await this.awaitCall(res)
	}

	public async queryCall(
		req: CanisterCallRequest,
	): Promise<CanisterCallResponse> {
		this.assertInstanceNotDeleted()
		const finalReq: CanisterCallRequest = { ...req }
		if (
			!finalReq.effectivePrincipal &&
			finalReq.canisterId.toText() !== "aaaaa-aa"
		) {
			finalReq.effectivePrincipal = { canisterId: finalReq.canisterId }
		}
		try {
			console.log(
				`[PocketIcClient] query canister=${finalReq.canisterId.toText()} method=${finalReq.method} eff=${JSON.stringify(finalReq.effectivePrincipal ?? "none")}`,
			)
		} catch {}
		const res = await this.post<
			EncodedCanisterCallRequest,
			EncodedCanisterCallResponse
		>("/read/query", encodeCanisterCallRequest(finalReq))

		return decodeCanisterCallResponse(res)
	}

	public async submitCall(
		req: SubmitCanisterCallRequest,
	): Promise<SubmitCanisterCallResponse> {
		this.assertInstanceNotDeleted()
		const finalReq: SubmitCanisterCallRequest = { ...req }
		if (
			!finalReq.effectivePrincipal &&
			finalReq.canisterId.toText() !== "aaaaa-aa"
		) {
			finalReq.effectivePrincipal = { canisterId: finalReq.canisterId }
		}

		let res: EncodedSubmitCanisterCallResponse
		const t0 = Date.now()
		// TODO: this might cause issues if call fails for some other reason
		if (
			finalReq.canisterId.toText() === "aaaaa-aa" &&
			finalReq.method === "canister_status"
			// req.method === "install_code" ||
			// req.method === "install_chunked_code"
		) {
			res = await this.postNoPoll<
				EncodedSubmitCanisterCallRequest,
				EncodedSubmitCanisterCallResponse
			>(
				"/update/submit_ingress_message",
				encodeSubmitCanisterCallRequest(finalReq),
			)
		} else {
			res = await this.post<
				EncodedSubmitCanisterCallRequest,
				EncodedSubmitCanisterCallResponse
			>(
				"/update/submit_ingress_message",
				encodeSubmitCanisterCallRequest(finalReq),
			)
		}
		const t1 = Date.now()
		try {
			console.log(
				`[PocketIcClient] submit_ingress_message in ${t1 - t0}ms -> ${"Err" in res ? "Err" : "Ok"}`,
			)
		} catch {}

		return decodeSubmitCanisterCallResponse(res)
	}

	public async awaitCall(
		req: AwaitCanisterCallRequest,
	): Promise<AwaitCanisterCallResponse> {
		this.assertInstanceNotDeleted()
		const t0 = Date.now()

		const res = await this.post<
			EncodedAwaitCanisterCallRequest,
			EncodedAwaitCanisterCallResponse
		>("/update/await_ingress_message", encodeAwaitCanisterCallRequest(req))
		const t1 = Date.now()
		try {
			console.log(
				`[PocketIcClient] await_ingress_message in ${t1 - t0}ms`,
			)
		} catch {}

		return decodeAwaitCanisterCallResponse(res)
	}

	private async post<B, R extends {}>(
		endpoint: string,
		body?: B,
	): Promise<R> {
		try {
			console.log(
				`[PocketIcClient] POST ${this.instancePath}${endpoint} body=${body ? "yes" : "no"}`,
			)
		} catch {}
		// @ts-ignore
		const res = await this.serverClient.jsonPost<B, R>({
			path: `${this.instancePath}${endpoint}`,
			body,
		})
		await logStateDir(this.stateDir!, `after POST ${endpoint} instancePath=${this.instancePath} endpoint=${endpoint}`)
		return res
	}

	private async postNoPoll<B, R extends {}>(
		endpoint: string,
		body?: B,
	): Promise<R> {
		try {
			console.log(
				`[PocketIcClient] POST(no-poll) ${this.instancePath}${endpoint} body=${body ? "yes" : "no"}`,
			)
		} catch {}
		// @ts-ignore
		const res = await this.serverClient.jsonPost<B, R>({
			path: `${this.instancePath}${endpoint}`,
			body,
		})
		await logStateDir(this.stateDir!, `after POST(no-poll) ${endpoint}`)
		return res
	}

	private async get<R extends {}>(endpoint: string): Promise<R> {
		try {
			console.log(`[PocketIcClient] GET ${this.instancePath}${endpoint}`)
		} catch {}
		const res = await this.serverClient.jsonGet<R>({
			path: `${this.instancePath}${endpoint}`,
		})
		await logStateDir(this.stateDir!, `after GET ${endpoint}`)
		return res
	}

	private assertInstanceNotDeleted(): void {
		if (this.isInstanceDeleted) {
			throw new Error("Instance was deleted")
		}
	}
}
