import type { Principal } from '@icp-sdk/core/principal';
export type canister_id = Principal;
export interface canister_settings {
    'freezing_threshold': [] | [bigint];
    'controllers': [] | [Array<Principal>];
    'memory_allocation': [] | [bigint];
    'compute_allocation': [] | [bigint];
}
export interface change {
    'timestamp_nanos': bigint;
    'canister_version': bigint;
    'origin': change_origin;
    'details': change_details;
}
export type change_details = {
    'creation': {
        'controllers': Array<Principal>;
    };
} | {
    'code_deployment': {
        'mode': {
            'reinstall': null;
        } | {
            'upgrade': null;
        } | {
            'install': null;
        };
        'module_hash': Array<number>;
    };
} | {
    'controllers_change': {
        'controllers': Array<Principal>;
    };
} | {
    'code_uninstall': null;
};
export type change_origin = {
    'from_user': {
        'user_id': Principal;
    };
} | {
    'from_canister': {
        'canister_version': [] | [bigint];
        'canister_id': Principal;
    };
};
export interface definite_canister_settings {
    'freezing_threshold': bigint;
    'controllers': Array<Principal>;
    'memory_allocation': bigint;
    'compute_allocation': bigint;
}
export type ecdsa_curve = {
    'secp256k1': null;
};
export interface http_header {
    'value': string;
    'name': string;
}
export interface http_response {
    'status': bigint;
    'body': Array<number>;
    'headers': Array<http_header>;
}
export type wasm_module = Array<number>;
export interface _SERVICE {
    'canister_info': (arg_0: {
        'canister_id': canister_id;
        'num_requested_changes': [] | [bigint];
    }) => Promise<{
        'controllers': Array<Principal>;
        'module_hash': [] | [Array<number>];
        'recent_changes': Array<change>;
        'total_num_changes': bigint;
    }>;
    'canister_status': (arg_0: {
        'canister_id': canister_id;
    }) => Promise<{
        'status': {
            'stopped': null;
        } | {
            'stopping': null;
        } | {
            'running': null;
        };
        'memory_size': bigint;
        'cycles': bigint;
        'settings': definite_canister_settings;
        'idle_cycles_burned_per_day': bigint;
        'module_hash': [] | [Array<number>];
    }>;
    'create_canister': (arg_0: {
        'settings': [] | [canister_settings];
        'sender_canister_version': [] | [bigint];
    }) => Promise<{
        'canister_id': canister_id;
    }>;
    'delete_canister': (arg_0: {
        'canister_id': canister_id;
    }) => Promise<undefined>;
    'deposit_cycles': (arg_0: {
        'canister_id': canister_id;
    }) => Promise<undefined>;
    'ecdsa_public_key': (arg_0: {
        'key_id': {
            'name': string;
            'curve': ecdsa_curve;
        };
        'canister_id': [] | [canister_id];
        'derivation_path': Array<Array<number>>;
    }) => Promise<{
        'public_key': Array<number>;
        'chain_code': Array<number>;
    }>;
    'http_request': (arg_0: {
        'url': string;
        'method': {
            'get': null;
        } | {
            'head': null;
        } | {
            'post': null;
        };
        'max_response_bytes': [] | [bigint];
        'body': [] | [Array<number>];
        'transform': [] | [
            {
                'function': [Principal, string];
                'context': Array<number>;
            }
        ];
        'headers': Array<http_header>;
    }) => Promise<http_response>;
    'install_code': (arg_0: {
        'arg': Array<number>;
        'wasm_module': wasm_module;
        'mode': {
            'reinstall': null;
        } | {
            'upgrade': null;
        } | {
            'install': null;
        };
        'canister_id': canister_id;
        'sender_canister_version': [] | [bigint];
    }) => Promise<undefined>;
    'provisional_create_canister_with_cycles': (arg_0: {
        'settings': [] | [canister_settings];
        'specified_id': [] | [canister_id];
        'amount': [] | [bigint];
        'sender_canister_version': [] | [bigint];
    }) => Promise<{
        'canister_id': canister_id;
    }>;
    'provisional_top_up_canister': (arg_0: {
        'canister_id': canister_id;
        'amount': bigint;
    }) => Promise<undefined>;
    'raw_rand': () => Promise<Array<number>>;
    'sign_with_ecdsa': (arg_0: {
        'key_id': {
            'name': string;
            'curve': ecdsa_curve;
        };
        'derivation_path': Array<Array<number>>;
        'message_hash': Array<number>;
    }) => Promise<{
        'signature': Array<number>;
    }>;
    'start_canister': (arg_0: {
        'canister_id': canister_id;
    }) => Promise<undefined>;
    'stop_canister': (arg_0: {
        'canister_id': canister_id;
    }) => Promise<undefined>;
    'uninstall_code': (arg_0: {
        'canister_id': canister_id;
        'sender_canister_version': [] | [bigint];
    }) => Promise<undefined>;
    'update_settings': (arg_0: {
        'canister_id': Principal;
        'settings': canister_settings;
        'sender_canister_version': [] | [bigint];
    }) => Promise<undefined>;
}
