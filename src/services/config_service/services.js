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
 * Config Service Service Defaults
 ********************************************************************/

'use strict'

const { SHARED_REGTEST_GATE_ARMS } = require('../../config/regtest_gate_arms')
const { REGTEST_ACTIVATION_KEY } = require('../../utils/regtest_activations')

let config, peers, logger, readSecretHostEnv, Coin, Network, CoinTickerSymbol, XChainService
let HUB_MODULE_NAME, EXPLORER_MODULE_NAME, getDockerContainerImageName

function configure(dependencies) {
    ({ config, peers, logger, readSecretHostEnv, Coin, Network, CoinTickerSymbol, XChainService,
        HUB_MODULE_NAME, EXPLORER_MODULE_NAME, getDockerContainerImageName } = dependencies)
}

// The validator-onboarding suite needs the key the hub runs as, so derive the PUBLIC pubkey from the settings
// file the hub's own env comes from (getValidatorEnv above); the seed stays with the hub alone.
// A standalone node has no validator, so this is absent and the suite skips.

// A keyed hub gates getallconfigs (how the e2e harness finds every rail) behind HUB_API_KEY, and a validator-mode
// host is keyed, so pass it through: host env first, then the sidecar. A keyless host stays keyless.

// e2e-test also needs COIN, not only a bare NETWORK: without it initialCheck mis-splits "regtest" and bitcoinjs
// falls back to MAINNET addresses, so funded txs never confirm on regtest.

// The contract-template suites load xchain-contracts from the e2e-test build context (LIBRARY_BUNDLES stages it,
// the Dockerfile copies it); they skip when the bundle is absent.
function configureE2e(defaultValues, module, coin, network) {
    if (module === XChainService.XCHAIN_E2E_TEST) {
        defaultValues["COIN"] = coin
        defaultValues["XCHAIN_CONTRACTS_DIR"] = "/XChainE2ETest/xchain-contracts"
        if (network === Network.REGTEST) {
            for (const [key, value] of Object.entries(config.hostEnv())) {
                if (REGTEST_ACTIVATION_KEY.test(key) && value !== undefined && value !== '') {
                    defaultValues[key] = value
                }
            }
        }
        const { getValidatorSettings } = peers.validatorService
        const validatorSettings = getValidatorSettings()
        if (validatorSettings && validatorSettings.pubkey) {
            defaultValues["VALIDATOR_PUBKEY"] = validatorSettings.pubkey
        }
        if (config.HUB_API_KEY !== undefined && config.HUB_API_KEY !== "") {
            defaultValues.HUB_API_KEY = config.HUB_API_KEY
        }
    }
}

// Genesis-ledger bootstrap env (indexer only): mainnet and testnet are pinned in the indexer's configs, but regtest
// reads the genesis block and ledger/dump hashes from env. Only set, non-empty host vars are injected (a config-file
// value wins); GENESIS_AIRDROP_* are honoured on regtest ONLY, so none of these can arm mainnet or testnet.

// ROLLCALL rail env (indexer only). DOGE_INDEXER_API_URL/KEY go to every network: the BTC indexer closes roll calls
// (which land on DOGECOIN) through a DOGE indexer, and with no URL the close defers the block forever. Host env, so
// the pair survives `update`.

// XC_ROLLCALL_REGTEST_ACTIVATION is regtest only: shared-ledger networks take no tunable input, and the indexer's own
// rollcall_activation.js independently refuses the environment there, so neither gate alone can arm a shared ledger.

// HUB_SYNC_ANCHOR_ATTEST_GRACE_S is regtest only on the same two gates (a per-node grace forks settlement). Regtest
// blocks are stamped at about wall clock, so the 120s anchor-attest barrier can never clear and every block would
// burn its full 60s timeout.

// HUB_PRICE_SYNC_TIMEOUT_MS bounds one mirror-barrier attempt (expiry defers and retries, never commits uncertified),
// so shortening it is purely operational; regtest only, since a shared ledger wants the long attempt where a lagging
// mirror is a real fault.

// XCHAIN_COINPAY_EXPIRATION_S is regtest only on the same two gates (a per-node expiry forks the ledger). The e2e
// COINPay case freezes the node clock past the deadline, which stamps blocks hours ahead and stalls the attest
// barrier on one block; a short window removes the clock jump.

// Regtest-only gate activations: XC_ROLLCALL_GATES arms ROLLCALL v1 and the rules-aware attestation set apart from
// the rail; XC_MIRROR_ADMISSION must arm with the hub's copy or the admission-era canonical refuses a legacy-map row
// and halts the block loop; XC_ANCHOR_FOLD (ANCHOR v3) and EXACT_INTEGER_WIRE_FIELDS arm their own gates.

// The indexer pushes chain tips to HUB_API_URL and must present HUB_API_KEY when the hub enforces it (host env, then
// the hub sidecar). The private credential is kept apart for getallconfigs so a per-coin sidecar cannot replace it
// with the feed credential.
function configureIndexerBeforeHubKey(defaultValues, module, network) {
    if (module === XChainService.XCHAIN_INDEXER) {
        const genesisPassthroughVars = [
            "XCHAIN_GENESIS_BLOCK", "XCHAIN_GENESIS_LEDGER_HASH", "XCHAIN_GENESIS_DUMP_HASH",
            "GENESIS_LEDGER_PATH", "GENESIS_DUMP_PATH",
            "GENESIS_BLOCK_TIMEOUT_MS", "GENESIS_DUMP_TIMEOUT_MS",
            "GENESIS_AIRDROP_PATHS", "GENESIS_AIRDROP_HASHES", "GENESIS_AIRDROP_AMOUNTS",
            "GENESIS_AIRDROP_SNAPSHOT_BLOCK", "GENESIS_AIRDROP_SET_HASH"
        ]
        for (const varName of genesisPassthroughVars) {
            if (config.INDEXER_GENESIS_ENV[varName] !== undefined && config.INDEXER_GENESIS_ENV[varName] !== "") {
                defaultValues[varName] = config.INDEXER_GENESIS_ENV[varName]
            }
        }
        const originIndexerPassthroughVars = [
            "BTC_INDEXER_URL", "LTC_INDEXER_URL", "DOGE_INDEXER_URL",
            "BTC_INDEXER_API_KEY", "LTC_INDEXER_API_KEY", "DOGE_INDEXER_API_KEY"
        ]
        for (const varName of originIndexerPassthroughVars) {
            const value = readSecretHostEnv(varName)
            if (value !== undefined && value !== "") {
                defaultValues[varName] = value
            }
        }
        const rollcallPassthroughVars = ["DOGE_INDEXER_API_URL", "DOGE_INDEXER_API_KEY"]
        if (network === Network.REGTEST) rollcallPassthroughVars.push(...SHARED_REGTEST_GATE_ARMS,
                                                                      "HUB_SYNC_ANCHOR_ATTEST_GRACE_S",
                                                                      "HUB_PRICE_SYNC_TIMEOUT_MS",
                                                                      "XCHAIN_COINPAY_EXPIRATION_S",
                                                                      "EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME")
        for (const varName of rollcallPassthroughVars) {
            if (config.INDEXER_ROLLCALL_ENV[varName] !== undefined && config.INDEXER_ROLLCALL_ENV[varName] !== "") {
                defaultValues[varName] = config.INDEXER_ROLLCALL_ENV[varName]
            }
        }
        if (config.HUB_API_KEY !== undefined && config.HUB_API_KEY !== "") {
            defaultValues.HUB_API_KEY = config.HUB_API_KEY
        }
        if (config.HUB_FEED_API_KEY !== undefined && config.HUB_FEED_API_KEY !== "") {
            defaultValues.HUB_FEED_API_KEY = config.HUB_FEED_API_KEY
        }
        if (config.HUB_SEED_URLS !== undefined && config.HUB_SEED_URLS !== "") {
            defaultValues.HUB_SEED_URLS = config.HUB_SEED_URLS
        }
    }
}

// The hub authenticates to each indexer's federation API with <COIN>_INDEXER_API_KEY, from host env so it survives
// `update`; unset leaves the indexer fail-closed. Regtest, a local single-operator venue, defaults the indexer's
// keyless escape hatch on; a config or host INDEXER_API_KEY still wins and mainnet/testnet stay fail-closed.

// The hub-DB connection points at the indexer's OWN database on every network, since HubDbSync mirrors the hub
// tables into it; without HUB_DB_NAME the mainnet native-fee price-source gate fails closed. Operator overrides win,
// and HUB_DB_PASS is set once the per-install password is known (below).

// The mirror is armed on regtest too: leaving it off defeats every reader that expects hub state in the indexer. That
// arms watermark barriers that regtest (blocks stamped at ~now) can never clear within a real-network grace, so every
// grace below defaults to 0 here (host env wins). Never widen off regtest: a per-node grace forks settlement.

// Every watermark grace hub_db_sync.js resolves through resolveWatermarkGrace is listed: each mirrored table has its
// own barrier that holds a block up to its grace once that table's mirror watermark stops moving, so one left at its
// default stalls every block on an idle venue (the bridge and policy pair were once missed this way).
function configureIndexerAfterHubKey(defaultValues, module, network) {
    if (module === XChainService.XCHAIN_INDEXER) {
        if (defaultValues.HUB_API_KEY) {
            defaultValues.HUB_CONFIG_API_KEY = defaultValues.HUB_API_KEY
        }
        if (config.INDEXER_API_KEY !== undefined && config.INDEXER_API_KEY !== "") {
            defaultValues.INDEXER_API_KEY = config.INDEXER_API_KEY
        } else if (network === Network.REGTEST) {
            defaultValues.INDEXER_ALLOW_UNAUTHENTICATED = "true"
        }
        defaultValues.HUB_DB_NAME         = defaultValues.INDEXER_DB_NAME
        defaultValues.HUB_DB_USER         = defaultValues.INDEXER_DB_USER
        defaultValues.HUB_DB_SYNC_ENABLED = "true"
        if (network === Network.REGTEST) {
            const hubSyncRegtestGraceVars = [
                "HUB_SYNC_PRICE_GRACE_S", "HUB_SYNC_ORACLE_GRACE_S", "HUB_SYNC_ATTEST_RESPONSE_GRACE_S",
                "HUB_SYNC_MATCH_GRACE_S", "HUB_SYNC_CALL_GRACE_S", "HUB_SYNC_ANCHOR_ATTEST_GRACE_S",
                "HUB_SYNC_BRIDGE_GRACE_S", "HUB_SYNC_POLICY_GRACE_S"
            ]
            for (const varName of hubSyncRegtestGraceVars) {
                defaultValues[varName] = (config.HUB_SYNC_GRACE_ENV[varName] !== undefined && config.HUB_SYNC_GRACE_ENV[varName] !== "")
                    ? config.HUB_SYNC_GRACE_ENV[varName]
                    : "0"
            }
        }
    }
}

module.exports = {
    configure,
    configureE2e,
    configureIndexerBeforeHubKey,
    configureIndexerAfterHubKey
}
