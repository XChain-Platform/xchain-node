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
 * Config Service Defaults
 ********************************************************************/

'use strict'

let config, Network, Coin, CoinTickerSymbol, XChainService, DB_SEP, SEP, bootstrapDir
let NODE_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME
let getDockerContainerImageName, getModuleDatabaseName

function configure(dependencies) {
    ({ config, Network, Coin, CoinTickerSymbol, XChainService, DB_SEP, SEP, bootstrapDir,
        NODE_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME,
        getDockerContainerImageName, getModuleDatabaseName } = dependencies)
}

// The coin node's CONTAINER NAME, never the bare `node` alias every coin
// node also carries. The indexer joins its sibling coins' networks for
// cross-chain reads (ModuleService.crossChainNetworksFor) and the hub
// joins every stack, so from either container docker DNS answers `node`
// with whichever sibling network sorts first (bitcoin), and a dogecoin
// stack's RPC credentials then hit the bitcoin node: HTTP 401 by name,
// 200 by IP. Measured on regtest 2026-09-11 and reported by a testnet
// operator the same day. The container name resolves on any shared
// network and is unique per coin/network, like every other *_URL here.
// The e2e-test harness reaches the indexer DB via DATABASE_URL/DATABASE_PORT
// (test/initialCheck.test.js), not INDEXER_DB_HOST/PORT. Default them here so
// the EXTERNAL_DB rewrite below can repoint them; on a host-native-DB box the
// docker DNS name "mariadb" doesn't resolve and the suite fails at bootstrap.
// HUB_API_URL is the indexer's write endpoint. An operator may point it at a
// validator feed, so the config poll gets its own URL for the managed private
// hub. Otherwise getallconfigs follows the feed override to a port that does
// not expose private methods. A per-coin HUB_CONFIG_URL still overrides this
// default during the config-file merge below.
//
// Composed from the same container name + port as HUB_API_HOST/HUB_PORT, so
// it resolves on the docker network exactly as the sibling *_API_HOST vars
// do. An operator config-file value still wins, so prod's explicit
// cross-host URL is unaffected.
//
// This enables the push half only. The read-back half (hub tables mirrored
// into the indexer) additionally needs HUB_DB_NAME + HUB_DB_SYNC_ENABLED,
// which regtest deliberately leaves unset (see the network !== "regtest"
// block below), so turning this on cannot start a mirror bootstrap and
// cannot re-page price_snapshots out from under a seeded test venue.
// The e2e federation suites (test:federation / test:attestation:llm) boot
// in-process MultiValidatorHubs that create + drop XChain_<coin>_<net>_MVH_*
// databases, so the container needs the hub DB credentials. DatabaseService
// grants this user CREATE/DROP on the XChain_%_MVH_% pattern when the hub
// module is installed. Omitting these made requireFederationEnv loud-fail.
// Explorer is a SHARED service (no coin/network suffix). Like the hub
// above, the e2e-test container needs to reach it on the docker network;
// omitting it left EXPLORER_URL/EXPLORER_API_PORT unset, which failed the
// e2e harness's checkAllEnvironmentalVariables() → broken hub-config fallback.
function createCoinDefaults(module, coin, network) {
    return {
        "NETWORK":   network,
        "NODE_URL":  getDockerContainerImageName(NODE_MODULE_NAME, coin, network),
            "NODE_PORT": (network === Network.MAINNET ? 8332 : (network === Network.TESTNET ? 18332 : 18444)),
        "NODE_USER": "rpc",
        "NODE_PASSWORD": "rpc",
        "UTXO_TRACKER_URL":              getDockerContainerImageName(XChainService.XCHAIN_UTXO_TRACKER, coin, network),
        "UTXO_TRACKER_API_PORT":         3001,
        "UTXO_TRACKER_PORT":             3001,
        "UTXO_TRACKER_BOOTSTRAP_VOLUME": bootstrapDir + "/" + coin + "/" + network + "/" + module + "/bootstrap/",
        "DECODER_DB_NAME":   getModuleDatabaseName(XChainService.XCHAIN_DECODER, coin, network),
        "DECODER_DB_HOST":   "mariadb",
        "DECODER_DB_PORT":   3306,
        "DECODER_DB_USER":   "xchain" + DB_SEP + "decoder" + DB_SEP + coin + DB_SEP + network,
        "DECODER_DB_PASS":   "xchain" + SEP + "password",
        "DECODER_URL":       getDockerContainerImageName(XChainService.XCHAIN_DECODER, coin, network),
        "DECODER_API_PORT":  3002,
        "DECODER_PORT":      3002,
        "DECODER_BOOTSTRAP_VOLUME": bootstrapDir + "/" + coin + "/" + network + "/" + module + "/bootstrap/",
        "INDEXER_BOOTSTRAP_VOLUME": bootstrapDir + "/" + coin + "/" + network + "/" + module + "/bootstrap/",
        "ENCODER_URL":       getDockerContainerImageName(XChainService.XCHAIN_ENCODER, coin, network),
        "ENCODER_API_PORT":  3003,
        "ENCODER_PORT":      3003,
        "INDEXER_URL":       getDockerContainerImageName(XChainService.XCHAIN_INDEXER, coin, network),
        "INDEXER_API_PORT":  3004,
        "INDEXER_PORT":      3004,
        "INDEXER_COIN":      CoinTickerSymbol[coin],
        "INDEXER_NETWORK":   network,
        "INDEXER_DB_HOST":   "mariadb",
        "INDEXER_DB_PORT":   3306,
        "INDEXER_DB_NAME":   getModuleDatabaseName(XChainService.XCHAIN_INDEXER, coin, network),
        "INDEXER_DB_USER":   "xchain" + DB_SEP + "indexer" + DB_SEP + coin + DB_SEP + network,
        "INDEXER_DB_PASS":   "xchain" + SEP + "password",
        "DATABASE_URL":      "mariadb",
        "DATABASE_PORT":     3306,
        "HUB_HOST":          "0.0.0.0",
        "HUB_API_HOST":      getDockerContainerImageName(HUB_MODULE_NAME, "", ""),
        "HUB_PORT":          10000,
        "HUB_API_URL":       "http://" + getDockerContainerImageName(HUB_MODULE_NAME, "", "") + ":10000",
        "HUB_CONFIG_URL":    "http://" + getDockerContainerImageName(HUB_MODULE_NAME, "", "") + ":10000",
        "HUB_DB_HOST":       "mariadb",
        "HUB_DB_PORT":       3306,
        "HUB_DB_USER":       "xchain" + DB_SEP + "hub",
        "HUB_DB_PASS":       "xchain" + SEP + "password",
        "EXPLORER_URL":      getDockerContainerImageName(EXPLORER_MODULE_NAME, "", ""),
        "EXPLORER_API_PORT": 8080,
        "EXPLORER_PORT":     8080
    }
}


function createSharedDefaults() {
    return {
        "HUB_HOST":              "0.0.0.0",
        "HUB_API_HOST":          getDockerContainerImageName(HUB_MODULE_NAME, "", ""),
        "HUB_PORT":              10000,
        "HUB_DB_HOST":           "mariadb",
        "HUB_DB_PORT":           3306,
        "HUB_DB_NAME":           "XChain" + DB_SEP + "Hub",
        "HUB_DB_USER":           "xchain" + DB_SEP + "hub",
        "HUB_DB_PASS":           "xchain" + SEP + "password",
        "EXPLORER_HOST":         "127.0.0.1",
        "EXPLORER_PORT":         18080,
        "EXPLORER_API_HOST":     getDockerContainerImageName(EXPLORER_MODULE_NAME, "", ""),
        "EXPLORER_API_USER":     false,
        "EXPLORER_API_PASS":     false,
        "EXPLORER_API_PORT_HTTP":  8080,
        "EXPLORER_PORT_HTTP":      18080,
        "EXPLORER_API_PORT_HTTPS": 8081,
        "EXPLORER_PORT_HTTPS":     18081,
        "SYNC_MODE":               "server",
        "SYNC_API_PORT":           3006,
        "SYNC_PORT":               3006,
        "SYNC_API_HOST":           getDockerContainerImageName(SYNC_MODULE_NAME, "", ""),
        "HUB_API_HOST_SYNC":       getDockerContainerImageName(HUB_MODULE_NAME, "", "")
    }
}

// Allow the operator to override the shared hub's port via host env.
// The hub has no per-coin config file, so host env is the injection point, same
// as the explorer override below. constants.js's HUB_MODULE_NAME.docker.ports
// entry maps BOTH the published host port and the container-internal port from
// this one HUB_PORT value (`-p ${HUB_PORT}:${HUB_PORT}`), and every hub client
// in this file (buildCheckpointConfig, updateHubOrExplorer, ...) reads the
// computed defaultValues.HUB_PORT rather than the constants.js default, so
// overriding it here keeps the published port, the container's own listener,
// and every in-process caller in agreement. Motivating case: a second
// co-located xchain-node install (e.g. verifying `install master xchain-hub`
// boots correctly) needs its hub reachable on a host port distinct from a
// standing shared hub's 10000, which had no override at all and so could only
// be tested by tearing the shared hub down or standing up a whole separate
// Docker daemon.
// Allow the operator to override the explorer's published HOST ports via host
// env. Shared services (explorer/hub) have no per-coin config file, so host env
// is the injection point (same pattern as the hub passthrough vars below). The
// motivating case: a second co-located xchain-node install (e.g. a federation
// stack alongside the primary node) must publish the explorer on a non-default
// port to avoid colliding with the primary's 18080/18081. Container-internal
// ports (EXPLORER_API_PORT_HTTP/HTTPS) are unchanged.
// The explorer hard-requires a co-located hub-mirror DB (state_checkpoints /
// capability_snapshots / cross_chain_matches) per serving coin, since
// xchain-sync never replicates those tables. Regtest and dev stacks don't run
// that replication, so the explorer would crash-loop on startup there. Let the
// operator opt out via host env (ALLOW_NO_COLOCATED_HUB_DB=1): the hub-mirrored
// endpoints then fail loud per-request instead of blocking startup. Unset on
// mainnet/testnet so the missing-DB guard still catches a real misconfiguration.
// Shared services that call the hub as clients (the sync server's config
// discovery via getallconfigs, the explorer's hub reads) must present the
// hub's API key once the hub enforces its sensitive-read tier: getallconfigs
// 401s keyless when HUB_API_KEY is set hub-side. Sourced from host env so it
// persists across `update`, then from the shared hub sidecar, mirroring the
// indexer's passthrough above. Neither set keeps the prior keyless behavior
// (fine against a keyless hub).
function configureSharedBeforeHubKey(defaultValues) {
    if (config.HUB_PORT_OVERRIDE !== undefined && config.HUB_PORT_OVERRIDE !== "") {
        defaultValues.HUB_PORT = config.HUB_PORT_OVERRIDE
    }
    for (const k of ["EXPLORER_PORT_HTTP", "EXPLORER_PORT_HTTPS", "EXPLORER_PORT"]) {
        if (config.EXPLORER_PORT_ENV[k] !== undefined && config.EXPLORER_PORT_ENV[k] !== "") {
            defaultValues[k] = config.EXPLORER_PORT_ENV[k]
        }
    }
    if (config.ALLOW_NO_COLOCATED_HUB_DB !== undefined && config.ALLOW_NO_COLOCATED_HUB_DB !== "") {
        defaultValues.ALLOW_NO_COLOCATED_HUB_DB = config.ALLOW_NO_COLOCATED_HUB_DB
    }
    if (config.HUB_API_KEY !== undefined && config.HUB_API_KEY !== "") {
        defaultValues.HUB_API_KEY = config.HUB_API_KEY
    }
}

// The browser wallet calls the hub cross-origin (ping, config reads).
// The hub disables CORS unless CORS_ORIGIN is set, so a browser wallet is
// blocked and reports the chain "degraded". The hub is a shared, network-
// agnostic service (it may front mainnet), so unlike the per-network encoder
// above it is NOT auto-defaulted open: the operator opts in via host env.
// On a local regtest dev box set CORS_ORIGIN=* when installing the hub.
// Self-synced hub-mirror checkpoint schema (row 39, #4138 decoupling):
// HubMirrorSyncManager needs the hub's own REST base URL to pull
// state_checkpoints / capability_snapshots / cross_chain_matches, which
// is a DIFFERENT thing from HUB_API_HOST/HUB_PORT above (those feed the
// explorer's ordinary getallconfigs config poll, not the mirror writer).
// Opt-in via host env EXPLORER_CHECKPOINT_SELF_SYNC, read directly by
// HubService.buildHubModuleConfig's checkpoint injection (see there for
// why this stays a second knob instead of piggybacking
// ALLOW_NO_COLOCATED_HUB_DB: that flag only downgrades the fatal
// startup assertion to a warning and says nothing about whether a
// local mirror should be provisioned). Emitted only when opted in, so
// a deployment that never uses self-sync carries no unused hub URL.
//
// This env is no longer the mirror writer's ONLY source: the same URL
// now ships inside the checkpoint config block beside self_sync
// (HubService.buildCheckpointConfig), because these two lived on
// different delivery paths - container env written at install time
// versus the hub's config push - and opting in after the container
// existed left the explorer self-syncing with nowhere to sync from.
// Kept for the explorer's other hub reads (HubOperationalCache) and as
// the fallback for hand-written config.json deployments.
// Read Contract simulation (contract.html #contract-read-card) is
// default-off; the readers test for the exact STRING 'true', not any
// truthy value, so pass the host env through verbatim rather than
// coercing it. Sourced from host env so it persists across `update`/
// `recreate`, mirroring the other explorer passthroughs here.
// Serving limits, same host-env injection point as the knobs above,
// because every one of these defaults is tuned for a PUBLIC explorer
// and is wrong for a private venue:
//   EXPLORER_*RATE_LIMIT_RPM - the nine request budgets, per IP: the
//     app-wide cap, the quote/pre-flight caps, and the six per-route
//     caps (checkpoint-list, checkpoint-verify, action-proof,
//     validator-set-proof, vm-query, batch). A dev box reaches the explorer
//     through one tunnel, so every browser and every test run shares a
//     single bucket, and a browser-driven suite sustains far more than
//     any one of these caps on its own. All nine are now reachable
//     from the host env; the five per-route caps were unreachable on a
//     node-managed explorer (the regtest venue), which could raise only
//     the app-wide and fee-quote caps before this change.
//   EXPLORER_TIP_MAX_AGE_S   - 6h by default, and 0 disables it. A
//     regtest chain has no block cadence: it advances only when someone
//     mines, so an idle one crosses the age gate and the explorer delists
//     a chain that is perfectly healthy (503 COIN_DATA_STALE on every
//     read, lag 0 on /status).
// Read BY NAME rather than by scanning process.env for a pattern: a
// computed read is invisible to the platform's env-var coverage gate,
// which is what turns an undocumented variable into a silent one. The
// per-coin EXPLORER_TIP_MAX_AGE_S_<CODE> form is deliberately NOT
// carried here - the explorer honours it directly, and the global knob
// already covers the case this passthrough exists for (an instance
// serving nothing but a private venue).
// The explorer resolves each coin's utxo-tracker and decoder from
// UTXO_TRACKER_URL_<CODE> (e.g. UTXO_TRACKER_URL_RBTC) and
// DECODER_API_URL_<COIN>_<NETWORK> (e.g. DECODER_API_URL_BTC_REGTEST).
// The explorer is a shared service with no per-venue config file, so these
// were never emitted anywhere: every coin reported tracker_available:false
// and decoder_health 'unconfigured', which blanks address balances/UTXOs
// (the wallet's balance source). Emit the pair for every coin/network at
// the venue containers' internal ports; entries for venues not installed
// on this host are inert because the explorer only probes coins it serves.
// Same omission, one service later. The explorer's
// quote/pre-flight proxies (/api/preflight, /api/feequote,
// /api/oraclefeequote) resolve their upstream from
// INDEXER_API_URL_<COIN>_<NETWORK>, which was never emitted
// here, so every one of them answered INDEXER_NOT_CONFIGURED
// on a container install. That silently reduced the wallet's
// pre-flight to its client-side tier: the confirm surface
// still renders a verdict, just never the indexer's own.
//
// Unlike the two above, this one yields to the host env. The
// explorer is also run natively (systemd) on hosts where the
// indexers live on OTHER boxes, and those set this var by
// hand to a remote address; a container-local
// default that overrode it would point a working production
// explorer at a hostname that does not resolve.
function configureSharedAfterHubKey(defaultValues, module) {
    if (config.CORS_ORIGIN !== undefined && config.CORS_ORIGIN !== "") {
        defaultValues.CORS_ORIGIN = config.CORS_ORIGIN
    }
    if (module === EXPLORER_MODULE_NAME) {
        if (config.EXPLORER_CHECKPOINT_SELF_SYNC !== undefined && config.EXPLORER_CHECKPOINT_SELF_SYNC !== "") {
            defaultValues.HUB_API_URL = config.HUB_API_URL ||
                ("http://" + getDockerContainerImageName(HUB_MODULE_NAME, "", "") + ":" + defaultValues.HUB_PORT)
        }
        if (config.EXPLORER_VM_QUERY_ENABLED !== undefined && config.EXPLORER_VM_QUERY_ENABLED !== "") {
            defaultValues.EXPLORER_VM_QUERY_ENABLED = config.EXPLORER_VM_QUERY_ENABLED
        }
        for (const key of [
            "EXPLORER_RATE_LIMIT_RPM",
            "EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM",
            "EXPLORER_PREFLIGHT_POST_RATE_LIMIT_RPM",
            "EXPLORER_TIP_MAX_AGE_S",
            "EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM",
            "EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM",
            "EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM",
            "EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM",
            "EXPLORER_VM_QUERY_RATE_LIMIT_RPM",
            "EXPLORER_BATCH_RATE_LIMIT_RPM"
        ]) {
            const value = {
                EXPLORER_RATE_LIMIT_RPM:                   config.EXPLORER_RATE_LIMIT_RPM,
                EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM:         config.EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM,
                EXPLORER_PREFLIGHT_POST_RATE_LIMIT_RPM:    config.EXPLORER_PREFLIGHT_POST_RATE_LIMIT_RPM,
                EXPLORER_TIP_MAX_AGE_S:                    config.EXPLORER_TIP_MAX_AGE_S,
                EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM:   config.EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM,
                EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM: config.EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM,
                EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM:      config.EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM,
                EXPLORER_BATCH_RATE_LIMIT_RPM:             config.EXPLORER_BATCH_RATE_LIMIT_RPM,
                EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM: config.EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM,
                EXPLORER_VM_QUERY_RATE_LIMIT_RPM:          config.EXPLORER_VM_QUERY_RATE_LIMIT_RPM
            }[key]
            if (value === undefined || value === "") continue
            defaultValues[key] = value
        }
    }
    if (module === EXPLORER_MODULE_NAME) {
        const networkCodePrefix = { [Network.MAINNET]: "", [Network.TESTNET]: "T", [Network.REGTEST]: "R" }
        for (const coinName of Object.values(Coin)) {
            for (const net of Object.values(Network)) {
                const tick = CoinTickerSymbol[coinName]
                defaultValues["UTXO_TRACKER_URL_" + networkCodePrefix[net] + tick] =
                    "http://" + getDockerContainerImageName(XChainService.XCHAIN_UTXO_TRACKER, coinName, net) + ":3001"
                defaultValues["DECODER_API_URL_" + tick + "_" + net.toUpperCase()] =
                    "http://" + getDockerContainerImageName(XChainService.XCHAIN_DECODER, coinName, net) + ":3002"
                const indexerVar = "INDEXER_API_URL_" + tick + "_" + net.toUpperCase()
                defaultValues[indexerVar] = config.INDEXER_API_URL_ENV[indexerVar]
                    || "http://" + getDockerContainerImageName(XChainService.XCHAIN_INDEXER, coinName, net) + ":3004"
            }
        }
    }
}

module.exports = {
    configure,
    createCoinDefaults,
    createSharedDefaults,
    configureSharedBeforeHubKey,
    configureSharedAfterHubKey
}
