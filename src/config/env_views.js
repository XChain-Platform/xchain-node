/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Environment views
 *
 * Some reads cannot name their variable in the source: the name is built from a
 * module, coin or network (XCHAIN_NODE_MODULE_MEMORY_MB_<MODULE>), taken from a
 * list a container is handed through, or looked up in an env object a test can
 * replace. Those reads go through the views below. A view declares the variables
 * it answers for, as a list of names or as the prefix a family of names shares,
 * and reads the environment when the property is read, never when this file
 * loads. Asking a view for an environment-style name it does not declare throws,
 * so a name added at a read site but not here fails loudly instead of reading as
 * unset.
 *
 * This file never touches process.env itself. src/config/index.js binds the
 * views to it through bindEnvViews() and re-exports them, so the config home
 * stays the one file that reads the environment.
 ********************************************************************/

const ENV_STYLE_NAME = /^[A-Z][A-Z0-9_]*$/

// Views over a list of names: export name -> [label, declared names].
const LIST_VIEWS = {
    // The hub's host passthrough (ConfigService hubPassthroughVars), plus the
    // redaction-safe spelling of its one secret-bearing name, which
    // src/config/secret_env.js prefers when both are present.
    HUB_PASSTHROUGH_ENV: ['hub passthrough', [
        "HUB_API_KEY", "BTC_INDEXER_URL", "LTC_INDEXER_URL", "DOGE_INDEXER_URL",
        "BTC_INDEXER_API_KEY", "LTC_INDEXER_API_KEY", "DOGE_INDEXER_API_KEY",
        "CHECKPOINT_ENABLED", "CHECKPOINT_INTERVAL_BLOCKS", "CHECKPOINT_CONFIRMATIONS",
        "CHECKPOINT_POLL_MS", "CHECKPOINT_ROUND_TIMEOUT_MS", "CHECKPOINT_CHAINS",
        "ANCHOR_ENABLED", "ANCHOR_INTERVAL_MS", "ANCHOR_MATCH_BATCH_SIZE", "ANCHOR_MAX_BATCH",
        "ANCHOR_CHUNK_MAX_BYTES", "ANCHOR_ROUND_TIMEOUT_MS", "ANCHOR_CHUNK_RETRY_MS",
        "ANCHOR_ELECTION_TOLERANCE_BLOCKS", "ANCHOR_REWARD_PER_PUBLISH",
        "ANCHOR_CHECKPOINT_EVERY_N", "DOGE_ENCODER_URL", "DOGE_ENCODER_API_KEY", "DOGE_ADDRESS",
        "DOGE_PUBKEY_HEX", "DOGE_LOW_BALANCE_THRESHOLD", "XDEX_SEED_LOCAL_VALIDATOR",
        "XDEX_SNAPSHOT_BLOCK",
        "XCHAIN_CONFIRMATIONS_BTC", "XCHAIN_CONFIRMATIONS_LTC", "XCHAIN_CONFIRMATIONS_DOGE",
        "HUB_TRUST_PROXY", "HUB_NETWORK", "ORACLE_MIN_SUBMISSIONS",
        "ORACLE_ROUND_INTERVAL", "ORACLE_SUBMISSION_WINDOW", "ORACLE_BATCH_WINDOW_ROUNDS",
        "ORACLE_BATCH_GRACE_MS", "ORACLE_BATCH_SIGN_TIMEOUT_MS",
        "ORACLE_BATCH_BUFFER_MAX_ROUNDS", "ORACLE_BATCH_LANDING_RESERVE_MS",
        "ATTEST_RESPONSE_FORWARD_S_OVERRIDE", "ATTEST_BATCH_WINDOW_S_OVERRIDE",
        "HUB_RATE_LIMIT_RPM", "HUB_RATE_LIMIT_EXEMPT_LOCAL", "XCHAIN_PRICE_INDEXER_DB_HOST",
        "XCHAIN_PRICE_INDEXER_DB_PORT", "XCHAIN_PRICE_INDEXER_DB_NAME",
        "XCHAIN_PRICE_INDEXER_DB_USER", "XCHAIN_PRICE_INDEXER_DB_PASS",
        "XCHAIN_PRICE_INDEXER_DB_COIN", "XCHAIN_PRICE_WINDOW_BLOCKS",
        "XCHAIN_PRICE_CONFIRMATION_BUFFER", "XCHAIN_PRICE_BOOTSTRAP_SATS",
        "XCHAIN_PRICE_MIN_BTC_VOLUME", "HUB_ALLOW_UNAUTHENTICATED",
        "XC_ROLLCALL_REGTEST_ACTIVATION", "XC_ROLLCALL_GATES_REGTEST_ACTIVATION",
        "XC_MIRROR_ADMISSION_ACTIVATION",
        "XCHAIN_PRICE_INDEXER_DB_SECRET"
    ]],
    // The indexer's regtest genesis bootstrap (ConfigService genesisPassthroughVars).
    INDEXER_GENESIS_ENV: ['indexer genesis', [
        "XCHAIN_GENESIS_BLOCK", "XCHAIN_GENESIS_LEDGER_HASH", "XCHAIN_GENESIS_DUMP_HASH",
        "GENESIS_LEDGER_PATH", "GENESIS_DUMP_PATH", "GENESIS_BLOCK_TIMEOUT_MS",
        "GENESIS_DUMP_TIMEOUT_MS", "GENESIS_AIRDROP_PATHS", "GENESIS_AIRDROP_HASHES",
        "GENESIS_AIRDROP_AMOUNTS", "GENESIS_AIRDROP_SNAPSHOT_BLOCK", "GENESIS_AIRDROP_SET_HASH"
    ]],
    // The indexer's ROLLCALL rail (ConfigService rollcallPassthroughVars), the
    // regtest-only names included.
    INDEXER_ROLLCALL_ENV: ['indexer rollcall', [
        "DOGE_INDEXER_API_URL", "DOGE_INDEXER_API_KEY", "XC_ROLLCALL_REGTEST_ACTIVATION",
        "XC_ROLLCALL_GATES_REGTEST_ACTIVATION", "HUB_SYNC_ANCHOR_ATTEST_GRACE_S",
        "HUB_PRICE_SYNC_TIMEOUT_MS", "XCHAIN_COINPAY_EXPIRATION_S",
        "XC_MIRROR_ADMISSION_ACTIVATION"
    ]],
    // The hub-sync watermark graces a regtest indexer is handed (hubSyncRegtestGraceVars).
    HUB_SYNC_GRACE_ENV: ['hub sync grace', [
        "HUB_SYNC_PRICE_GRACE_S", "HUB_SYNC_ORACLE_GRACE_S", "HUB_SYNC_ATTEST_RESPONSE_GRACE_S",
        "HUB_SYNC_MATCH_GRACE_S", "HUB_SYNC_CALL_GRACE_S", "HUB_SYNC_ANCHOR_ATTEST_GRACE_S",
        "HUB_SYNC_BRIDGE_GRACE_S", "HUB_SYNC_POLICY_GRACE_S"
    ]],
    // The explorer's published host ports.
    EXPLORER_PORT_ENV: ['explorer port', ["EXPLORER_PORT_HTTP", "EXPLORER_PORT_HTTPS", "EXPLORER_PORT"]],
    // The mysqld tuning flags DatabaseService passes to the bundled MariaDB.
    DB_TUNING_ENV: ['database tuning', [
        "XCHAIN_NODE_DB_BUFFER_POOL_SIZE", "XCHAIN_NODE_DB_MAX_CONNECTIONS", "XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT"
    ]],
    // The autoheal loop's timing overrides.
    AUTOHEAL_TIMING_ENV: ['autoheal timing', [
        "XCHAIN_NODE_AUTOHEAL_GRACE_MS", "XCHAIN_NODE_AUTOHEAL_COOLDOWN_MS",
        "XCHAIN_NODE_AUTOHEAL_COOLDOWN_CEILING_MS", "XCHAIN_NODE_AUTOHEAL_PROBATION_MS"
    ]],
    // The WIFs `validator init` imports instead of generating a wallet.
    IMPORTED_WIF_ENV: ['imported wallet key', ["XCHAIN_NODE_STAKE_WIF", "XCHAIN_NODE_DOGE_WIF"]],
    // Operator escape hatches and markers, each read by the one service that owns it.
    SKEW_GUARD_ENV: ['skew guard', ["XCHAIN_NODE_SKIP_SKEW_GUARD"]],
    DB_CREDENTIAL_DRIFT_ENV: ['database credential drift', ["XCHAIN_NODE_ALLOW_DB_CREDENTIAL_DRIFT"]],
    HUB_CONSENSUS_DRIFT_ENV: ['hub consensus drift', ["XCHAIN_NODE_ALLOW_HUB_CONSENSUS_ENV_DRIFT"]],
    CHECKPOINT_SELF_SYNC_ENV: ['checkpoint self-sync', ["EXPLORER_CHECKPOINT_SELF_SYNC"]],
    SELF_UPDATE_ENV: ['self-update', ["XCHAIN_NODE_UPDATE_TARGET", "XCHAIN_NODE_NO_SELF_UPDATE"]],
    // The service keys the go-live gate falls back to the host for, and the signed
    // bootstrap switch it refuses to see disabled.
    GO_LIVE_HOST_ENV: ['go-live host', [
        "INDEXER_API_KEY", "HUB_API_KEY", "API_KEY", "ENCODER_API_KEY", "SYNC_API_KEY", "XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP"
    ]],
    // The observability names a service container inherits from the host (ModuleService OBSERVABILITY_ENV_KEYS).
    OBSERVABILITY_ENV: ['observability', ["LOG_LEVEL", "LOG_FORMAT", "METRICS_ENABLED", "XCHAIN_LOG_PATCH"]]
}

// Views over a family of names that carries a coin, network or module:
// export name -> [label, shared prefix].
const FAMILY_VIEWS = {
    FEE_DESTINATION_ENV:     ['fee destination', 'XCHAIN_FEE_DESTINATION_'],
    INDEXER_API_URL_ENV:     ['indexer API URL', 'INDEXER_API_URL_'],
    HEALTH_START_PERIOD_ENV: ['health start period', 'XCHAIN_NODE_HEALTH_START_PERIOD_'],
    NODE_VERSION_PIN_ENV:    ['node version pin', 'XCHAIN_NODE_NODE_VERSION_'],
    MODULE_MEMORY_ENV:       ['module memory', 'XCHAIN_NODE_MODULE_MEMORY_MB_'],
    MODULE_STOP_TIMEOUT_ENV: ['module stop timeout', 'XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_']
}

// One view: a frozen object whose every property read asks `answersFor` whether
// the name is declared and, when it is, returns `read(name)` at that moment.
// Symbols and names that do not look like environment variables read undefined,
// so inspection and iteration never throw.
function envView(label, answersFor, read) {
    return new Proxy(Object.freeze({}), {
        get(target, key) {
            if (typeof key !== 'string') return undefined
            if (answersFor(key)) return read(key)
            if (ENV_STYLE_NAME.test(key)) {
                throw new Error(key + " is not declared in the " + label + " environment view in src/config/env_views.js")
            }
            return undefined
        }
    })
}

/**
 * Every view, bound to the environment the config home hands over.
 *
 * @param {{read: function(string): (string|undefined), copy: function(): object}} env
 *   `read` answers one variable at call time; `copy` returns a fresh copy of the
 *   whole environment.
 * @returns {object} each view under its export name, plus childProcessEnv()
 */
function bindEnvViews({ read, copy }) {
    const views = {}
    for (const [name, [label, names]] of Object.entries(LIST_VIEWS)) {
        const declared = new Set(names)
        views[name] = envView(label, (key) => declared.has(key), read)
    }
    for (const [name, [label, prefix]] of Object.entries(FAMILY_VIEWS)) {
        views[name] = envView(label, (key) => key.startsWith(prefix), read)
    }
    // The environment a spawned child process starts from: a fresh copy taken at
    // the call. A child inherits PATH, HOME, DOCKER_HOST and the rest by design and
    // no variable is read out of it here, which is why it is the whole environment
    // rather than a view.
    views.childProcessEnv = function childProcessEnv() {
        return copy()
    }
    return views
}

module.exports = { bindEnvViews }
