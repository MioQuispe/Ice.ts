import { Principal } from "@icp-sdk/core/principal";
import type { ConfigNetwork } from "./types/schema.js";
import { type ActorSubclass, type HttpAgent, type Identity, type SignIdentity } from "@icp-sdk/core/agent";
import { Effect, Layer, ManagedRuntime, Context } from "effect";
import { Schema, ParseResult } from "@effect/schema";
import { NodeContext } from "@effect/platform-node";
import { Path, FileSystem, CommandExecutor } from "@effect/platform";
import { DfxService } from "./services/dfx.js";
import type { Task, TaskTree, TaskTreeNode, ICEConfigFile } from "./types/types.js";
import { Moc } from "./services/moc.js";
import { TaskRegistry } from "./services/taskRegistry.js";
export * from "./core/builder.js";
export declare const configMap: Map<string, string>;
export declare const configLayer: Layer.Layer<never, never, never>;
declare const DeploymentError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").Equals<A, {}> extends true ? void : { readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }) => import("effect/Cause").YieldableError & {
    readonly _tag: "DeploymentError";
} & Readonly<A>;
export declare class DeploymentError extends DeploymentError_base<{
    message: string;
}> {
}
declare const ConfigError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").Equals<A, {}> extends true ? void : { readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }) => import("effect/Cause").YieldableError & {
    readonly _tag: "ConfigError";
} & Readonly<A>;
export declare class ConfigError extends ConfigError_base<{
    message: string;
}> {
}
declare const TaskCtx_base: Context.TagClass<TaskCtx, "TaskCtx", {
    readonly network: string;
    networks?: {
        [k: string]: ConfigNetwork;
    } | null;
    readonly subnet: string;
    readonly agent: HttpAgent;
    readonly identity: SignIdentity;
    readonly users: {
        [name: string]: {
            identity: Identity;
            agent: HttpAgent;
            principal: Principal;
            accountId: string;
        };
    };
    readonly runTask: typeof runTask;
}>;
export declare class TaskCtx extends TaskCtx_base {
    static Live: Layer.Layer<TaskCtx, never, DfxService>;
}
export type TaskCtxShape = Context.Tag.Service<typeof TaskCtx>;
export type Opt<T> = [T] | [];
export declare const Opt: <T>(value?: T) => Opt<T>;
export declare const getCanisterInfo: (canisterId: string) => Effect.Effect<{
    status: {
        "stopped": null;
    } | {
        "stopping": null;
    } | {
        "running": null;
    };
    memory_size: bigint;
    cycles: bigint;
    settings: import("./canisters/management_new/management.types.js").definite_canister_settings;
    idle_cycles_burned_per_day: bigint;
    module_hash: [] | [Array<number>];
} | {
    status: string;
}, unknown, DfxService>;
export declare const createCanister: (canisterId?: string) => Effect.Effect<string, DeploymentError, DfxService>;
export declare const generateDIDJS: (canisterName: string, didPath: string) => Effect.Effect<any, import("@effect/platform/Error").PlatformError | import("effect/ConfigError").ConfigError | DeploymentError, FileSystem.FileSystem | Path.Path>;
export declare const encodeArgs: (args: any[], canisterDID: any) => Uint8Array;
export declare const installCanister: ({ encodedArgs, canisterId, wasmPath, }: {
    encodedArgs: Uint8Array;
    canisterId: string;
    wasmPath: string;
}) => Effect.Effect<void, import("@effect/platform/Error").PlatformError | DeploymentError, DfxService | FileSystem.FileSystem>;
export declare const compileMotokoCanister: (src: string, canisterName: string, wasmOutputFilePath: string) => Effect.Effect<string, import("./services/moc.js").MocError, Moc>;
export declare const writeCanisterIds: (canisterName: string, canisterId: string) => Effect.Effect<void, {}, FileSystem.FileSystem | Path.Path>;
export declare const readCanisterIds: () => Effect.Effect<any, import("@effect/platform/Error").PlatformError | import("effect/ConfigError").ConfigError, FileSystem.FileSystem | Path.Path>;
declare const TaskNotFoundError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").Equals<A, {}> extends true ? void : { readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }) => import("effect/Cause").YieldableError & {
    readonly _tag: "TaskNotFoundError";
} & Readonly<A>;
export declare class TaskNotFoundError extends TaskNotFoundError_base<{
    path: string[];
    reason: string;
}> {
}
export declare const findTaskInTaskTree: (obj: TaskTree, keys: Array<string>) => Effect.Effect<Task, TaskNotFoundError>;
type TaskFullName = string;
export declare const getTaskByPath: (taskPathString: TaskFullName) => Effect.Effect<{
    task: Task<unknown, unknown, unknown, unknown>;
    iceConfig: TaskTreeNode;
}, import("@effect/platform/Error").PlatformError | ConfigError | TaskNotFoundError, FileSystem.FileSystem | Path.Path>;
export declare const DefaultsLayer: Layer.Layer<DfxService | Moc | NodeContext.NodeContext | TaskRegistry | TaskCtx, import("@effect/platform/Error").PlatformError | ConfigError | import("effect/ConfigError").ConfigError | import("./services/moc.js").MocError, never>;
export declare const runtime: ManagedRuntime.ManagedRuntime<DfxService | Moc | NodeContext.NodeContext | TaskRegistry | TaskCtx, import("@effect/platform/Error").PlatformError | ConfigError | import("effect/ConfigError").ConfigError | import("./services/moc.js").MocError>;
export type LayerRequirements<L extends Layer.Layer<any, any, any>> = L extends Layer.Layer<infer R, any, any> ? R : never;
export declare const getTaskPathById: (id: Symbol) => Effect.Effect<string, import("@effect/platform/Error").PlatformError | ConfigError | TaskNotFoundError, FileSystem.FileSystem | Path.Path>;
export declare const runTaskByPath: (taskPath: string) => Effect.Effect<void, unknown, unknown>;
declare const DependencyResults_base: Context.TagClass<DependencyResults, "DependencyResults", {
    readonly dependencies: any[];
}>;
export declare class DependencyResults extends DependencyResults_base {
}
declare const TaskInfo_base: Context.TagClass<TaskInfo, "TaskInfo", {
    readonly taskPath: string;
}>;
export declare class TaskInfo extends TaskInfo_base {
}
export interface RunTaskOptions {
    forceRun?: boolean;
}
export declare const runTask: <A, E, R, I>(task: Task<A, E, R, I>, options?: RunTaskOptions) => Effect.Effect<A, unknown, unknown>;
export declare const canistersDeployTask: () => Effect.Effect<void, unknown, unknown>;
export declare const canistersCreateTask: () => Effect.Effect<void, unknown, unknown>;
export declare const canistersBuildTask: () => Effect.Effect<void, unknown, unknown>;
export declare const canistersBindingsTask: () => Effect.Effect<void, unknown, unknown>;
export declare const canistersInstallTask: () => Effect.Effect<void, unknown, unknown>;
export declare const canistersStatusTask: () => Effect.Effect<void, Error | import("@effect/platform/Error").PlatformError | ConfigError | import("effect/ConfigError").ConfigError | ParseResult.ParseError, DfxService | FileSystem.FileSystem | Path.Path>;
export declare const listTasksTask: () => Effect.Effect<void, import("@effect/platform/Error").PlatformError | ConfigError, FileSystem.FileSystem | Path.Path>;
export declare const listCanistersTask: () => Effect.Effect<void, import("@effect/platform/Error").PlatformError | ConfigError, FileSystem.FileSystem | Path.Path>;
export { runCli } from "./cli/index.js";
export declare const getICEConfig: (configPath?: string) => Effect.Effect<ICEConfigFile, import("@effect/platform/Error").PlatformError | ConfigError, FileSystem.FileSystem | Path.Path>;
export declare const createActor: <T>({ canisterId, canisterDID, }: {
    canisterId: string;
    canisterDID: any;
}) => Effect.Effect<{
    actor: ActorSubclass<Record<string, import("@icp-sdk/core/agent").ActorMethod<unknown[], unknown>>>;
    canisterId: string;
    getControllers: () => Promise<void>;
    addControllers: (controllers: Array<string>) => Effect.Effect<void, import("@effect/platform/Error").PlatformError, import("effect/Scope").Scope>;
    setControllers: (controllers: Array<string>) => Effect.Effect<void, import("@effect/platform/Error").PlatformError, CommandExecutor.CommandExecutor | import("effect/Scope").Scope>;
}, never, CommandExecutor.CommandExecutor | DfxService>;
declare const CanisterIdsSchema: Schema.Record$<typeof Schema.String, Schema.Record$<typeof Schema.String, typeof Schema.String>>;
export type CanisterIds = Schema.Schema.Type<typeof CanisterIdsSchema>;
export declare const getCanisterIds: Effect.Effect<{
    readonly [x: string]: {
        readonly [x: string]: string;
    };
}, import("@effect/platform/Error").PlatformError | ConfigError | import("effect/ConfigError").ConfigError | ParseResult.ParseError, FileSystem.FileSystem | Path.Path>;
export { deployTaskPlugin } from "./plugins/deploy.js";
