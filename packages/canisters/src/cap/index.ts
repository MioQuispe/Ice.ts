import path from "node:path"
import { idlFactory as capBucketIdlFactory } from "./cap-bucket/cap-bucket.did.js"
import { idlFactory as capRootIdlFactory } from "./cap-root/cap-root.did.js"
import { idlFactory as capRouterIdlFactory } from "./cap-router/cap-router.did.js"
import { idlFactory as capRouterTestIdlFactory } from "./cap-router-test/cap-router-test.did.js"
import { canister, customCanister, type TaskCtx, scope } from "@ice.ts/runner"
import type { _SERVICE as CAP_ROUTER_SERVICE } from "./cap-router/types.js"
import type { _SERVICE as CAP_ROOT_SERVICE } from "./cap-root/types.js"
import type { _SERVICE as CAP_BUCKET_SERVICE } from "./cap-bucket/types.js"

export type {
  CAP_ROUTER_SERVICE,
  CAP_ROOT_SERVICE,
  CAP_BUCKET_SERVICE,
  CapRootInitArgs,
  CapRouterInitArgs,
  CapBucketInitArgs,
}

import { Principal } from "@dfinity/principal"
import * as url from "node:url"

const __dirname = url.fileURLToPath(new URL(".", import.meta.url))

type Networks = "local" | "ic" | "staging"

const CapBucketIds = {
  local: "r7inp-6aaaa-aaaaa-aaabq-cai",
  ic: "r7inp-6aaaa-aaaaa-aaabq-cai",
  staging: "r7inp-6aaaa-aaaaa-aaabq-cai",
}

export type CapBucketActor = import("@dfinity/agent").ActorSubclass<
  import("./cap-bucket/types")._SERVICE
>

type CapBucketInitArgs = {
  // offset: number
  // next_canisters: Array<number>
  // contract: Principal
  canisterId?: string
}

export const CapBucket = (
  initArgsOrFn?: CapBucketInitArgs | ((args: { ctx: TaskCtx }) => CapBucketInitArgs),
) => {
  // const {
  //   contract,  // Id   // Principal probably?
  //   offset = 0, // u64,
  //   next_canisters = [0], // Vec<BucketId>,
  // } = args
  return canister.custom<CAP_BUCKET_SERVICE, []>(({ ctx }) => {
    const initArgs =
      typeof initArgsOrFn === "function" ? initArgsOrFn({ ctx }) : initArgsOrFn
    return {
      candid: path.resolve(__dirname, "./cap/cap-bucket/cap-bucket.did"),
      wasm: path.resolve(__dirname, "./cap/cap-bucket/cap-bucket.wasm.gz"),
      canisterId: CapBucketIds[ctx.network as Networks],
    }
  }).installArgs(async ({ ctx }) => {
    return [
      // args: [{
      //   contract, // TokenContractId,
      //   offset, // u64
      //   next_canisters, // Vec<BucketId>
      // }],
    ]
  }).upgradeArgs(async ({ ctx }) => {
    return []
  })
}

CapBucket.id = CapBucketIds

CapBucket.idlFactory = capBucketIdlFactory

CapBucket.scripts = {}

///////////////////////

const CapRootIds = {
  local: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  ic: "rrkah-fqaaa-aaaaa-aaaaq-cai",
}

export type CapRootActor = import("@dfinity/agent").ActorSubclass<
  import("./cap-root/types")._SERVICE
>

type CapRootInitArgs = {
  // contract: Principal
  // writers: Array<Principal>
  canisterId?: string
}

export const CapRoot = (
  initArgsOrFn?: CapRootInitArgs | ((args: { ctx: TaskCtx }) => CapRootInitArgs),
) => {
  // const {
  //   contract,
  //   writers,
  // } = args
  return canister.custom<CAP_ROOT_SERVICE, []>(({ ctx }) => {
    const initArgs =
      typeof initArgsOrFn === "function" ? initArgsOrFn({ ctx }) : initArgsOrFn
    return {
      candid: path.resolve(__dirname, "./cap/cap-root/cap-root.did"),
      wasm: path.resolve(__dirname, "./cap/cap-root/cap-root.wasm.gz"),
      canisterId: initArgs?.canisterId ?? CapRootIds.local,
    }
  })
  // .installArgs(async ({ ctx, mode }) => {
  //   const initArgs =
  //     typeof initArgsOrFn === "function" ? initArgsOrFn(ctx) : initArgsOrFn
  //   return [
  //     // args: [
  //     //   contract, // Principal,
  //     //   writers, // BTreeSet<Principal>
  //     // ],
  //   ]
  // })
}

CapRoot.id = CapRootIds

CapRoot.idlFactory = capRootIdlFactory

CapRoot.scripts = {}

///////////////////////////////

const CapRouterIds = {
  local: "lj532-6iaaa-aaaah-qcc7a-cai",
  ic: "lj532-6iaaa-aaaah-qcc7a-cai",
}
export type CapRouterActor = import("@dfinity/agent").ActorSubclass<
  import("./cap-router/types")._SERVICE
>

type CapRouterInitArgs = {
  canisterId?: string
}

// Here we create the shape
const capRouter = canister.custom<CAP_ROUTER_SERVICE, []>(({ ctx }) => ({
  candid: path.resolve(__dirname, "./cap/cap-router/cap-router.did"),
  wasm: path.resolve(__dirname, "./cap/cap-router/cap-router.wasm.gz"),
  canisterId: CapRouterIds.local,
}))

export const CapRouter = (
  initArgsOrFn?: CapRouterInitArgs | ((args: { ctx: TaskCtx }) => CapRouterInitArgs),
) => {
  return capRouter
    .create(({ ctx }) => {
      const initArgs =
        typeof initArgsOrFn === "function" ? initArgsOrFn({ ctx }) : initArgsOrFn
      return {
        candid: path.resolve(__dirname, "./cap/cap-router/cap-router.did"),
        wasm: path.resolve(__dirname, "./cap/cap-router/cap-router.wasm.gz"),
        // subnetType: "application",
        canisterId: initArgs?.canisterId ?? CapRouterIds.local,
      }
    })
    // .installArgs(async ({ ctx, mode }) => {
    //   const initArgs =
    //     typeof initArgsOrFn === "function" ? initArgsOrFn(ctx) : initArgsOrFn
    //   return []
    // })
}


// export type CapRouterBuilder = ReturnType<typeof customCanister<[], CAP_ROUTER_SERVICE>>
// CapRouter.provides = capRouter.make().children.install


// CapRouter.id = CapRouterIds

// CapRouter.idlFactory = capRouterIdlFactory

// CapRouter.scripts = {}

//////////////////////////

// const CapRouterTestIds = {
//   local: "lhtux-ciaaa-aaaag-qakpa-cai",
//   ic: "lhtux-ciaaa-aaaag-qakpa-cai",
// }

// type CapRouterTestInitArgs = {}

// export const CapRouterTest = (args: CapRouterTestInitArgs): ExtendedCanisterConfiguration => {
//   return {
//     type: "custom",
//     candid: path.resolve(__dirname, "./cap/cap-router-test/cap-router-test.did"),
//     wasm: path.resolve(__dirname, "./cap/cap-router-test/cap-router-test.wasm.gz"),
//     build: "",
//     // remote: {
//     //   id: CapRouterTestIds,
//     // },
//     dfx_js: {
//       canister_id: CapRouterTestIds,
//       args: [],
//     },
//   }
// }

// CapRouterTest.id = CapRouterTestIds

// CapRouterTest.idlFactory = capRouterTestIdlFactory

// CapRouterTest.scripts = {}

// export type CapRouterTestActor = import("@dfinity/agent").ActorSubclass<import("./cap-router-test/types")._SERVICE>

export const Cap = scope({
  // bucket: CapBucket(),
  // root: CapRoot(),
  router: CapRouter().make(),
})
