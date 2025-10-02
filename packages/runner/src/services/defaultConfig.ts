import { Context, Effect, Layer } from "effect"
import { Ids } from "../ids.js"
import { ICEUser } from "../types/types.js"
import { DefaultReplica, ReplicaServiceClass } from "./replica.js"
import { TaskRuntimeError } from "../tasks/lib.js"

// const DfxReplicaService = DfxReplica.pipe(
// 	Layer.provide(NodeContext.layer),
// 	Layer.provide(configLayer),
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
			const defaultReplica = yield* DefaultReplica
			const defaultUser = yield* Effect.tryPromise({
				try: () => Ids.fromDfx("default"),
				catch: () => new TaskRuntimeError({ message: "Failed to get default user" }),
			})
			const defaultNetworks = {
				local: {
					replica: defaultReplica,
					host: "https://0.0.0.0",
					port: 8080,
				},
				staging: {
					replica: defaultReplica,
					host: "https://staging.ic0.app",
					port: 80,
				},
				ic: {
					replica: defaultReplica,
					host: "https://ic0.app",
					port: 80,
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
