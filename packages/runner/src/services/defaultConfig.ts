import { Context, Effect, Layer, Option } from "effect"
import { Ids } from "../ids.js"
import { ICEUser } from "../types/types.js"
import { Replica, ReplicaServiceClass } from "./replica.js"
import { TaskRuntimeError } from "../tasks/lib.js"

// const DfxReplicaService = DfxReplica.pipe(
// 	Layer.provide(NodeContext.layer),
// )

export type InitializedDefaultConfig = {
	users: {
		default: ICEUser
	}
	roles: {
		deployer: ICEUser
		minter: ICEUser
		controller: ICEUser
		treasury: ICEUser
	}
	networks: {
		[key: string]: {
			replica: ReplicaServiceClass
			host: string
			port: number
		}
	}
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
			const defaultUser = yield* Effect.tryPromise({
				// TODO: support identity.json
				// TODO: very slow if no name passed in (whoami)
				try: () => Ids.fromDfx("default"),
				catch: () =>
					new TaskRuntimeError({
						message: "Failed to get default user from dfx",
					}),
			})
            // .pipe(
			// 	// Effect.mapError
			// 	Effect.option,
			// )
            // Option.match
			// const defaultUser = Option.match(maybeDefaultUser, {
			// 	{
			// 		onSome: (user) => user,
            //         // TODO: create default user?
			// 		onNone: () => new TaskRuntimeError({
			// 			message: "Default user not found",
			// 		}),
			// 	},
			// )
			// TODO: handle case where identity is not found?
			yield* Effect.logDebug(
				`[TIMING] DefaultConfig identity loaded in ${performance.now() - startIdentity}ms`,
			)

			// TODO: dont export all networks. just the current network.
			const defaultNetworks = {
				local: {
					replica: defaultReplica,
					host: defaultReplica.host,
					port: defaultReplica.port,
				},
				staging: {
					replica: defaultReplica,
					host: defaultReplica.host,
					port: defaultReplica.port,
				},
				ic: {
					replica: defaultReplica,
					host: defaultReplica.host,
					port: defaultReplica.port,
				},
			}
			const defaultUsers = {
				default: defaultUser,
			}
			const defaultRoles = {
				deployer: defaultUsers.default,
				minter: defaultUsers.default,
				controller: defaultUsers.default,
				treasury: defaultUsers.default,
			}

			yield* Effect.logDebug(
				`[TIMING] DefaultConfig.Live finished in ${performance.now() - start}ms`,
			)

			return {
				users: defaultUsers,
				roles: defaultRoles,
				networks: defaultNetworks,
			}
		}),
	)
}
