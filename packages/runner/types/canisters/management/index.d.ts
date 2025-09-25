import type { ExtendedCanisterConfiguration } from "@ice.ts/runner";
type InitArgs = {
    owner: string;
};
export declare const Management: {
    ({ owner }: InitArgs): ExtendedCanisterConfiguration;
    id: {
        local: string;
        ic: string;
    };
    idlFactory: any;
    scripts: {};
};
export type ManagementActor = import("@icp-sdk/core/agent").ActorSubclass<import("./management.types")._SERVICE>;
export {};
