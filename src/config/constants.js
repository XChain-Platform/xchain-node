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
const NODE_MODULE_NAME       = "node"
const DB_MODULE_NAME         = "database"
const HUB_MODULE_NAME        = "xchain-hub"
const EXPLORER_MODULE_NAME   = "xchain-explorer"
const SYNC_MODULE_NAME       = "xchain-sync"
const NODE_VERSION_FILE_NAME = "__VERSION__.txt"
const SEP                    = "-"
const DB_SEP                 = "_"
const HUB_PORT               = 10000

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

const XChainService = {
    XCHAIN_ENCODER:       "xchain-encoder",
    XCHAIN_DECODER:       "xchain-decoder",
    XCHAIN_UTXO_TRACKER:  "xchain-utxo-tracker",
    XCHAIN_REGTEST_MINER: "xchain-regtest-miner",
    XCHAIN_INDEXER:       "xchain-indexer",
    XCHAIN_E2E_TEST:      "xchain-e2e-test"
}

const REGTEST_MODULES = [
    XChainService.XCHAIN_REGTEST_MINER,
    XChainService.XCHAIN_E2E_TEST
]

// Coin name/ticker maps, generated from the canonical coin registry (src/coins)
// so xchain-node never drifts from the rest of the platform.
const coins = require('../coins');

// fullname-uppercase -> fullname (e.g. BITCOIN -> "bitcoin")
const Coin = {};
for(const tick of coins.ALLOWED_COINS)
    Coin[coins.COIN_FULL_NAME[tick].toUpperCase()] = coins.COIN_FULL_NAME[tick];

const Network = {
    MAINNET: "mainnet",
    TESTNET: "testnet",
    REGTEST: "regtest"
}

// fullname -> ticker (e.g. "bitcoin" -> "BTC")
const CoinTickerSymbol = {};
for(const tick of coins.ALLOWED_COINS)
    CoinTickerSymbol[coins.COIN_FULL_NAME[tick]] = tick;

// Project folder names used for paths inside containers
const projectFolders = {
    "xchain-encoder":       "XChainEncoder",
    "xchain-decoder":       "XChainDecoder",
    "xchain-utxo-tracker":  "XChainUtxoTracker",
    "xchain-regtest-miner": "XChainRegtestMiner",
    "xchain-indexer":       "XChainIndexer",
    "xchain-hub":           "XChainHub",
    "xchain-explorer":      "XChainExplorer",
    "xchain-e2e-test":      "XChainE2ETest",
    "xchain-sync":          "XChainSync",
    "xchain-vm":            "XChainVM"
}

const modulesUrls = {
    "xchain-encoder":       "git@github.com:XChain-Platform/xchain-encoder.git",
    "xchain-decoder":       "git@github.com:XChain-Platform/xchain-decoder.git",
    "xchain-utxo-tracker":  "git@github.com:XChain-Platform/xchain-utxo-tracker.git",
    "xchain-indexer":       "git@github.com:XChain-Platform/xchain-indexer.git",
    "xchain-regtest-miner": "git@github.com:XChain-Platform/xchain-regtest-miner.git",
    "xchain-hub":           "git@github.com:XChain-Platform/xchain-hub.git",
    "xchain-explorer":      "git@github.com:XChain-Platform/xchain-explorer.git",
    "xchain-e2e-test":      "git@github.com:XChain-Platform/xchain-e2e-test.git",
    "xchain-sync":          "git@github.com:XChain-Platform/xchain-sync.git",
    "xchain-vm":            "git@github.com:XChain-Platform/xchain-vm.git",
    // Not an installable service; listed so LIBRARY_BUNDLES can stage it
    // into the xchain-e2e-test build context (test:sdk suites).
    "xchain-sdk":           "git@github.com:XChain-Platform/xchain-sdk.git",
    // Also not installable; staged into the e2e-test build context so the
    // template suites (amm/escrow/crowdsale/vesting) can load their source.
    "xchain-contracts":     "git@github.com:XChain-Platform/xchain-contracts.git"
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
                console.warn("XCHAIN_NODE_MODULES_URLS_OVERRIDE: unknown module '" + mod + "' (ignored)")
                continue
            }
            modulesUrls[mod] = url
            // Redact any credentials embedded in an https remote
            // (https://user:token@host) before logging: git URLs routinely carry
            // an inline PAT, and this line lands in install transcripts operators
            // share. Inlined (not via helpers.redactSecrets) to avoid a
            // constants<->helpers require cycle.
            const safeUrl = String(url).replace(/([a-z][a-z0-9+.\-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
            console.log("modulesUrls['" + mod + "'] overridden via env → " + safeUrl)
        }
    } catch (err) {
        console.warn("XCHAIN_NODE_MODULES_URLS_OVERRIDE: parse failed (" + err.message + "), using defaults")
    }
}

// Maps a service to the library modules that must be staged into its build
// context before docker build. Used by ModuleService.buildAndUp to clone +
// copy each library into the service's modules/ subdir; the service's
// Dockerfile then COPYs them in and npm resolves the file: link.
const LIBRARY_BUNDLES = {
    "xchain-indexer":  ["xchain-vm"],
    // xchain-explorer's flag-gated contract-simulation endpoint
    // (EXPLORER_VM_QUERY_ENABLED) lazy-requires xchain-vm as an
    // optionalDependency; staging it makes the feature available in built
    // images. Builds still succeed without it (endpoint 503s).
    "xchain-explorer": ["xchain-vm"],
    // xchain-e2e-test's multiValidatorHubHelper boots in-process XChainHub
    // instances against the regtest stack (multiHubAttestation,
    // llmAttestation). xchain-hub needs to ride into the build context so
    // those tests can `require` its source from inside the dockerized image.
    // xchain-sdk rides along the same way for the test:sdk suites
    // (test/sdk/sdkHelper.js loadSDK resolves the file: dep first).
    // xchain-contracts carries the contract-template source the template
    // suites load via XCHAIN_CONTRACTS_DIR (see ConfigService); without it
    // those suites skip (they no longer abort the run).
    // xchain-indexer is staged so the e2e suites that share the indexer's
    // consensus-critical primitives can `require('../../../xchain-indexer/src/...')`
    // from inside the dockerized image (those relative paths resolve to the
    // monorepo root locally, but to the image root /xchain-indexer here, where
    // the Dockerfile COPYs it). Without it attestationHelper (and the
    // integration/parity/regression suites) die with MODULE_NOT_FOUND at load.
    "xchain-e2e-test": ["xchain-hub", "xchain-sdk", "xchain-contracts", "xchain-indexer"]
}

// Operator-relevant directory roots are env-var-overridable so that hosts
// with a small / partition and a large data volume (e.g., OVH RISE-3 with
// /misc on a SATA mirror) can land bootstrap work + outputs on the big disk
// without symlink surgery. Falling back to the in-repo default preserves
// behavior for installs that don't set the env vars.
const moduleDir          = process.env.XCHAIN_NODE_MODULES_DIR      || path.join(__dirname, "..", "..", "modules")
const tmpDir             = process.env.XCHAIN_NODE_TMP_DIR          || path.join(__dirname, "..", "..", "tmp")
const srcDir             = path.join(__dirname, "..")
const cryptoNodesDir     = process.env.XCHAIN_NODE_CRYPTO_NODES_DIR || path.join(__dirname, "..", "..", "crypto_nodes")
const dataDir            = process.env.XCHAIN_NODE_DATA_DIR         || path.join(__dirname, "..", "..", "data")
const configDir          = process.env.XCHAIN_NODE_CONFIG_DIR       || path.join(__dirname, "..", "..", "config")
const containersFilesDir = path.join(tmpDir, "containers_files")

// On a fresh install, xchain-node can download a published bootstrap and restore
// it instead of syncing from genesis. Distribution layout (per service):
//   <base>/<module>/<coin>/<network>/latest.tgz
// http://sync.xchain.io 301-redirects to https, so default straight to https.
// Auto-restore is ON by default; opt out at runtime via XCHAIN_NODE_NO_BOOTSTRAP=1
// or the install --no-bootstrap flag (both read live from the env, not at load).
const BOOTSTRAP_BASE_URL     = process.env.XCHAIN_NODE_BOOTSTRAP_BASE_URL || "https://sync.xchain.io/bootstraps"

module.exports = {
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
    EXTERNAL_DB,
    EXTERNAL_DB_HOST,
    EXTERNAL_DB_PORT,
    EXTERNAL_DB_ROOT_USER,
    XChainService,
    REGTEST_MODULES,
    LIBRARY_BUNDLES,
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
    configDir,
    containersFilesDir,
    BOOTSTRAP_BASE_URL
}
