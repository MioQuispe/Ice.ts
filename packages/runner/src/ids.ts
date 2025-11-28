import { Effect, Layer, Context, Data, Config, ManagedRuntime } from "effect"
import { Command, CommandExecutor, Path, FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity"
import { Secp256k1KeyIdentity } from "@dfinity/identity-secp256k1"
import crypto from "node:crypto"
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

export const identityToPemEd25519 = (identity: Ed25519KeyIdentity): string => {
	// 1. Extract the Raw Keys
	// identity.toJSON() returns [publicKeyDer, privateKeyHex]
	const [_, privateKeyHex] = identity.toJSON()
	const publicKeyHex = Buffer.from(identity.getPublicKey().toRaw()).toString(
		"hex",
	)
	// 2. Define the ASN.1 Constants (The reverse of what you strip)
	// Sequence(83) + Version(1) + AlgoID(Ed25519) + OctetString(34) + OctetString(32)
	const PREFIX = "3053020101300506032b657004220420"
	// Context(1) + BitString(33) + Padding(0)
	const INFIX = "a123032100"

	// 3. Construct the DER Hex
	// Structure: Prefix + PrivateKey(32b) + Infix + PublicKey(32b)
	const derHex = PREFIX + privateKeyHex + INFIX + publicKeyHex

	// 4. Convert to Base64
	const base64Content = Buffer.from(derHex, "hex").toString("base64")

	// 5. Format as PEM (Wrap at 64 chars)
	const pemBody = base64Content.match(/.{1,64}/g)?.join("\n")

	return [
		"-----BEGIN PRIVATE KEY-----",
		pemBody,
		"-----END PRIVATE KEY-----",
	].join("\n")
}

const parseSecp256k1PrivateKey = (pem: string) => {
	try {
		// Parse the EC private key using Node.js crypto
		const privateKeyObject = crypto.createPrivateKey(pem)
		// Export as raw private key (32 bytes for secp256k1)
		const privateKeyDer = privateKeyObject.export({
			format: "der",
			type: "pkcs8",
		})
		// Extract the raw private key from DER format
		// EC private key in DER format has a specific structure
		// We need to extract the actual 32-byte private key
		const derHex = privateKeyDer.toString("hex")
		// Find the private key octet string (usually starts after algorithm identifier)
		// For secp256k1, the private key is typically at a specific offset
		// The structure is: SEQUENCE { version, AlgorithmIdentifier, PrivateKey }
		// We look for the octet string containing the private key (0420 indicates 32-byte octet string)
		const octetStringMatch = derHex.match(/0420([0-9a-f]{64})/)
		if (octetStringMatch && octetStringMatch[1]) {
			const privateKeyHex = octetStringMatch[1]
			const privateKeyBytes = Buffer.from(privateKeyHex, "hex")
			return Secp256k1KeyIdentity.fromSecretKey(privateKeyBytes)
		}
		// Alternative: try to find the private key in ECPrivateKey format
		// ECPrivateKey structure: SEQUENCE { version, privateKey, parameters[optional], publicKey[optional] }
		const ecPrivateKeyMatch = derHex.match(/02010104([0-9a-f]{64})/)
		if (ecPrivateKeyMatch && ecPrivateKeyMatch[1]) {
			const privateKeyHex = ecPrivateKeyMatch[1]
			const privateKeyBytes = Buffer.from(privateKeyHex, "hex")
			return Secp256k1KeyIdentity.fromSecretKey(privateKeyBytes)
		}
		// Fallback: try to extract from the raw DER structure
		// The private key might be in a different position
		throw new Error("Could not extract secp256k1 private key from PEM")
	} catch (error) {
		if (error instanceof IdsError) {
			throw error
		}
		throw new IdsError({
			message: `Failed to parse secp256k1 private key: ${error instanceof Error ? error.message : String(error)}`,
		})
	}
}

const parseIdentityFromPem = (pem: string) => {
	// Check if it's an EC private key (secp256k1)
	if (
		pem.includes("-----BEGIN EC PARAMETERS-----") ||
		pem.includes("-----BEGIN EC PRIVATE KEY-----")
	) {
		return parseSecp256k1PrivateKey(pem)
	}
	// Otherwise, assume it's Ed25519
	return parseEd25519PrivateKey(pem)
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

		// TODO: support identity.json:
		/*

┌   ICE CLI 
Error getting identity (FiberFailure) IdsError: Identity does not exist
    at file:///Users/user/projects/ice/packages/runner/dist/ids.js:41:35

 ERROR  An error has occurred                                                                                                                                      7:32:18 PM

   



 ERROR  An error has occurred                 


 format:

 {
  "hsm": null,
  "encryption": null,
  "keyring_identity_suffix": "plug_wallet"
}


        */

		const exists = yield* fs.exists(identityPath)
		if (!exists) {
			return yield* Effect.fail(
				new IdsError({ message: "Identity does not exist" }),
			)
		}

		const pem = yield* fs.readFileString(identityPath, "utf8")
		const identity = parseIdentityFromPem(pem)
		const principal = identity.getPrincipal().toText()
		const accountId = yield* getAccountId(principal)
		return {
			identity,
			principal,
			accountId,
		}
	})

const runtime = ManagedRuntime.make(Layer.mergeAll(NodeContext.layer))

/**
 * Utilities for managing Internet Computer identities.
 *
 * @group Environment
 */
export const Ids = {
	/**
	 * Loads an identity from the local dfx configuration.
	 *
	 * @param name - The name of the dfx identity to load. Defaults to the currently selected identity.
	 * @returns An `ICEUser` object containing the identity, principal, and account ID.
	 */
	fromDfx: async (name?: string) => {
		try {
			const user = await runtime.runPromise(getIdentity(name))
			return user
		} catch (error) {
			console.error("Error getting identity", error)
			throw error
		}
	},
	/**
	 * Creates an identity from a PEM string (Ed25519 or Secp256k1).
	 *
	 * @param pem - The PEM-encoded private key.
	 * @returns An `ICEUser` object.
	 */
	fromPem: async (pem: string) => {
		try {
			const identity = parseIdentityFromPem(pem)
			const principal = identity.getPrincipal().toText()
			const accountId = await runtime.runPromise(getAccountId(principal))
			return {
				identity,
				principal,
				accountId,
			}
		} catch (error) {
			console.error("Error parsing PEM identity", error)
			throw error
		}
	},
	// createLocal: async () => {
	// }
	// fromSeed: async (seed: string) => {
	// }
}
