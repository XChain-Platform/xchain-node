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
 * Config Service Network Defaults
 ********************************************************************/

'use strict'

let stateModule, Coin, Network, XChainService, logger, config, peers, readSecretHostEnv
let HUB_MODULE_NAME, getDockerContainerImageName
let warnedHubConfigKeys = new Set()
let hubDefaults = null, configuredHubNetwork = null

function configure(dependencies) {
    ({ stateModule, Coin, Network, XChainService, logger, config, peers, readSecretHostEnv,
        HUB_MODULE_NAME, getDockerContainerImageName } = dependencies)
    warnedHubConfigKeys = new Set()
    hubDefaults = configuredHubNetwork = null
}

// A command composes the shared hub's config many times, so each deploy-time warning
// about it is said once per process rather than once per composition.
function warnHubConfigOnce(key, message) {
    if (warnedHubConfigKeys.has(key)) return
    warnedHubConfigKeys.add(key)
    logger.warn(message)
}

// The coin/network stacks this deployment runs, from the module registry. Returns []
// when the registry is unreadable (no pool yet), which the callers treat as "unknown"
// rather than "none".
async function getRegisteredCoinStacks() {
    try {
        const { db } = stateModule
        const rows = await db.getAllModuleContainers(null, null)
        return (rows || []).filter(r => r && r.coin && r.network
            && Object.values(Coin).includes(r.coin) && Object.values(Network).includes(r.network))
    } catch {
        return []
    }
}

// The coin and network tokens of the command being run. A first install registers no
// coin stack until AFTER preCheck has deployed the shared hub, so the operator's own
// arguments are the only source the hub's env can be composed from on a fresh host.
function getCommandCoinsAndNetworks() {
    const argv = process.argv.slice(2)
    return {
        coins:    [...new Set(argv.filter(t => Object.values(Coin).includes(t)))],
        networks: [...new Set(argv.filter(t => Object.values(Network).includes(t)))]
    }
}

// The network `validator init` recorded, when it names a real network. The hub declares
// it (getValidatorEnv), so the indexer URLs composed for the hub must follow it.
function recordedValidatorNetwork() {
    const settings = peers.validatorService.getValidatorSettings()
    const network = String((settings && settings.network) || "").toLowerCase()
    return Object.values(Network).includes(network) ? network : null
}

// The network a standalone hub should declare: the host env's, else a validator's recorded
// one, else the one every stack of this deployment runs on. Ambiguous (several networks, or
// none named) leaves it unset, because a wrong declared network mis-gates the hub's ingest rules.
async function resolveDeploymentHubNetwork() {
    const registeredStacks = await getRegisteredCoinStacks()
    const registered = new Set(registeredStacks.map(r => r.network))
    const recorded = configuredHubNetwork ? null : recordedValidatorNetwork()
    const networks = configuredHubNetwork ? new Set([configuredHubNetwork])
        : recorded ? new Set([recorded])
        : registered.size > 0 ? registered : new Set(getCommandCoinsAndNetworks().networks)
    if (networks.size === 1) {
        const network = [...networks][0]
        await composeColocatedIndexerUrls(hubDefaults, network, registeredStacks)
        return network
    }
    if (networks.size > 1) {
        warnHubConfigOnce("HUB_NETWORK_AMBIGUOUS",
            "WARNING: HUB_NETWORK is not set and this deployment runs stacks on " +
            [...networks].sort().join(", ") + ", so the shared hub cannot derive one network. " +
            "Its network-keyed ingest gates (PRICE batch validation) stay closed until " +
            "HUB_NETWORK is set in the host env.")
    }
    return null
}

// Whether this deployment runs a BTC indexer for `network`, counting the one the
// running command is installing right now: the hub is deployed before it exists, and
// the composed URL names the container that install creates.
async function hasBitcoinIndexer(network) {
    const registered = await getRegisteredCoinStacks()
    await composeColocatedIndexerUrls(hubDefaults, network, registered)
    if (registered.some(r => r.coin === Coin.BITCOIN && r.network === network
        && r.module === XChainService.XCHAIN_INDEXER)) return true
    const command = getCommandCoinsAndNetworks()
    return command.coins.includes(Coin.BITCOIN) && command.networks.includes(network)
}

// Co-located LTC and DOGE indexers use Docker DNS; host URLs remain for remote stacks.
const INDEXER_URL_VARS = { litecoin: "LTC_INDEXER_URL", dogecoin: "DOGE_INDEXER_URL" }
async function composeColocatedIndexerUrls(defaultValues, network, registeredStacks = null) {
    if (!defaultValues || !network) return
    const registered = registeredStacks || await getRegisteredCoinStacks()
    const command = getCommandCoinsAndNetworks()
    for (const [coin, name] of Object.entries(INDEXER_URL_VARS)) {
        const here = registered.some(r => r.coin === coin && r.network === network && r.module === XChainService.XCHAIN_INDEXER)
            || (command.coins.includes(coin) && command.networks.includes(network))
        if (here) defaultValues[name] = "http://" +
            getDockerContainerImageName(XChainService.XCHAIN_INDEXER, coin, network) + ":3004"
    }
}

const HUB_PASSTHROUGH_VARS = [
    "HUB_API_KEY",
    "BTC_INDEXER_URL", "LTC_INDEXER_URL", "DOGE_INDEXER_URL",
    "BTC_INDEXER_API_KEY", "LTC_INDEXER_API_KEY", "DOGE_INDEXER_API_KEY",
    "CHECKPOINT_ENABLED", "CHECKPOINT_INTERVAL_BLOCKS", "CHECKPOINT_CONFIRMATIONS",
    "CHECKPOINT_POLL_MS", "CHECKPOINT_ROUND_TIMEOUT_MS", "CHECKPOINT_CHAINS",
    "ANCHOR_ENABLED", "ANCHOR_INTERVAL_MS", "ANCHOR_MATCH_BATCH_SIZE",
    "ANCHOR_MAX_BATCH", "ANCHOR_CHUNK_MAX_BYTES", "ANCHOR_ROUND_TIMEOUT_MS",
    "ANCHOR_CHUNK_RETRY_MS", "ANCHOR_ELECTION_TOLERANCE_BLOCKS", "ANCHOR_REWARD_PER_PUBLISH",
    "ANCHOR_CHECKPOINT_EVERY_N",
    "DOGE_ENCODER_URL", "DOGE_ENCODER_API_KEY", "DOGE_ADDRESS",
    "DOGE_PUBKEY_HEX", "DOGE_LOW_BALANCE_THRESHOLD",
    "XDEX_SEED_LOCAL_VALIDATOR", "XDEX_SNAPSHOT_BLOCK",
    "XCHAIN_CONFIRMATIONS_BTC", "XCHAIN_CONFIRMATIONS_LTC", "XCHAIN_CONFIRMATIONS_DOGE",
    "HUB_TRUST_PROXY",
    "HUB_NETWORK",
    "ORACLE_MIN_SUBMISSIONS", "ORACLE_ALLOW_UNVERIFIED_PAIRS",
    "ORACLE_ROUND_INTERVAL", "ORACLE_SUBMISSION_WINDOW",
    "ATTESTATION_ROUND_TIMEOUT_MS", "ADMISSION_WATERMARK_SAMPLE_MS",
    "ORACLE_BATCH_WINDOW_ROUNDS", "ORACLE_BATCH_GRACE_MS",
    "ORACLE_BATCH_SIGN_TIMEOUT_MS", "ORACLE_BATCH_BUFFER_MAX_ROUNDS",
    "ORACLE_BATCH_LANDING_RESERVE_MS",
    "ATTEST_RESPONSE_FORWARD_S_OVERRIDE",
    "ATTEST_BATCH_WINDOW_S_OVERRIDE", "ORACLE_PUBLISH_ENABLED", "ATTEST_BATCH_PUBLISH_ENABLED",
    "HUB_RATE_LIMIT_RPM", "HUB_RATE_LIMIT_EXEMPT_LOCAL",
    "XCHAIN_PRICE_INDEXER_DB_HOST", "XCHAIN_PRICE_INDEXER_DB_PORT",
    "XCHAIN_PRICE_INDEXER_DB_NAME", "XCHAIN_PRICE_INDEXER_DB_USER",
    "XCHAIN_PRICE_INDEXER_DB_PASS", "XCHAIN_PRICE_INDEXER_DB_COIN",
    "XCHAIN_PRICE_WINDOW_BLOCKS", "XCHAIN_PRICE_CONFIRMATION_BUFFER",
    "XCHAIN_PRICE_BOOTSTRAP_SATS",
    "XCHAIN_PRICE_MIN_BTC_VOLUME",
    "HUB_ALLOW_UNAUTHENTICATED",
    "XC_ROLLCALL_REGTEST_ACTIVATION",
    "XC_ROLLCALL_GATES_REGTEST_ACTIVATION",
    "XC_MIRROR_ADMISSION_ACTIVATION",
    "XC_ANCHOR_FOLD_REGTEST_ACTIVATION",
    "XC_ANCHOR_STAKE_REGTEST_ACTIVATION",
    "XC_ANCHOR_SLASH_REGTEST_ACTIVATION",
    "XC_OFFER_LIST_REGTEST_ACTIVATION"
]
// Hub telemetry secrets come from host env; unset, ip_hash stays null and admin is 401.
// BTC indexer JSON-RPC URL comes from host env for a hub not co-located with one. Left
// empty, it is composed from the co-located indexer, else the hub uses its configs table.

// State-checkpoint and ANCHOR config enters the shared hub through host env: per-coin <COIN>_INDEXER_URLs feed
// getblockhashes, DOGE_* configures the ANCHOR/price publisher signer, XDEX_* are single-validator/regtest seams.
// Only set values are injected, so unset host env leaves the hub's own defaults untouched.

// HUB_API_KEY gates the hub's consensus-affecting write methods. From host env (.env) so
// it survives `update`; unset leaves the hub keyless.

// ANCHOR_CHUNK_RETRY_MS must outlast the utxo-tracker mempool poll (60s on mainnet) or
// back-to-back same-wallet anchor broadcasts exhaust their retries on a stale UTXO view.

// Anchor every Nth checkpoint_seq on-chain (off-multiples stay in the free off-chain
// mirror); decouples DOGE spend from checkpoint cadence.

// Per-coin confirmation depth the hub waits for before proposing a source leg (coins/index.js resolveConfirmations):
// a regtest venue pins 1; off regtest the hub clamps a lower value UP to the per-coin default.

// Reverse-proxy trust for the hub express API (rate-limiter IP keying). Default
// loopback suits Apache on the same host; a proxy in front of the container sets this.

// Deployment network for the hub's consensus gates (STAKE_WEIGHTED_QUORUM activates per network). REQUIRED in
// validator mode (the hub fails loud on a blank or invalid value) and must match the INDEXER_NETWORK it federates.

// Oracle price-round finalization threshold, default 2 in the hub so a lone external source never becomes a
// federation-signed price; single-host prod and regtest must set 1 or no round finalizes and every indexer's oracle barrier stalls.

// Regtest-only single-fetcher co-sign escape hatch. The hub ignores it off regtest. It changes what a node
// accepts, so the consensus env guard protects it from silent removal on regtest.

// Oracle round cadence is CONSENSUS-UNIFORM: every hub in a federation must share it or round numbering and the
// submission cutoff diverge. Passed through for single-validator regtest/e2e venues; real networks leave it unset.

// PRICE batch-publisher knobs (window length, grace, co-sign timeout, buffer cap) are deliberately NOT in
// CONSENSUS_ENV_GROUPS (hub_consensus_env_guard.js): they change what a leader PROPOSES, never what a node ACCEPTS,
// and overlapping windows from differing hubs are idempotent at ingest. Passed through to survive a hub regenerate.

// Same family: the time between a window closing and its batch being readable on chain. The publisher subtracts it
// from the fee-price staleness bound to get the window ceiling, so a venue with other landing latency tunes it here.

// ATTEST response mirror regtest-only overrides are honoured by the hub ONLY when HUB_NETWORK=regtest (warn and ignore
// otherwise), so passing them through arms nothing elsewhere. Unlike the ORACLE_BATCH_* family they change what a node
// ACCEPTS, so CONSENSUS_ENV_GROUPS (hub_consensus_env_guard.js) guards them on regtest against a recreate dropping them.

// ATTEST_RESPONSE_FORWARD_S_OVERRIDE shortens the real 120s effective_time margin (attest_response_timing.js) and
// ATTEST_BATCH_WINDOW_S_OVERRIDE the batch cadence (resolveAttestBatchWindowS, batch_publisher.js); both are regtest only.

// Per-IP request/min cap on the hub API (default 100): indexers on one box share a source IP, so a fleet re-bootstrapping
// the mirror tables can exceed it and stall the heartbeat gate behind 429s. Raise for prod fleets; passed through to survive a regenerate.

// Loopback and private-range callers are exempt by default (managed-node indexers reach the hub over the compose
// bridge); HUB_RATE_LIMIT_EXEMPT_LOCAL=false restores the cap on every caller.

// XCHAIN derived-price source: XCHAIN is on no exchange, so a validator computes XCHAIN/USD from realized fills in its OWN
// BTC indexer database (read-only), which LTC and DOGE native-fee decisions need. Unset, the hub abstains from the pair and
// submits the 36 API pairs. Passed through because a config file alone never reaches the container.

// Consensus-uniform derivation parameters (window, confirmation buffer, bootstrap price): overrides are for regtest and
// e2e only, since differing values yield a different XCHAIN/BTC leg outside the co-sign band; on a real network move them by flag-day.

// D2 supersession threshold override: the shipped constant keeps supersession off (bootstrap carry-forward only); regtest/e2e
// set '0' so any realized volume supersedes, letting a live proof tell a derived print from the carry-forward.

// Hub API authentication: validator mode refuses to boot unless HUB_API_KEY or HUB_ALLOW_UNAUTHENTICATED reaches the
// container, and a baked P2P_VALIDATOR_ADDR then crash-loops the hub and wedges `update xchain-hub` (recover with
// `docker rm -f` and update again). HUB_ALLOW_UNAUTHENTICATED=true is the keyless hatch for single-host regtest.

// The regtest ROLLCALL opt-in: the hub's byte-twin of rollcall_activation.js and the consensus_rules_digest.js SHARED_GATES
// mean an armed indexer against an inert hub reports a rules MISMATCH, so both sides take the same variable. Passed through
// with no network gate (the hub is configured as (module, null, null)); its own gate reaches env for regtest only, so it is inert elsewhere.

// XC_ROLLCALL_GATES, XC_MIRROR_ADMISSION and the ANCHOR fold/stake/slash and offer-list activations ride beside it with the
// same no-network-gate reasoning: each arms its feature as a unit on regtest, and the hub's own gate module gates it for real.

// Secret-bearing names in this list (XCHAIN_PRICE_INDEXER_DB_PASS) are also
// accepted from the host env under their redaction-safe `*_SECRET` spelling;
// everything else resolves to a plain process.env read.
function configureHubBeforeKey(defaultValues, module) {
    if (module === HUB_MODULE_NAME) {
        hubDefaults = defaultValues
        defaultValues["TELEMETRY_ENABLED"]        = config.TELEMETRY_ENABLED
        defaultValues["TELEMETRY_RETENTION_DAYS"] = config.TELEMETRY_RETENTION_DAYS
        defaultValues["TELEMETRY_IP_SALT"]        = config.TELEMETRY_IP_SALT
        defaultValues["TELEMETRY_ADMIN_KEY"]      = config.TELEMETRY_ADMIN_KEY
        defaultValues["BTC_INDEXER_API_URL"]      = config.BTC_INDEXER_API_URL
        for (const varName of HUB_PASSTHROUGH_VARS) {
            const value = readSecretHostEnv(varName)
            if (value !== undefined && value !== "") {
                defaultValues[varName] = value
            }
        }
    }
}

// A hub refuses to boot with HUB_API_KEY unset unless keyless is declared (HUB_ALLOW_UNAUTHENTICATED), so declare it for a
// legitimate keyless posture (single-host regtest, private network) rather than crash-loop; the host env set to false keeps
// the refusal, and `xchain-node go-live` still refuses a keyless mainnet hub (GoLiveGate).

// MAINNET never gets the declaration (real funds, so fail closed); that only reaches a config-only hub, since validator
// hubs already refuse keyless boots.

// `validator init` leaves a generated key in the shared hub sidecar; read it here (host env wins) before the keyless
// declaration, so a node holding a credential deploys authenticated.
function configureHubAccess(defaultValues) {
    const hubNetworkIsMainnet = String(defaultValues["HUB_NETWORK"] || "").toLowerCase() === Network.MAINNET
    if (!defaultValues["HUB_API_KEY"] && defaultValues["HUB_ALLOW_UNAUTHENTICATED"] === undefined
        && !hubNetworkIsMainnet) {
        defaultValues["HUB_ALLOW_UNAUTHENTICATED"] = "true"
        logger.warn("WARNING: HUB_API_KEY is not set, so this hub is deployed with an UNAUTHENTICATED " +
            "write surface (HUB_ALLOW_UNAUTHENTICATED=true). Anyone who can reach the hub port can drive " +
            "updateconfig / registervalidator / reportreorg. Set HUB_API_KEY in the host env before " +
            "exposing this hub beyond a trusted network.")
    }
    configuredHubNetwork = String(defaultValues["HUB_NETWORK"] || "").toLowerCase() || null
    if (configuredHubNetwork) delete defaultValues["HUB_NETWORK"]
}

// Operator signer for the on-chain DOGE publishers: with XCHAIN_NODE_HUB_SIGNER_DIR set, ModuleService mounts it read-only at
// /XChainHub/operator-signer and the hub loads <dir>/signer.js via HUB_SIGNER_MODULE (see xchain-hub examples/doge-signer.example.js).

// Validator mode: after `xchain-node validator init`, inject the P2P / signing-key / capability-config env so the hub
// starts as a full validator; returns {} for a standalone node.

// State the resolved mode and its directory: an empty validator env means standalone, disabled, or a configDir with no
// validator/, and a deploy cannot tell them apart. A statement, never a refusal.
function configureHubValidator(defaultValues) {
    if (config.XCHAIN_NODE_HUB_SIGNER_DIR) {
        defaultValues["HUB_SIGNER_MODULE"] = "/XChainHub/operator-signer/signer.js"
    }
    const { getValidatorEnv, validatorModeReport } = peers.validatorService
    Object.assign(defaultValues, getValidatorEnv())
    const validator = validatorModeReport()
    if (validator.mode === 'validator') {
        logger.info("xchain-node: this hub deploys in VALIDATOR mode, from " + validator.dir)
    } else if (validator.mode === 'incomplete') {
        warnHubConfigOnce("VALIDATOR_STATE_INCOMPLETE",
            "WARNING: the validator state under " + validator.dir + " is HALF PRESENT (missing " +
            validator.missing.join(", ") + "), so this hub deploys STANDALONE: no P2P_VALIDATOR_ADDR, " +
            "no SIGNING_PRIVKEY_HEX, no capability mount, and its anchor publisher will never run. " +
            "Half a validator state is never a standalone node, so this is a broken install rather " +
            "than a choice: restore the missing file, or point XCHAIN_NODE_CONFIG_DIR at the config " +
            "directory that holds the complete set.")
    } else if (validator.mode === 'disabled') {
        logger.info("xchain-node: this hub deploys STANDALONE because the validator state at " +
            validator.dir + " records enabled:false.")
    } else {
        logger.info("xchain-node: this hub deploys STANDALONE (no validator state under " +
            validator.dir + "). If this host IS meant to be a validator, XCHAIN_NODE_CONFIG_DIR is " +
            "resolving to the wrong config directory and the real one holds validator/.")
    }
}

module.exports = {
    // Host env wins for the hub network and the BTC indexer URL; an unresolved network stays
    // unset, and a deployment with no BTC indexer to compose is warned about.
    configure,
    warnHubConfigOnce,
    resolveDeploymentHubNetwork,
    hasBitcoinIndexer,
    composeColocatedIndexerUrls,
    configureHubBeforeKey,
    configureHubAccess,
    configureHubValidator, HUB_PASSTHROUGH_VARS
}
