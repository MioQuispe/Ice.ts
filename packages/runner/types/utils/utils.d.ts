import { Principal } from "@icp-sdk/core/principal";
export declare const calculateCrc32: (bytes: Uint8Array) => Uint8Array;
export declare const asciiStringToByteArray: (text: string) => Array<number>;
export declare function toHexString(bytes: ArrayBuffer): string;
export declare const principalToAccountId: (principal: Principal | string, subAccount?: Uint8Array) => string;
