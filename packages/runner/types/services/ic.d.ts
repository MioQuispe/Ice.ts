import { Principal } from "@icp-sdk/core/principal";
import { Context, Effect, Layer } from "effect";
declare const ICError: new (args: {
    readonly message: string;
}) => import("effect/Cause").YieldableError & {
    readonly _tag: "ICError";
} & Readonly<{
    readonly message: string;
}>;
declare const ICService_base: Context.TagClass<ICService, "ICService", {
    readonly start: () => Effect.Effect<void, typeof ICError>;
    readonly kill: () => Effect.Effect<void, typeof ICError>;
    readonly deployCanister: (params: {
        canisterName: string;
        wasm: Uint8Array;
        candid: any;
        args?: any[];
        controllers?: Principal[];
    }) => Effect.Effect<string, typeof ICError>;
    readonly getIdentity: () => Effect.Effect<Principal, typeof ICError>;
}>;
export declare class ICService extends ICService_base {
    static Live: Layer.Layer<ICService, unknown, unknown>;
}
export {};
