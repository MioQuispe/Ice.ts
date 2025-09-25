import { IDL } from '@icp-sdk/core/candid';
import { Principal } from '@icp-sdk/core/principal';

export function decodeCandid<T>(
    types: IDL.Type[],
    data: ArrayBufferLike,
  ): T | null {
    // @ts-ignore
    const returnValues = IDL.decode(types, data);
  
    switch (returnValues.length) {
      case 0:
        return null;
      case 1:
        return returnValues[0] as T;
      default:
        return returnValues as T;
    }
  }

export function isNil(value: unknown): value is null | undefined {
    return value === null || value === undefined;
  }
  
  export function isNotNil<T>(value: T | null | undefined): value is T {
    return value !== null && value !== undefined;
  }

export const MANAGEMENT_CANISTER_ID = Principal.fromText('aaaaa-aa');

export interface CanisterSettings {
  controllers: [] | [Principal[]];
  compute_allocation: [] | [bigint];
  memory_allocation: [] | [bigint];
  freezing_threshold: [] | [bigint];
  reserved_cycles_limit: [] | [bigint];
}

export const CanisterSettings = IDL.Record({
  controllers: IDL.Opt(IDL.Vec(IDL.Principal)),
  compute_allocation: IDL.Opt(IDL.Nat),
  memory_allocation: IDL.Opt(IDL.Nat),
  freezing_threshold: IDL.Opt(IDL.Nat),
  reserved_cycles_limit: IDL.Opt(IDL.Nat),
});

export interface CreateCanisterRequest {
  settings: [] | [CanisterSettings];
  amount: [] | [bigint];
  specified_id: [] | [Principal];
}

const CreateCanisterRequest = IDL.Record({
  settings: IDL.Opt(CanisterSettings),
  amount: IDL.Opt(IDL.Nat),
  specified_id: IDL.Opt(IDL.Principal),
});

export function encodeCreateCanisterRequest(
  arg: CreateCanisterRequest,
): Uint8Array {
  return new Uint8Array(IDL.encode([CreateCanisterRequest], [arg]));
}

const CreateCanisterResponse = IDL.Record({
  canister_id: IDL.Principal,
});

export interface CreateCanisterResponse {
  canister_id: Principal;
}

export function decodeCreateCanisterResponse(
  arg: Uint8Array,
): CreateCanisterResponse {
  const payload = decodeCandid<CreateCanisterResponse>(
    [CreateCanisterResponse],
    // @ts-ignore
    arg,
  );

  if (isNil(payload)) {
    throw new Error('Failed to decode CreateCanisterResponse');
  }

  return payload;
}

const StartCanisterRequest = IDL.Record({
  canister_id: IDL.Principal,
});

export interface StartCanisterRequest {
  canister_id: Principal;
}

export function encodeStartCanisterRequest(
  arg: StartCanisterRequest,
): Uint8Array {
  return new Uint8Array(IDL.encode([StartCanisterRequest], [arg]));
}

const StopCanisterRequest = IDL.Record({
  canister_id: IDL.Principal,
});

export interface StopCanisterRequest {
  canister_id: Principal;
}

export function encodeStopCanisterRequest(
  arg: StopCanisterRequest,
): Uint8Array {
  return new Uint8Array(IDL.encode([StopCanisterRequest], [arg]));
}

const InstallCodeRequest = IDL.Record({
  arg: IDL.Vec(IDL.Nat8),
  wasm_module: IDL.Vec(IDL.Nat8),
  mode: IDL.Variant({
    reinstall: IDL.Null,
    upgrade: IDL.Null,
    install: IDL.Null,
  }),
  canister_id: IDL.Principal,
});

export interface InstallCodeRequest {
  arg: Uint8Array;
  wasm_module: Uint8Array;
  mode: { reinstall?: null; upgrade?: null; install?: null };
  canister_id: Principal;
}

export interface ChunkHash {
  hash: Uint8Array;
}
// { 'hash' : Array<number> }

export interface InstallCodeChunkedRequest {
  arg: Uint8Array;
  wasm_module_hash: Uint8Array;
  chunk_hashes_list: ChunkHash[];
  mode: { reinstall?: null; upgrade?: null; install?: null };
  target_canister: Principal;
  store_canister: [] | [Principal];
  sender_canister_version: [] | [bigint]
  canister_id: Principal;

  // 'arg' : Array<number>,
  // 'wasm_module_hash' : Array<number>,
  // 'mode' : canister_install_mode,
  // 'chunk_hashes_list' : Array<chunk_hash>,
  // 'target_canister' : canister_id,
  // 'store_canister' : [] | [canister_id],
  // 'sender_canister_version' : [] | [bigint],
}

const ChunkHash = IDL.Record({
  hash: IDL.Vec(IDL.Nat8),
});

const InstallCodeChunkedRequest = IDL.Record({
  arg: IDL.Vec(IDL.Nat8),
  wasm_module_hash: IDL.Vec(IDL.Nat8),
  chunk_hashes_list: IDL.Vec(ChunkHash),
  mode: IDL.Variant({
    reinstall: IDL.Null,
    upgrade: IDL.Null,
    install: IDL.Null,
  }),
  target_canister: IDL.Principal,
  store_canister: IDL.Opt(IDL.Principal),
  sender_canister_version: IDL.Opt(IDL.Nat),
  canister_id: IDL.Principal,
});

export function encodeInstallCodeRequest(arg: InstallCodeRequest): Uint8Array {
  return new Uint8Array(IDL.encode([InstallCodeRequest], [arg]));
}

export function encodeInstallCodeChunkedRequest(arg: InstallCodeChunkedRequest): Uint8Array {
  return new Uint8Array(IDL.encode([InstallCodeChunkedRequest], [arg]));
}

const UpdateCanisterSettingsRequest = IDL.Record({
  canister_id: IDL.Principal,
  settings: CanisterSettings,
});

export interface UpdateCanisterSettingsRequest {
  canister_id: Principal;
  settings: CanisterSettings;
}

export function encodeUpdateCanisterSettingsRequest(
  arg: UpdateCanisterSettingsRequest,
): Uint8Array {
  return new Uint8Array(IDL.encode([UpdateCanisterSettingsRequest], [arg]));
}