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
 * XChain Node - Constants & Configuration
 ********************************************************************/

const path = require('path')

const DEFAULT_NODE_PREFIX    = "xchain-node"
const rawPrefix              = process.env.NODE_PREFIX || DEFAULT_NODE_PREFIX
if (!/^[a-z0-9][a-z0-9._-]*$/.test(rawPrefix)) {
    throw new Error(`Invalid NODE_PREFIX: "${rawPrefix}" (must be lowercase alphanumeric with hyphens, dots, or underscores)`)
}
const NODE_PREFIX            = rawPrefix
const {
    NODE_MODULE_NAME,
    DB_MODULE_NAME,
    HUB_MODULE_NAME,
    EXPLORER_MODULE_NAME,
    SYNC_MODULE_NAME,
    NODE_VERSION_FILE_NAME,
    SEP,
    DB_SEP,
    HUB_PORT,
    XChainService,
    REGTEST_MODULES,
    Network,
    projectFolders
} = require('./module_names.js')

// Docker healthcheck grace for a container whose probe judges a HARD DEPENDENCY's
// startup, not its own boot. Both such steps are 60s: MariaDB's server init and
// the utxo-tracker's first sync. Such a probe must be granted a window at least
// as long as the step it judges, or it reports that startup as a failure, so
// every dependent window derives from this one name and follows when it is raised.
const DEPENDENCY_HEALTH_START_PERIOD = '60s'

// External (host-native) MariaDB mode. When XCHAIN_NODE_EXTERNAL_DB=1, the
// CLI skips provisioning its own dockerized MariaDB and instead expects a
// reachable MariaDB at the configured host/port. All managed services
// (hub, decoder, indexer) get pointed at that host via env-var injection
// in ConfigService. Connection details come from credentials.json
// (interactive prompt on first run) with env-var overrides for headless
// flows. The bridge gateway IP (e.g. 172.18.0.1) is the typical value when
// MariaDB runs on the docker host and services connect from container land.
const EXTERNAL_DB                   = process.env.XCHAIN_NODE_EXTERNAL_DB === '1'
const EXTERNAL_DB_DEFAULT_HOST      = "127.0.0.1"
const EXTERNAL_DB_DEFAULT_PORT      = 3306
const EXTERNAL_DB_DEFAULT_ROOT_USER = "root"
const EXTERNAL_DB_HOST              = process.env.XCHAIN_NODE_EXTERNAL_DB_HOST || EXTERNAL_DB_DEFAULT_HOST
const EXTERNAL_DB_PORT              = parseInt(process.env.XCHAIN_NODE_EXTERNAL_DB_PORT || EXTERNAL_DB_DEFAULT_PORT, 10)
const EXTERNAL_DB_ROOT_USER         = process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER || EXTERNAL_DB_DEFAULT_ROOT_USER

// Coin name/ticker maps, generated from the canonical coin registry (src/coins)
// so xchain-node never drifts from the rest of the platform.
const coins = require('../coins');
const logger = require('../observability/logger').getLogger();

// fullname-uppercase -> fullname (e.g. BITCOIN -> "bitcoin")
const Coin = {};
for(const tick of coins.ALLOWED_COINS)
    Coin[coins.COIN_FULL_NAME[tick].toUpperCase()] = coins.COIN_FULL_NAME[tick];

// fullname -> ticker (e.g. "bitcoin" -> "BTC")
const CoinTickerSymbol = {};
for(const tick of coins.ALLOWED_COINS)
    CoinTickerSymbol[coins.COIN_FULL_NAME[tick]] = tick;

// HTTPS, not SSH: the repos are public, and a fresh machine has no GitHub SSH
// key, so git@ URLs fail the very first module clone of a documented install.
// SSH/fork/local-source workflows go through XCHAIN_NODE_MODULES_URLS_OVERRIDE.
const modulesUrls = {
    "xchain-encoder":       "https://github.com/XChain-Platform/xchain-encoder.git",
    "xchain-decoder":       "https://github.com/XChain-Platform/xchain-decoder.git",
    "xchain-utxo-tracker":  "https://github.com/XChain-Platform/xchain-utxo-tracker.git",
    "xchain-indexer":       "https://github.com/XChain-Platform/xchain-indexer.git",
    "xchain-regtest-miner": "https://github.com/XChain-Platform/xchain-regtest-miner.git",
    "xchain-hub":           "https://github.com/XChain-Platform/xchain-hub.git",
    "xchain-explorer":      "https://github.com/XChain-Platform/xchain-explorer.git",
    "xchain-e2e-test":      "https://github.com/XChain-Platform/xchain-e2e-test.git",
    "xchain-sync":          "https://github.com/XChain-Platform/xchain-sync.git",
    "xchain-vm":            "https://github.com/XChain-Platform/xchain-vm.git",
    // Not an installable service; listed so LIBRARY_BUNDLES can stage it
    // into the xchain-e2e-test build context (test:sdk suites).
    "xchain-sdk":           "https://github.com/XChain-Platform/xchain-sdk.git",
    // Also not installable; staged into the e2e-test build context so the
    // template suites (amm/escrow/crowdsale/vesting) can load their source.
    "xchain-contracts":     "https://github.com/XChain-Platform/xchain-contracts.git"
}

// Optional env-var override for local-source workflows. Lets you point any
// module at a local path (or a fork URL) without editing this file each
// iteration. Combined with ModuleService's --no-hardlinks-for-local-paths
// makes "iterate against unpushed commits" friction-free.
//
// Format: JSON object mapping module name → source URL (or local path).
//   export XCHAIN_NODE_MODULES_URLS_OVERRIDE='{"xchain-indexer":"/path/to/local"}'
//
// Unrecognized module names are ignored with a warning so a typo doesn't
// silently misroute clone targets.
if (process.env.XCHAIN_NODE_MODULES_URLS_OVERRIDE) {
    try {
        const overrides = JSON.parse(process.env.XCHAIN_NODE_MODULES_URLS_OVERRIDE)
        for (const [mod, url] of Object.entries(overrides)) {
            if (!(mod in modulesUrls)) {
                logger.warn("XCHAIN_NODE_MODULES_URLS_OVERRIDE: unknown module '" + mod + "' (ignored)")
                continue
            }
            modulesUrls[mod] = url
            // Redact any credentials embedded in an https remote
            // (https://user:token@host) before logging: git URLs routinely carry
            // an inline PAT, and this line lands in install transcripts operators
            // share. Inlined (not via helpers.redactSecrets) to avoid a
            // constants<->helpers require cycle.
            const safeUrl = String(url).replace(/([a-z][a-z0-9+.\-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
            logger.info("modulesUrls['" + mod + "'] overridden via env → " + safeUrl)
        }
    } catch (err) {
        logger.warn("XCHAIN_NODE_MODULES_URLS_OVERRIDE: parse failed (" + err.message + "), using defaults")
    }
}

const {
    DEFAULT_MODULE_BRANCH,
    LIBRARY_BUNDLES,
    SERVICE_REGISTRY
} = require('./service_registry.js')

// --- Directory paths ---
// These five operator-relevant roots are env-var-overridable so that hosts
// with a small / partition and a large data volume (e.g., OVH RISE-3 with
// /misc on a SATA mirror) can land bootstrap work + outputs on the big disk
// without symlink surgery. Falling back to the in-repo default preserves
// behavior for installs that don't set the env vars.
const moduleDir          = process.env.XCHAIN_NODE_MODULES_DIR      || path.join(__dirname, '../../modules')
const tmpDir             = process.env.XCHAIN_NODE_TMP_DIR          || path.join(__dirname, '../../tmp')
const srcDir             = path.join(__dirname, "..")
const cryptoNodesDir     = process.env.XCHAIN_NODE_CRYPTO_NODES_DIR || path.join(__dirname, '../../crypto_nodes')
const dataDir            = process.env.XCHAIN_NODE_DATA_DIR         || path.join(__dirname, '../../data')
// Published bootstraps get their own root, defaulting to dataDir so nothing
// moves unless asked. They are the one artifact whose size is unbounded
// by the install (a mainnet tracker archive is tens of GB, and LTC mainnet alone
// is 45G of source data), so an operator needs to land them on the big volume
// WITHOUT relocating live module data, which is what moving XCHAIN_NODE_DATA_DIR
// would do. Setting this after containers exist only changes where new archives
// are written; a container still mounts the path it was created with.
const bootstrapDir       = process.env.XCHAIN_NODE_BOOTSTRAP_DIR    || dataDir
const configDir          = process.env.XCHAIN_NODE_CONFIG_DIR       || path.join(__dirname, '../../config')
const containersFilesDir = path.join(tmpDir, "containers_files")

// On a fresh install, xchain-node can download a published bootstrap and restore
// it instead of syncing from genesis. Distribution layout (per service):
//   <base>/<module>/<coin>/<network>/latest.tgz
// http://sync.xchain.io 301-redirects to https, so default straight to https.
// Auto-restore is ON by default; opt out at runtime via XCHAIN_NODE_NO_BOOTSTRAP=1
// or the install --no-bootstrap flag (both read live from the env, not at load).
const BOOTSTRAP_BASE_URL     = process.env.XCHAIN_NODE_BOOTSTRAP_BASE_URL || "https://sync.xchain.io/bootstraps"

module.exports = {
    // codemod:env-entries
    // HUB_PORT is the ONE environment name that collides with a constant of
    // its own name above. The constant is the default port this CLI publishes;
    // the variable is a host operator overriding it for a second co-located
    // install. They are different facts, so the override carries its own name
    // and a read site asks for the one it means.
    get HUB_PORT_OVERRIDE() { return process.env.HUB_PORT },
    // Every entry below is a GETTER, not a value, and that is the whole point:
    // the reads these replaced happened when the caller ran, not when this file
    // loaded. A container's environment is composed and read at command time,
    // so snapshotting it here would silently answer with whatever was set when
    // the process started and miss anything set since.
    get ALLOW_NO_COLOCATED_HUB_DB() { return process.env.ALLOW_NO_COLOCATED_HUB_DB },
    get BTC_INDEXER_API_URL() { return process.env.BTC_INDEXER_API_URL || "" },
    get CORS_ORIGIN() { return process.env.CORS_ORIGIN },
    get DOGE_ADDRESS() { return process.env.DOGE_ADDRESS },
    get DOGE_ENCODER_URL() { return process.env.DOGE_ENCODER_URL },
    get DOGE_PUBKEY_HEX() { return process.env.DOGE_PUBKEY_HEX },
    get ENCODER_RATE_LIMIT_RPM() { return process.env.ENCODER_RATE_LIMIT_RPM },
    get ENCODER_TRUST_PROXY() { return process.env.ENCODER_TRUST_PROXY },
    get EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM() { return process.env.EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM },
    get EXPLORER_BATCH_RATE_LIMIT_RPM() { return process.env.EXPLORER_BATCH_RATE_LIMIT_RPM },
    get EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM() { return process.env.EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM },
    get EXPLORER_CHECKPOINT_SELF_SYNC() { return process.env.EXPLORER_CHECKPOINT_SELF_SYNC },
    get EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM() { return process.env.EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM },
    get EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM() { return process.env.EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM },
    get EXPLORER_PREFLIGHT_POST_RATE_LIMIT_RPM() { return process.env.EXPLORER_PREFLIGHT_POST_RATE_LIMIT_RPM },
    get EXPLORER_RATE_LIMIT_RPM() { return process.env.EXPLORER_RATE_LIMIT_RPM },
    get EXPLORER_TIP_MAX_AGE_S() { return process.env.EXPLORER_TIP_MAX_AGE_S },
    get EXPLORER_URL() { return process.env.EXPLORER_URL },
    get EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM() { return process.env.EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM },
    get EXPLORER_VM_QUERY_ENABLED() { return process.env.EXPLORER_VM_QUERY_ENABLED },
    get EXPLORER_VM_QUERY_RATE_LIMIT_RPM() { return process.env.EXPLORER_VM_QUERY_RATE_LIMIT_RPM },
    get FEE_DESTINATION() { return process.env.FEE_DESTINATION },
    get GH_TOKEN() { return process.env.GH_TOKEN },
    get GITHUB_TOKEN() { return process.env.GITHUB_TOKEN },
    get HUB_API_KEY() { return process.env.HUB_API_KEY },
    get HUB_API_URL() { return process.env.HUB_API_URL },
    get HUB_NETWORK() { return process.env.HUB_NETWORK },
    get HUB_PORT() { return process.env.HUB_PORT },
    get INDEXER_API_KEY() { return process.env.INDEXER_API_KEY },
    get LEVELDB_CACHE_BYTES() { return process.env.LEVELDB_CACHE_BYTES },
    get LEVELDB_WRITE_BUFFER_BYTES() { return process.env.LEVELDB_WRITE_BUFFER_BYTES },
    get TELEMETRY_ADMIN_KEY() { return process.env.TELEMETRY_ADMIN_KEY || "" },
    get TELEMETRY_ENABLED() { return process.env.TELEMETRY_ENABLED || "true" },
    get TELEMETRY_IP_SALT() { return process.env.TELEMETRY_IP_SALT || "" },
    get TELEMETRY_RETENTION_DAYS() { return process.env.TELEMETRY_RETENTION_DAYS || 90 },
    get XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER() { return process.env.XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER || '' },
    get XCHAIN_NODE_ALLOW_NO_DOGE_READ() { return process.env.XCHAIN_NODE_ALLOW_NO_DOGE_READ || '' },
    get XCHAIN_NODE_AUTOHEAL_STATE_DIR() { return process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR },
    get XCHAIN_NODE_BLOCKS_DIR() { return process.env.XCHAIN_NODE_BLOCKS_DIR },
    get XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS() { return process.env.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS },
    get XCHAIN_NODE_BOOTSTRAP_PUBKEY() { return process.env.XCHAIN_NODE_BOOTSTRAP_PUBKEY },
    get XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY() { return process.env.XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY },
    get XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE() { return process.env.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE || '' },
    get XCHAIN_NODE_CONTAINERD_ROOT() { return process.env.XCHAIN_NODE_CONTAINERD_ROOT || '/var/lib/containerd' },
    get XCHAIN_NODE_DATA_DIR() { return process.env.XCHAIN_NODE_DATA_DIR },
    get XCHAIN_NODE_DB_DATA_DIR() { return process.env.XCHAIN_NODE_DB_DATA_DIR },
    get XCHAIN_NODE_DB_MAX_CONNECTIONS() { return process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS },
    get XCHAIN_NODE_DB_ROOT_PASSWORD() { return process.env.XCHAIN_NODE_DB_ROOT_PASSWORD },
    get XCHAIN_NODE_ENCODER_MAINTENANCE_FILE() { return process.env.XCHAIN_NODE_ENCODER_MAINTENANCE_FILE },
    get XCHAIN_NODE_EXTERNAL_DB_HOST() { return process.env.XCHAIN_NODE_EXTERNAL_DB_HOST },
    get XCHAIN_NODE_EXTERNAL_DB_PORT() { return process.env.XCHAIN_NODE_EXTERNAL_DB_PORT },
    get XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD() { return process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD },
    get XCHAIN_NODE_EXTERNAL_DB_ROOT_USER() { return process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER },
    get XCHAIN_NODE_FORCE_BOOTSTRAP() { return process.env.XCHAIN_NODE_FORCE_BOOTSTRAP },
    get XCHAIN_NODE_GO_LIVE() { return process.env.XCHAIN_NODE_GO_LIVE },
    get XCHAIN_NODE_GPG_BIN() { return process.env.XCHAIN_NODE_GPG_BIN || 'gpg' },
    get XCHAIN_NODE_HUB_SIGNER_DIR() { return process.env.XCHAIN_NODE_HUB_SIGNER_DIR },
    get XCHAIN_NODE_LOCK_WAIT_MS() { return process.env.XCHAIN_NODE_LOCK_WAIT_MS },
    get XCHAIN_NODE_LOCK_DIR() { return process.env.XCHAIN_NODE_LOCK_DIR },
    get XCHAIN_NODE_MUTATING_LOCK_WAIT_MS() { return process.env.XCHAIN_NODE_MUTATING_LOCK_WAIT_MS },
    get XCHAIN_NODE_NO_BOOTSTRAP() { return process.env.XCHAIN_NODE_NO_BOOTSTRAP },
    get XCHAIN_NODE_NO_TELEMETRY() { return process.env.XCHAIN_NODE_NO_TELEMETRY || '' },
    get XCHAIN_NODE_REINDEX_LEDGER_DIR() { return process.env.XCHAIN_NODE_REINDEX_LEDGER_DIR },
    get XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP() { return process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP || '' },
    get XCHAIN_NODE_REQUIRE_SIGNED_RELEASE() { return process.env.XCHAIN_NODE_REQUIRE_SIGNED_RELEASE || '' },
    get XCHAIN_NODE_SKIP_GO_LIVE_GATE() { return process.env.XCHAIN_NODE_SKIP_GO_LIVE_GATE },
    get XCHAIN_NODE_SKIP_MIGRATION_PRECONDITION() { return process.env.XCHAIN_NODE_SKIP_MIGRATION_PRECONDITION },
    get XCHAIN_NODE_SKIP_NODE_TIP_GUARD() { return process.env.XCHAIN_NODE_SKIP_NODE_TIP_GUARD || '' },
    get XCHAIN_NODE_STAKE_WIF() { return process.env.XCHAIN_NODE_STAKE_WIF },
    get XCHAIN_NODE_STOP_TIMEOUT_SECONDS() { return process.env.XCHAIN_NODE_STOP_TIMEOUT_SECONDS },
    get XCHAIN_NODE_TELEMETRY_URL() { return process.env.XCHAIN_NODE_TELEMETRY_URL },
    get XCHAIN_NODE_UPDATE_TARGET() { return process.env.XCHAIN_NODE_UPDATE_TARGET },
    set XCHAIN_NODE_NO_BOOTSTRAP(value) { process.env.XCHAIN_NODE_NO_BOOTSTRAP = value },
    set XCHAIN_NODE_UPDATE_TARGET(value) { process.env.XCHAIN_NODE_UPDATE_TARGET = value },
    hostEnv() { return process.env },
    ...require('./env_views').bindEnvViews({ read: (name) => process.env[name], copy: () => ({ ...process.env }) }),
    // Below this line, one entry per environment variable this service reads.
    // They are passed straight through rather than parsed, because almost all
    // of them are composed into a container's environment and the container is
    // what gives them meaning; a name that needs coercion or a default gets a
    // named constant above instead, where the decision is visible.
    NODE_PREFIX,
    DEFAULT_NODE_PREFIX,
    NODE_MODULE_NAME,
    DB_MODULE_NAME,
    HUB_MODULE_NAME,
    EXPLORER_MODULE_NAME,
    SYNC_MODULE_NAME,
    NODE_VERSION_FILE_NAME,
    SEP,
    DB_SEP,
    HUB_PORT,
    DEPENDENCY_HEALTH_START_PERIOD,
    EXTERNAL_DB,
    EXTERNAL_DB_HOST,
    EXTERNAL_DB_PORT,
    EXTERNAL_DB_ROOT_USER,
    XChainService,
    REGTEST_MODULES,
    LIBRARY_BUNDLES,
    DEFAULT_MODULE_BRANCH,
    SERVICE_REGISTRY,
    Coin,
    Network,
    CoinTickerSymbol,
    projectFolders,
    modulesUrls,
    moduleDir,
    tmpDir,
    srcDir,
    cryptoNodesDir,
    dataDir,
    bootstrapDir,
    configDir,
    containersFilesDir,
    BOOTSTRAP_BASE_URL
}
