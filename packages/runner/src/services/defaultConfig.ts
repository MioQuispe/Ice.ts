import { Context, Effect, Layer, Option } from "effect"
import { identityToPemEd25519, Ids } from "../ids.js"
import { ICEUser } from "../types/types.js"
import { Replica, ReplicaServiceClass } from "./replica.js"
import { TaskRuntimeError } from "../tasks/lib.js"
import { Path, FileSystem } from "@effect/platform"
import { Ed25519KeyIdentity } from "@dfinity/identity"
import { Secp256k1KeyIdentity } from "@dfinity/identity-secp256k1"
import * as os from "node:os"
import { principalToAccountId } from "../utils/utils.js"

// const DfxReplicaService = DfxReplica.pipe(
// 	Layer.provide(NodeContext.layer),
// )

export type InitializedDefaultConfig = {
	network: string
	users: {
		default: ICEUser
	}
	roles: {
		deployer: string
		minter: string
		controller: string
		treasury: string
	}
	replica: ReplicaServiceClass
}

export class DefaultConfig extends Context.Tag("DefaultConfig")<
	DefaultConfig,
	InitializedDefaultConfig
>() {
	static readonly Live = Layer.effect(
		DefaultConfig,
		Effect.gen(function* () {
			yield* Effect.logDebug("[TIMING] DefaultConfig.Live started")
			const start = performance.now()
			// const defaultReplica = new PICReplica({
			// 	host: "0.0.0.0",
			// 	port: 8081,
			// 	ttlSeconds: 9_999_999_999,
			//     picConfig: {
			//         icpConfig: {
			//             betaFeatures: IcpConfigFlag.Enabled,
			//         },
			//     },
			// })

			const defaultReplica = yield* Replica
			// const icReplica = yield* ICReplica
			const startIdentity = performance.now()
			// const defaultUser = yield* Effect.tryPromise({
			// 	try: () => Ids.fromDfx("default"),
			// 	catch: () =>
			// 		new TaskRuntimeError({
			// 			message: "Failed to get default user from dfx",
			// 		}),
			// })
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const homeDir = os.homedir()

			// Path: ~/.config/ice/identities/default.json
			const identityDir = path.join(
				homeDir,
				".config",
				"ice",
				"identities",
			)

			const identityPath = path.join(identityDir, "default.pem")

			let defaultIdentity: Ed25519KeyIdentity

			if (yield* fs.exists(identityPath)) {
				const content = yield* fs.readFileString(identityPath)
				defaultIdentity = yield* Effect.tryPromise({
					try: async () => {
						const { identity } = await Ids.fromPem(content)
						return identity as Ed25519KeyIdentity
					},
					catch: (error) => {
						return new TaskRuntimeError({
							message: `Failed to parse default identity: ${error}`,
						})
					},
				})
			} else {
				const identity = Ed25519KeyIdentity.generate()
				const pem = identityToPemEd25519(identity)
				yield* fs.makeDirectory(identityDir, { recursive: true })
				yield* fs.writeFileString(identityPath, pem)
				yield* fs.chmod(identityPath, 0o600)
				yield* Effect.logInfo(
					`No default identity found, generated new one and saved to ${identityPath}`,
				)
				defaultIdentity = identity
			}

			const principal = defaultIdentity.getPrincipal().toText()
			const accountId = principalToAccountId(principal)

			const defaultUser = {
				identity: defaultIdentity,
				principal,
				accountId,
			}

			yield* Effect.logDebug(
				`[TIMING] DefaultConfig identity loaded in ${performance.now() - startIdentity}ms`,
			)

			const defaultUsers = {
				default: defaultUser,
			}
			const defaultRoles = {
				deployer: "default",
				minter: "default",
				controller: "default",
				treasury: "default",
			}

			yield* Effect.logDebug(
				`[TIMING] DefaultConfig.Live finished in ${performance.now() - start}ms`,
			)

			return {
				network: "local",
				users: defaultUsers,
				roles: defaultRoles,
				replica: defaultReplica,
			}
		}),
	)
}
