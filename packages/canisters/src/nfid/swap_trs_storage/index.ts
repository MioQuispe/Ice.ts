import { canister, Opt } from "@ice.ts/runner"
import * as url from "node:url"
import path from "node:path"
import type { TaskCtx } from "@ice.ts/runner"
import type { _SERVICE } from "./swap_trs_storage.types.js"
import { Principal } from "@dfinity/principal"
import { NFIDIdentityManager } from "../identity_manager/index.js"
const __dirname = url.fileURLToPath(new URL(".", import.meta.url))
const canisterName = "swap_trs_storage"

// const InitArgs = IDL.Record({ 'im_canister' : IDL.Principal });
// return [IDL.Opt(InitArgs)];
type InitArgs = {
  im_canister: Principal
}
/**
 * Creates an instance of the SwapTrsStorage canister.
 * @param initArgsOrFn Initialization arguments or a function returning them.
 * @returns A canister instance.
 */
export const NFIDSwapTrsStorage = (
  initArgsOrFn?:
    | { canisterId?: string }
    | ((args: { ctx: TaskCtx }) => { canisterId?: string }),
) =>
  canister.custom<_SERVICE, [Opt<InitArgs>]>(({ ctx }) => {
    const initArgs =
      typeof initArgsOrFn === "function" ? initArgsOrFn({ ctx }) : initArgsOrFn
    return {
      canisterId: initArgs?.canisterId,
      wasm: path.resolve(__dirname, `./nfid/${canisterName}/${canisterName}.wasm.gz`),
      candid: path.resolve(__dirname, `./nfid/${canisterName}/${canisterName}.did`),
    }
  })
    .dependsOn({ NFIDIdentityManager: NFIDIdentityManager.provides })
    .installArgs(async ({ ctx, deps }) => {
      // TODO: Add installation logic if needed.
      const initArgs =
        typeof initArgsOrFn === "function" ? initArgsOrFn({ ctx }) : initArgsOrFn
      return [
        Opt<InitArgs>({
          im_canister: Principal.fromText(
            deps.NFIDIdentityManager.canisterId,
          ),
        }),
      ]
    })
