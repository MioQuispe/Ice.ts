import { Context, Effect, Layer } from "effect"
import { Ids } from "../ids.js"
import { ICEUser } from "../types/types.js"
import { Replica, ReplicaServiceClass } from "./replica.js"
import { TaskRuntimeError } from "../tasks/lib.js"
import { ICReplica } from "./ic-replica.js"

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
			const defaultUser = yield* Effect.tryPromise({
				try: () => Ids.fromDfx("default"),
				catch: () => new TaskRuntimeError({ message: "Failed to get default user" }),
			})

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

			return {
				users: defaultUsers,
				roles: defaultRoles,
                networks: defaultNetworks,
			}
		}),
	)
}
