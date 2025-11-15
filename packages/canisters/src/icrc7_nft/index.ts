import path from "node:path"
import type { TaskCtx } from "@ice.ts/runner"
import { canister, Opt } from "@ice.ts/runner"
import type {
  _SERVICE,
  InitArgList,
  InitArgList__1,
  InitArgs,
  InitArgs__1,
} from "./icrc7_nft.types"
// import type { _SERVICE } from "./icrc7_nft.did.js"
import * as url from "node:url"

export type {
  _SERVICE as ICRC7NFTService,
  InitArgList as ICRC7NFTInitArgList,
  InitArgList__1 as ICRC7NFTInitArgList__1,
  InitArgs as ICRC7NFTInitArgs,
  InitArgs__1 as ICRC7NFTInitArgs__1,
}

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))
const canisterName = "icrc7_nft"

type ICRC7NFTInitArgs = {
  icrc3_args: InitArgs
  icrc37_args: [] | [InitArgList]
  icrc7_args: [] | [InitArgList__1]
}

type WrapperInitArgs = {
  canisterId?: string
}

// TODO: implement this
export const ICRC7NFT = (
  initArgsOrFn?: WrapperInitArgs | ((args: { ctx: TaskCtx }) => WrapperInitArgs),
) => {
  return canister.custom<_SERVICE, [ICRC7NFTInitArgs], [ICRC7NFTInitArgs]>(({ ctx }) => {
    const initArgs =
      typeof initArgsOrFn === "function" ? initArgsOrFn({ ctx }) : initArgsOrFn
    return {
      canisterId: initArgs?.canisterId,
      wasm: path.resolve(__dirname, `./${canisterName}/${canisterName}.wasm.gz`),
      candid: path.resolve(__dirname, `./${canisterName}/${canisterName}.did`),
    }
  }).installArgs(async ({ ctx }) => {
    const initArgs =
      typeof initArgsOrFn === "function" ? initArgsOrFn({ ctx }) : initArgsOrFn
    //   return [
    //     IDL.Record({
    //       'icrc3_args' : InitArgs,
    //       'icrc37_args' : IDL.Opt(InitArgList),
    //       'icrc7_args' : IDL.Opt(InitArgList__1),
    //     }),
    //   ];
    return [
      {
        icrc3_args: [
          {
            maxRecordsToArchive: 0n,
            archiveIndexType: {
              Stable: null,
            },
            maxArchivePages: 0n,
            settleToRecords: 0n,
            archiveCycles: 0n,
            maxActiveRecords: 0n,
            maxRecordsInArchiveInstance: 0n,
            archiveControllers: [
              // Array<Principal>
              // []
            ],
            supportedBlocks: [],
          } satisfies InitArgs__1,
        ],
        icrc37_args: [
          //     {
          //     'deployer' : ctx.users.default.principal,
          //     'max_approvals' : [0n],
          //     'max_approvals_per_token_or_collection' : [0n],
          //     'settle_to_approvals' : [0n],
          //     'max_revoke_approvals' : [0n],
          //     'collection_approval_requires_token' : [false],
          // }
        ],
        icrc7_args: [
        //   {
        //     deployer: ctx.users.default.principal,
        //     max_approvals: [0n],
        //     max_approvals_per_token_or_collection: [0n],
        //   },
        ],
      },
    ]
  }).upgradeArgs(async ({ ctx }) => {
    // Standard doesnt separate init and upgrade args
    return [
      {
        icrc3_args: [
          {
            maxRecordsToArchive: 0n,
            archiveIndexType: {
              Stable: null,
            },
            maxArchivePages: 0n,
            settleToRecords: 0n,
            archiveCycles: 0n,
            maxActiveRecords: 0n,
            maxRecordsInArchiveInstance: 0n,
            archiveControllers: [
              // Array<Principal>
              // []
            ],
            supportedBlocks: [],
          } satisfies InitArgs__1,
        ],
        icrc37_args: [
          //     {
          //     'deployer' : ctx.users.default.principal,
          //     'max_approvals' : [0n],
          //     'max_approvals_per_token_or_collection' : [0n],
          //     'settle_to_approvals' : [0n],
          //     'max_revoke_approvals' : [0n],
          //     'collection_approval_requires_token' : [false],
          // }
        ],
        icrc7_args: [
        //   {
        //     deployer: ctx.users.default.principal,
        //     max_approvals: [0n],
        //     max_approvals_per_token_or_collection: [0n],
        //   },
        ],
      },
    ]
  })
}

// cond([])
// 	.when([], a)
// 	// .when((a) => a)