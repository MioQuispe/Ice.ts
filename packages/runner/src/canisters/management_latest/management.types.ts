import type { Principal } from "@icp-sdk/core/principal";
export type bitcoin_address = string;
export type bitcoin_block_hash = Array<number>;
export type bitcoin_block_header = Array<number>;
export type bitcoin_block_height = number;
export interface bitcoin_get_balance_args {
  'network' : bitcoin_network,
  'address' : bitcoin_address,
  'min_confirmations' : [] | [number],
}
export type bitcoin_get_balance_result = satoshi;
export interface bitcoin_get_block_headers_args {
  'start_height' : bitcoin_block_height,
  'end_height' : [] | [bitcoin_block_height],
  'network' : bitcoin_network,
}
export interface bitcoin_get_block_headers_result {
  'tip_height' : bitcoin_block_height,
  'block_headers' : Array<bitcoin_block_header>,
}
export interface bitcoin_get_current_fee_percentiles_args {
  'network' : bitcoin_network,
}
export type bitcoin_get_current_fee_percentiles_result = Array<
  millisatoshi_per_byte
>;
export interface bitcoin_get_utxos_args {
  'network' : bitcoin_network,
  'filter' : [] | [
    { 'page' : Array<number> } |
      { 'min_confirmations' : number }
  ],
  'address' : bitcoin_address,
}
export interface bitcoin_get_utxos_result {
  'next_page' : [] | [Array<number>],
  'tip_height' : bitcoin_block_height,
  'tip_block_hash' : bitcoin_block_hash,
  'utxos' : Array<utxo>,
}
export type bitcoin_network = { 'mainnet' : null } |
  { 'regtest' : null } |
  { 'testnet' : null };
export interface bitcoin_send_transaction_args {
  'transaction' : Array<number>,
  'network' : bitcoin_network,
}
export type canister_id = Principal;
export interface canister_info_args {
  'canister_id' : canister_id,
  'num_requested_changes' : [] | [bigint],
}
export interface canister_info_result {
  'controllers' : Array<Principal>,
  'module_hash' : [] | [Array<number>],
  'recent_changes' : Array<change>,
  'total_num_changes' : bigint,
}
export type canister_install_mode = { 'reinstall' : null } |
  {
    'upgrade' : [] | [
      {
        'wasm_memory_persistence' : [] | [
          { 'keep' : null } |
            { 'replace' : null }
        ],
        'skip_pre_upgrade' : [] | [boolean],
      }
    ]
  } |
  { 'install' : null };
export interface canister_log_record {
  'idx' : bigint,
  'timestamp_nanos' : bigint,
  'content' : Array<number>,
}
export interface canister_settings {
  'freezing_threshold' : [] | [bigint],
  'controllers' : [] | [Array<Principal>],
  'reserved_cycles_limit' : [] | [bigint],
  'log_visibility' : [] | [log_visibility],
  'wasm_memory_limit' : [] | [bigint],
  'memory_allocation' : [] | [bigint],
  'compute_allocation' : [] | [bigint],
}
export interface canister_status_args { 'canister_id' : canister_id }
export interface canister_status_result {
  'status' : { 'stopped' : null } |
    { 'stopping' : null } |
    { 'running' : null },
  'memory_size' : bigint,
  'cycles' : bigint,
  'settings' : definite_canister_settings,
  'query_stats' : {
    'response_payload_bytes_total' : bigint,
    'num_instructions_total' : bigint,
    'num_calls_total' : bigint,
    'request_payload_bytes_total' : bigint,
  },
  'idle_cycles_burned_per_day' : bigint,
  'module_hash' : [] | [Array<number>],
  'reserved_cycles' : bigint,
}
export interface change {
  'timestamp_nanos' : bigint,
  'canister_version' : bigint,
  'origin' : change_origin,
  'details' : change_details,
}
export type change_details = {
    'creation' : { 'controllers' : Array<Principal> }
  } |
  {
    'code_deployment' : {
      'mode' : { 'reinstall' : null } |
        { 'upgrade' : null } |
        { 'install' : null },
      'module_hash' : Array<number>,
    }
  } |
  {
    'load_snapshot' : {
      'canister_version' : bigint,
      'taken_at_timestamp' : bigint,
      'snapshot_id' : snapshot_id,
    }
  } |
  { 'controllers_change' : { 'controllers' : Array<Principal> } } |
  { 'code_uninstall' : null };
export type change_origin = { 'from_user' : { 'user_id' : Principal } } |
  {
    'from_canister' : {
      'canister_version' : [] | [bigint],
      'canister_id' : Principal,
    }
  };
export interface chunk_hash { 'hash' : Array<number> }
export interface clear_chunk_store_args { 'canister_id' : canister_id }
export interface create_canister_args {
  'settings' : [] | [canister_settings],
  'sender_canister_version' : [] | [bigint],
}
export interface create_canister_result { 'canister_id' : canister_id }
export interface definite_canister_settings {
  'freezing_threshold' : bigint,
  'controllers' : Array<Principal>,
  'reserved_cycles_limit' : bigint,
  'log_visibility' : log_visibility,
  'wasm_memory_limit' : bigint,
  'memory_allocation' : bigint,
  'compute_allocation' : bigint,
}
export interface delete_canister_args { 'canister_id' : canister_id }
export interface delete_canister_snapshot_args {
  'canister_id' : canister_id,
  'snapshot_id' : snapshot_id,
}
export interface deposit_cycles_args { 'canister_id' : canister_id }
export type ecdsa_curve = { 'secp256k1' : null };
export interface ecdsa_public_key_args {
  'key_id' : { 'name' : string, 'curve' : ecdsa_curve },
  'canister_id' : [] | [canister_id],
  'derivation_path' : Array<Array<number>>,
}
export interface ecdsa_public_key_result {
  'public_key' : Array<number>,
  'chain_code' : Array<number>,
}
export interface fetch_canister_logs_args { 'canister_id' : canister_id }
export interface fetch_canister_logs_result {
  'canister_log_records' : Array<canister_log_record>,
}
export interface http_header { 'value' : string, 'name' : string }
export interface http_request_args {
  'url' : string,
  'method' : { 'get' : null } |
    { 'head' : null } |
    { 'post' : null },
  'max_response_bytes' : [] | [bigint],
  'body' : [] | [Array<number>],
  'transform' : [] | [http_transform],
  'headers' : Array<http_header>,
}
export interface http_request_result {
  'status' : bigint,
  'body' : Array<number>,
  'headers' : Array<http_header>,
}
export interface http_transform {
  'function' : [Principal, string],
  'context' : Array<number>,
}
export interface http_transform_args {
  'context' : Array<number>,
  'response' : http_request_result,
}
export interface install_chunked_code_args {
  'arg' : Array<number>,
  'wasm_module_hash' : Array<number>,
  'mode' : canister_install_mode,
  'chunk_hashes_list' : Array<chunk_hash>,
  'target_canister' : canister_id,
  'store_canister' : [] | [canister_id],
  'sender_canister_version' : [] | [bigint],
}
export interface install_code_args {
  'arg' : Array<number>,
  'wasm_module' : wasm_module,
  'mode' : canister_install_mode,
  'canister_id' : canister_id,
  'sender_canister_version' : [] | [bigint],
}
export interface list_canister_snapshots_args { 'canister_id' : canister_id }
export type list_canister_snapshots_result = Array<snapshot>;
export interface load_canister_snapshot_args {
  'canister_id' : canister_id,
  'sender_canister_version' : [] | [bigint],
  'snapshot_id' : snapshot_id,
}
export type log_visibility = { 'controllers' : null } |
  { 'public' : null } |
  { 'allowed_viewers' : Array<Principal> };
export type millisatoshi_per_byte = bigint;
export interface node_metrics {
  'num_block_failures_total' : bigint,
  'node_id' : Principal,
  'num_blocks_proposed_total' : bigint,
}
export interface node_metrics_history_args {
  'start_at_timestamp_nanos' : bigint,
  'subnet_id' : Principal,
}
export type node_metrics_history_result = Array<
  { 'timestamp_nanos' : bigint, 'node_metrics' : Array<node_metrics> }
>;
export interface outpoint { 'txid' : Array<number>, 'vout' : number }
export interface provisional_create_canister_with_cycles_args {
  'settings' : [] | [canister_settings],
  'specified_id' : [] | [canister_id],
  'amount' : [] | [bigint],
  'sender_canister_version' : [] | [bigint],
}
export interface provisional_create_canister_with_cycles_result {
  'canister_id' : canister_id,
}
export interface provisional_top_up_canister_args {
  'canister_id' : canister_id,
  'amount' : bigint,
}
export type raw_rand_result = Array<number>;
export type satoshi = bigint;
export type schnorr_algorithm = { 'ed25519' : null } |
  { 'bip340secp256k1' : null };
export interface schnorr_public_key_args {
  'key_id' : { 'algorithm' : schnorr_algorithm, 'name' : string },
  'canister_id' : [] | [canister_id],
  'derivation_path' : Array<Array<number>>,
}
export interface schnorr_public_key_result {
  'public_key' : Array<number>,
  'chain_code' : Array<number>,
}
export interface sign_with_ecdsa_args {
  'key_id' : { 'name' : string, 'curve' : ecdsa_curve },
  'derivation_path' : Array<Array<number>>,
  'message_hash' : Array<number>,
}
export interface sign_with_ecdsa_result { 'signature' : Array<number> }
export interface sign_with_schnorr_args {
  'key_id' : { 'algorithm' : schnorr_algorithm, 'name' : string },
  'derivation_path' : Array<Array<number>>,
  'message' : Array<number>,
}
export interface sign_with_schnorr_result { 'signature' : Array<number> }
export interface snapshot {
  'id' : snapshot_id,
  'total_size' : bigint,
  'taken_at_timestamp' : bigint,
}
export type snapshot_id = Array<number>;
export interface start_canister_args { 'canister_id' : canister_id }
export interface stop_canister_args { 'canister_id' : canister_id }
export interface stored_chunks_args { 'canister_id' : canister_id }
export type stored_chunks_result = Array<chunk_hash>;
export interface subnet_info_args { 'subnet_id' : Principal }
export interface subnet_info_result { 'replica_version' : string }
export interface take_canister_snapshot_args {
  'replace_snapshot' : [] | [snapshot_id],
  'canister_id' : canister_id,
}
export type take_canister_snapshot_result = snapshot;
export interface uninstall_code_args {
  'canister_id' : canister_id,
  'sender_canister_version' : [] | [bigint],
}
export interface update_settings_args {
  'canister_id' : Principal,
  'settings' : canister_settings,
  'sender_canister_version' : [] | [bigint],
}
export interface upload_chunk_args {
  'chunk' : Array<number>,
  'canister_id' : Principal,
}
export type upload_chunk_result = chunk_hash;
export interface utxo {
  'height' : number,
  'value' : satoshi,
  'outpoint' : outpoint,
}
export type wasm_module = Array<number>;
export interface _SERVICE {
  'bitcoin_get_balance' : (arg_0: bitcoin_get_balance_args) => Promise<
      bitcoin_get_balance_result
    >,
  'bitcoin_get_block_headers' : (
      arg_0: bitcoin_get_block_headers_args,
    ) => Promise<bitcoin_get_block_headers_result>,
  'bitcoin_get_current_fee_percentiles' : (
      arg_0: bitcoin_get_current_fee_percentiles_args,
    ) => Promise<bitcoin_get_current_fee_percentiles_result>,
  'bitcoin_get_utxos' : (arg_0: bitcoin_get_utxos_args) => Promise<
      bitcoin_get_utxos_result
    >,
  'bitcoin_send_transaction' : (
      arg_0: bitcoin_send_transaction_args,
    ) => Promise<undefined>,
  'canister_info' : (arg_0: canister_info_args) => Promise<
      canister_info_result
    >,
  'canister_status' : (arg_0: canister_status_args) => Promise<
      canister_status_result
    >,
  'clear_chunk_store' : (arg_0: clear_chunk_store_args) => Promise<undefined>,
  'create_canister' : (arg_0: create_canister_args) => Promise<
      create_canister_result
    >,
  'delete_canister' : (arg_0: delete_canister_args) => Promise<undefined>,
  'delete_canister_snapshot' : (
      arg_0: delete_canister_snapshot_args,
    ) => Promise<undefined>,
  'deposit_cycles' : (arg_0: deposit_cycles_args) => Promise<undefined>,
  'ecdsa_public_key' : (arg_0: ecdsa_public_key_args) => Promise<
      ecdsa_public_key_result
    >,
  'fetch_canister_logs' : (arg_0: fetch_canister_logs_args) => Promise<
      fetch_canister_logs_result
    >,
  'http_request' : (arg_0: http_request_args) => Promise<http_request_result>,
  'install_chunked_code' : (arg_0: install_chunked_code_args) => Promise<
      undefined
    >,
  'install_code' : (arg_0: install_code_args) => Promise<undefined>,
  'list_canister_snapshots' : (arg_0: list_canister_snapshots_args) => Promise<
      list_canister_snapshots_result
    >,
  'load_canister_snapshot' : (arg_0: load_canister_snapshot_args) => Promise<
      undefined
    >,
  'node_metrics_history' : (arg_0: node_metrics_history_args) => Promise<
      node_metrics_history_result
    >,
  'provisional_create_canister_with_cycles' : (
      arg_0: provisional_create_canister_with_cycles_args,
    ) => Promise<provisional_create_canister_with_cycles_result>,
  'provisional_top_up_canister' : (
      arg_0: provisional_top_up_canister_args,
    ) => Promise<undefined>,
  'raw_rand' : () => Promise<raw_rand_result>,
  'schnorr_public_key' : (arg_0: schnorr_public_key_args) => Promise<
      schnorr_public_key_result
    >,
  'sign_with_ecdsa' : (arg_0: sign_with_ecdsa_args) => Promise<
      sign_with_ecdsa_result
    >,
  'sign_with_schnorr' : (arg_0: sign_with_schnorr_args) => Promise<
      sign_with_schnorr_result
    >,
  'start_canister' : (arg_0: start_canister_args) => Promise<undefined>,
  'stop_canister' : (arg_0: stop_canister_args) => Promise<undefined>,
  'stored_chunks' : (arg_0: stored_chunks_args) => Promise<
      stored_chunks_result
    >,
  'subnet_info' : (arg_0: subnet_info_args) => Promise<subnet_info_result>,
  'take_canister_snapshot' : (arg_0: take_canister_snapshot_args) => Promise<
      take_canister_snapshot_result
    >,
  'uninstall_code' : (arg_0: uninstall_code_args) => Promise<undefined>,
  'update_settings' : (arg_0: update_settings_args) => Promise<undefined>,
  'upload_chunk' : (arg_0: upload_chunk_args) => Promise<upload_chunk_result>,
}
