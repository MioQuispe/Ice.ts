import { Effect, Layer, Context } from "effect";
import { CommandExecutor, Path, FileSystem } from "@effect/platform";
import { HttpAgent, type SignIdentity } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { DfxJson } from "../types/schema.js";
import { ConfigError } from "../index.js";
import type { ManagementActor } from "../types/types.js";
import type { PlatformError } from "@effect/platform/Error";
export declare const getAccountId: (principal: string) => Effect.Effect<string, PlatformError, CommandExecutor.CommandExecutor>;
export declare const getCurrentIdentity: Effect.Effect<string, PlatformError, CommandExecutor.CommandExecutor>;
export declare const getIdentity: (selection?: string) => Effect.Effect<{
    identity: Ed25519KeyIdentity;
    pem: string;
    name: string;
    principal: string;
    accountId: string;
}, PlatformError | ConfigError, CommandExecutor.CommandExecutor | FileSystem.FileSystem | Path.Path>;
export declare const dfxDefaults: DfxJson;
declare const DfxError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").Equals<A, {}> extends true ? void : { readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }) => import("effect/Cause").YieldableError & {
    readonly _tag: "DfxError";
} & Readonly<A>;
export declare class DfxError extends DfxError_base<{
    readonly message: string;
}> {
}
declare const DfxService_base: Context.TagClass<DfxService, "DfxService", {
    readonly start: () => Effect.Effect<void, PlatformError>;
    readonly stop: () => Effect.Effect<void, DfxError>;
    readonly getWebserverPort: () => Effect.Effect<number, DfxError>;
    readonly getIdentity: (selection?: string) => Effect.Effect<{
        identity: SignIdentity;
        pem: string;
        name: string;
        principal: string;
        accountId: string;
    }, DfxError | PlatformError>;
    readonly network: string;
    readonly identity: SignIdentity;
    readonly agent: HttpAgent;
    readonly mgmt: ManagementActor;
}>;
export declare class DfxService extends DfxService_base {
    static Live: Layer.Layer<DfxService, PlatformError | ConfigError | import("effect/ConfigError").ConfigError, CommandExecutor.CommandExecutor | FileSystem.FileSystem | Path.Path>;
}
export {};
