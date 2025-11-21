import { Effect, Layer, Context, Data, Config, ManagedRuntime } from "effect"
import { Command, CommandExecutor, Path, FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity"
import os from "node:os"
import psList from "ps-list"
import { principalToAccountId } from "./utils/utils.js"

export class IdsError extends Data.TaggedError("IdsError")<{
	message: string
}> {}

const parseEd25519PrivateKey = (pem: string) => {
	const cleanedPem = pem
		.replace("-----BEGIN PRIVATE KEY-----", "")
		.replace("-----END PRIVATE KEY-----", "")
		.replace(/\n/g, "")
		.trim()
	// Obtain the DER hex string by base64-decoding the cleaned PEM.
	const derHex = Buffer.from(cleanedPem, "base64").toString("hex")
	// Remove the DER header information.
	// (This static removal works if the key structure is as expected.)
	const rawHex = derHex
		.replace("3053020101300506032b657004220420", "")
		.replace("a123032100", "")
	const keyBytes = new Uint8Array(Buffer.from(rawHex, "hex"))
	// Ensure we only pass the 32-byte secret to the identity.
	const secretKey = keyBytes.slice(0, 32)
	return Ed25519KeyIdentity.fromSecretKey(new Uint8Array(secretKey.buffer))
}

const getAccountId = (principal: string) =>
	Effect.sync(() => principalToAccountId(principal))

const getCurrentIdentity = Effect.gen(function* () {
	const command = Command.make("dfx", "identity", "whoami")
	const result = yield* Command.string(command)
	return result.trim()
})

const getIdentity = (selection?: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const identityName = selection ?? (yield* getCurrentIdentity)
		// TODO: can we use effect/platform?
		const identityPath = path.join(
			os.homedir(),
			".config/dfx/identity",
			identityName,
			"identity.pem",
		)
		const exists = yield* fs.exists(identityPath)
		if (!exists) {
			return yield* Effect.fail(
				new IdsError({ message: "Identity does not exist" }),
			)
		}

		const pem = yield* fs.readFileString(identityPath, "utf8")
		const cleanedPem = pem
			.replace("-----BEGIN PRIVATE KEY-----", "")
			.replace("-----END PRIVATE KEY-----", "")
			.replace("\n", "")
			.trim()
		// TODO: support more key types?
		const identity = parseEd25519PrivateKey(pem)
		const principal = identity.getPrincipal().toText()
		const accountId = yield* getAccountId(principal)
		return {
			identity,
			principal,
			accountId,
		}
	})

const runtime = ManagedRuntime.make(Layer.mergeAll(NodeContext.layer))

export const Ids = {
	fromDfx: async (name: string) => {
		const user = await runtime.runPromise(getIdentity(name))
		return user
	},
	// createLocal: async () => {
	// }
	// fromSeed: async (seed: string) => {
	// }
	// fromPem: async (pem: string) => {
	//     const identity = parseEd25519PrivateKey(pem);
	//     const principal = identity.getPrincipal().toText()
	//     const accountId = await runtime.runPromise(getAccountId(principal))
	//     return {
	//         identity,
	//         principal,
	//         accountId,
	//     }
	// }
}
