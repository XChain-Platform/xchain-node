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

function configure(dependencies) {
    ({ stateModule, Coin, Network, XChainService, logger, config, peers, readSecretHostEnv,
        HUB_MODULE_NAME, getDockerContainerImageName } = dependencies)
    warnedHubConfigKeys = new Set()
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

// The network a standalone hub should declare: the one every stack of this deployment
// runs on. Ambiguous (several networks, or none named) leaves it unset, because one
// hub declaring the wrong network mis-gates the ingest rules it is being set for.
async function resolveDeploymentHubNetwork() {
    const registered = new Set((await getRegisteredCoinStacks()).map(r => r.network))
    const networks = registered.size > 0 ? registered : new Set(getCommandCoinsAndNetworks().networks)
    if (networks.size === 1) return [...networks][0]
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
    if (registered.some(r => r.coin === Coin.BITCOIN && r.network === network
        && r.module === XChainService.XCHAIN_INDEXER)) return true
    const command = getCommandCoinsAndNetworks()
    return command.coins.includes(Coin.BITCOIN) && command.networks.includes(network)
}

// Usage-telemetry env is only meaningful to the hub (the telemetry collector).
// TELEMETRY_IP_SALT is read from the host environment (e.g. xchain-node's .env) so
// the IP-hash salt stays out of source and config files; without it the hub records
// country/region but leaves ip_hash null. The hub is a shared service (no per
// coin/network config file), so the host env is the injection point.
// Gate for the per-install detail endpoint (GET /telemetry/operators). Like the
// salt, sourced from host env so the secret stays out of source/config files;
// unset leaves the endpoint fail-closed (401 for everyone).
// BTC indexer JSON-RPC URL for the validator-mode price oracle's block-height
// anchor (hub.getlatestblock). Sourced from host env so a hub NOT co-located with
// a BTC indexer (e.g. the master hub box, where the BTC stack lives elsewhere) can
// point at a reachable indexer. Empty default ⇒ the hub falls back to its configs
// table, so co-located standalone/validator installs are unaffected. Left empty
// here, it is composed from the co-located BTC indexer further down.
// State-checkpoint engine + ANCHOR publisher (validator mode). The hub is a
// shared service (no per coin/network config file), so like the telemetry
// salt and BTC_INDEXER_API_URL above, the host env is the injection point.
// Per-coin <COIN>_INDEXER_URLs feed getblockhashes (checkpoint state reads);
// DOGE_* configures the on-chain ANCHOR/price publisher signer pipeline;
// XDEX_* are the shared single-validator/regtest seams. Only set values are
// injected, so unset host env leaves the hub's own defaults untouched.
// HUB_API_KEY gates the hub's consensus-affecting write methods. Sourced from
// host env (.env) so it persists across `update` (a hand-set container value is
// dropped on rebuild). Set it on the publicly-fronted master hub so writes are
// authenticated; unset leaves the hub keyless (the prior default).
// ANCHOR_CHUNK_RETRY_MS must outlast the utxo-tracker's mempool poll
// (60s on mainnet) or back-to-back same-wallet anchor broadcasts
// exhaust their retries on a stale UTXO view (txn-mempool-conflict).
// Anchor every Nth checkpoint_seq on-chain (off-multiples stay in the
// free off-chain mirror); decouples DOGE spend from checkpoint cadence.
// Per-coin confirmation depth the hub's cross-chain engines wait for
// before proposing a source leg (coins/index.js resolveConfirmations).
// A regtest venue pins these to 1 so a bridge lock finalizes on the
// next block instead of six BTC blocks nothing is mining (the nightly
// two-stack legs sat on "not proposing BTC:3 (below depth 6)" until
// the 120 s credit wait gave up). Inert on mainnet and testnet: the
// hub clamps a value below the per-coin default UP to that default
// off regtest, so this can only raise the depth on a real network.
// Reverse-proxy trust for the hub's express API (rate-limiter IP
// keying). Default 'loopback' suits the Apache-on-same-host prod
// topology; containerized hubs see the docker bridge as the peer,
// so an operator fronting the container with a proxy sets this.
// Deployment network for the hub's consensus gates (notably
// STAKE_WEIGHTED_QUORUM, whose activation height is per-network).
// REQUIRED by the hub in validator mode (it fails loud on a
// blank/invalid value; no silent default here either) and must
// match the INDEXER_NETWORK of the chains this hub federates.
// Oracle price-round finalization threshold. Defaults to 2 in the hub
// (a 2-hub diversity floor so a lone external source never becomes a
// federation-signed price). Single-host prod / regtest deployments must
// set ORACLE_MIN_SUBMISSIONS=1 explicitly or no round ever finalizes,
// which stalls every indexer's oracle price-sync barrier. Passed through
// here so the host env survives a hub container regenerate.
// Oracle round cadence. CONSENSUS-UNIFORM: every hub in a federation must
// share these or round numbering and the submission cutoff diverge. Passed
// through for single-validator regtest/e2e venues, where short rounds keep
// a live drill from waiting 10 minutes per finalization; real networks
// leave them unset and take the hub defaults.
// PRICE batch-publisher knobs (window length, finalization grace,
// co-sign timeout, buffer cap). Deliberately NOT consensus-grouped in
// HubConsensusEnvGuard: batch validation is range-agnostic, so two hubs
// running different window sizes just elect different leaders and may
// double-publish overlapping windows, which is idempotent at ingest and
// is the same posture today's publisher failover already has. They
// change what a leader PROPOSES, never what any node ACCEPTS. Passed
// through so the host env survives a hub container regenerate.
// Same family: the time budgeted between a window closing and its batch
// being readable on chain (assembly, co-signing, broadcast, one DOGE
// confirmation). The publisher subtracts it from the fee-price staleness
// bound to derive the window ceiling, so a venue whose
// landing latency differs from the fleet's tunes it here rather than
// being clamped to a window that does not suit it.
// ATTEST response mirror regtest-only overrides (the attest response mirror design). Both are
// honoured by the receiving hub module ONLY when HUB_NETWORK=regtest (a warn-
// and-ignore off regtest, the same posture resolveWatermarkGrace takes on the
// indexer side), so passing them through here unconditionally mirrors the
// ORACLE_BATCH_* family above: they cannot arm anything off regtest by any path
// in this file, the real gate lives at the point of consumption.
//
// ATTEST_RESPONSE_FORWARD_S_OVERRIDE lets a regtest venue's leader pick a short
// effective_time margin instead of the real 120s ATTEST_RESPONSE_FORWARD_S, so a
// response can bind within the same short block cadence a regtest drill runs at
// (xchain-hub/src/attestation/attest_response_timing.js).
// ATTEST_BATCH_WINDOW_S_OVERRIDE is the same seam for the batch cadence:
// AttestationBatchPublisher (row 20, not yet built) will read it on the same
// regtest-only pattern as the forward override above, so the passthrough is
// wired ahead of that publisher rather than after it.
// Per-IP request/min cap on the hub's express API (default 100). Too low
// for legitimate multi-indexer re-bootstrap: every indexer on a box shares
// one source IP, so a fleet bootstrapping HubDbSync tables (oracle_prices,
// price_snapshots, cross_chain_calls, capability_snapshots, state_checkpoints)
// collectively blows 100/min and gets 429'd, so the heartbeat gate then stays
// closed and the chain stalls. Raise for prod fleets. Passed through so the
// host env survives a hub container regenerate.
//
// The hub exempts loopback and private-range callers from
// that cap by default, which covers the case above: the indexers reach the hub
// container over the bridge network this compose file creates, so a managed
// node no longer needs the limit raised to rebuild price history from the chain.
// HUB_RATE_LIMIT_EXEMPT_LOCAL=false turns the exemption off and restores the
// old behavior for an operator who wants the cap enforced on every caller;
// passed through for the same container-regenerate reason.
// XCHAIN derived-price source. XCHAIN is listed on no exchange, so
// a validator computes XCHAIN/USD from realized fills in its OWN BTC indexer
// database instead of fetching it. Every native-coin fee decision on LTC and
// DOGE needs that pair, and without it those chains cannot price a fee at all.
//
// Read-only access; unset means the hub simply abstains from the pair and
// submits the 36 API pairs exactly as before, which is a supported state.
// Passed through here so the values survive a hub container regenerate - a
// config file alone never reaches the container.
// Consensus-uniform derivation parameters (window length, confirmation
// buffer, bootstrap price). Overrides exist for regtest and e2e only: a hub
// running different values computes a different XCHAIN/BTC leg and lands
// outside the co-sign deviation band, so on a real network leave them unset
// and move them only by a coordinated flag-day.
// D2 supersession threshold override. The shipped constant keeps
// supersession disabled (bootstrap carry-forward only); regtest/e2e drills
// set '0' so any realized volume supersedes, which is what lets a live
// proof distinguish a derived print from the carry-forward it would
// otherwise silently match.
// Hub API authentication. Without these two passed through, VALIDATOR MODE
// IS UNREACHABLE: the hub refuses to boot in validator mode unless one of
// them is set ("HUB_API_KEY is not set in validator mode. Write methods
// would be UNAUTHENTICATED"), and without this passthrough neither reaches
// the container at all.
//
// That failure also WEDGES the installer, so it is worth more than a
// one-line fix: once P2P_VALIDATOR_ADDR is baked into the container env the
// hub crash-loops, and `update xchain-hub` then fails because its own
// precheck tries to restart the container that cannot start. Recovery is
// `docker rm -f` the container and update again.
//
// HUB_ALLOW_UNAUTHENTICATED=true is the documented keyless escape hatch and
// suits a single-host regtest venue that already ran open; a real network
// sets HUB_API_KEY instead.
// The regtest ROLLCALL arming opt-in. The hub carries a byte-twin of
// the indexer's rollcall_activation.js, and ROLLCALL_ACTIVATION is one of
// consensus_rules_digest.js's SHARED_GATES, so an indexer armed against an
// inert container hub reports a rules MISMATCH on the venue. Both sides take
// the same variable, so a venue arms as a unit.
//
// Passed through with no network gate, unlike the indexer's copy above: the
// hub is a shared service and getDefaultConfig is called for it as
// (module, null, null), so there is no network here to gate on. That is safe
// because the real gate is in the hub's own rollcall_activation.js, which can
// reach the environment for regtest and for nothing else - mainnet and testnet
// are literal there and unreachable from env by any path in the file. On a
// mainnet or testnet hub this variable is therefore inert, not dangerous.
// XC_ROLLCALL_GATES_REGTEST_ACTIVATION rides beside it with the same
// no-network-gate reasoning: it arms ROLLCALL v1 and the rules-aware
// attestation set separately from the rail, so a venue can drive v0 as its
// control, and the hub's own rollcall_gates_activation.js gates it for real.
// XC_MIRROR_ADMISSION_ACTIVATION follows the same no-network-gate shape
// (D84 precedent): it arms the admission-map mirror and its consumer and
// barrier gates together, so a venue arms as a unit; the hub's own
// mirror-admission gate module gates it for real.
// Secret-bearing names in this list (XCHAIN_PRICE_INDEXER_DB_PASS) are also
// accepted from the host env under their redaction-safe `*_SECRET` spelling;
// everything else resolves to a plain process.env read.
function configureHubBeforeKey(defaultValues, module) {
    if (module === HUB_MODULE_NAME) {
        defaultValues["TELEMETRY_ENABLED"]        = config.TELEMETRY_ENABLED
        defaultValues["TELEMETRY_RETENTION_DAYS"] = config.TELEMETRY_RETENTION_DAYS
        defaultValues["TELEMETRY_IP_SALT"]        = config.TELEMETRY_IP_SALT
        defaultValues["TELEMETRY_ADMIN_KEY"]      = config.TELEMETRY_ADMIN_KEY
        defaultValues["BTC_INDEXER_API_URL"]      = config.BTC_INDEXER_API_URL
        const hubPassthroughVars = [
            "HUB_API_KEY",
            "BTC_INDEXER_URL", "LTC_INDEXER_URL", "DOGE_INDEXER_URL",
            "BTC_INDEXER_API_KEY", "LTC_INDEXER_API_KEY", "DOGE_INDEXER_API_KEY",
            "CHECKPOINT_ENABLED", "CHECKPOINT_INTERVAL_BLOCKS", "CHECKPOINT_CONFIRMATIONS",
            "CHECKPOINT_POLL_MS", "CHECKPOINT_ROUND_TIMEOUT_MS", "CHECKPOINT_CHAINS",
            "ANCHOR_ENABLED", "ANCHOR_INTERVAL_MS", "ANCHOR_MATCH_BATCH_SIZE",
            "ANCHOR_MAX_BATCH", "ANCHOR_CHUNK_MAX_BYTES", "ANCHOR_ROUND_TIMEOUT_MS",
            "ANCHOR_CHUNK_RETRY_MS",
            "ANCHOR_ELECTION_TOLERANCE_BLOCKS", "ANCHOR_REWARD_PER_PUBLISH",
            "ANCHOR_CHECKPOINT_EVERY_N",
            "DOGE_ENCODER_URL", "DOGE_ENCODER_API_KEY", "DOGE_ADDRESS",
            "DOGE_PUBKEY_HEX", "DOGE_LOW_BALANCE_THRESHOLD",
            "XDEX_SEED_LOCAL_VALIDATOR", "XDEX_SNAPSHOT_BLOCK",
            "XCHAIN_CONFIRMATIONS_BTC", "XCHAIN_CONFIRMATIONS_LTC", "XCHAIN_CONFIRMATIONS_DOGE",
            "HUB_TRUST_PROXY",
            "HUB_NETWORK",
            "ORACLE_MIN_SUBMISSIONS",
            "ORACLE_ROUND_INTERVAL", "ORACLE_SUBMISSION_WINDOW",
            "ORACLE_BATCH_WINDOW_ROUNDS", "ORACLE_BATCH_GRACE_MS",
            "ORACLE_BATCH_SIGN_TIMEOUT_MS", "ORACLE_BATCH_BUFFER_MAX_ROUNDS",
            "ORACLE_BATCH_LANDING_RESERVE_MS",
            "ATTEST_RESPONSE_FORWARD_S_OVERRIDE",
            "ATTEST_BATCH_WINDOW_S_OVERRIDE",
            "HUB_RATE_LIMIT_RPM", "HUB_RATE_LIMIT_EXEMPT_LOCAL",
            "XCHAIN_PRICE_INDEXER_DB_HOST", "XCHAIN_PRICE_INDEXER_DB_PORT",
            "XCHAIN_PRICE_INDEXER_DB_NAME", "XCHAIN_PRICE_INDEXER_DB_USER",
            "XCHAIN_PRICE_INDEXER_DB_PASS", "XCHAIN_PRICE_INDEXER_DB_COIN",
            "XCHAIN_PRICE_WINDOW_BLOCKS", "XCHAIN_PRICE_CONFIRMATION_BUFFER",
            "XCHAIN_PRICE_BOOTSTRAP_SATS",
            "XCHAIN_PRICE_MIN_BTC_VOLUME",
            "HUB_API_KEY", "HUB_ALLOW_UNAUTHENTICATED",
            "XC_ROLLCALL_REGTEST_ACTIVATION",
            "XC_ROLLCALL_GATES_REGTEST_ACTIVATION",
            "XC_MIRROR_ADMISSION_ACTIVATION"
        ]
        for (const varName of hubPassthroughVars) {
            const value = readSecretHostEnv(varName)
            if (value !== undefined && value !== "") {
                defaultValues[varName] = value
            }
        }
    }
}

// The hub now REFUSES to boot when HUB_API_KEY is unset unless
// keyless operation is declared with HUB_ALLOW_UNAUTHENTICATED. A managed
// deploy with no key in the host env is a legitimate posture (single-host
// regtest, a hub reachable only on a private network), so make the
// declaration here rather than letting the container crash-loop: the point
// of the hub-side change is that keyless is a stated choice, and the
// deployer is what states it. An operator who wants the refusal instead
// sets HUB_ALLOW_UNAUTHENTICATED=false in the host env, which the
// passthrough above preserves. `xchain-node go-live` still refuses a
// keyless mainnet hub outright (GoLiveGate).
// MAINNET is the exception: there the review's "invert the defaults, fail
// closed" applies with real funds behind it, so we do NOT declare keyless
// on the operator's behalf and the hub's own refusal stands. (A mainnet
// VALIDATOR hub is already covered: the hub has refused keyless validator
// boots since before this change, so no running one can be keyless and
// undeclared. This only reaches a mainnet config-only hub.)
// `validator init` leaves a generated key in the shared hub sidecar so the
// onboarding path produces a hub that BOOTS. Read it here (host env still wins),
// before the keyless declaration below: a node that has a credential must deploy
// authenticated rather than be handed the escape hatch it no longer needs.
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
}

// Operator signer for the on-chain DOGE publishers: when the host sets
// XCHAIN_NODE_HUB_SIGNER_DIR, ModuleService mounts that directory
// read-only at /XChainHub/operator-signer and the hub loads
// <dir>/signer.js via HUB_SIGNER_MODULE (see xchain-hub
// examples/doge-signer.example.js for the module contract).
// Validator mode: when `xchain-node validator init` has been run, inject the
// P2P / signing-key / capability-config env so the hub starts as a full
// validator. Returns {} (no change) for a standalone node, so the standalone
// install path is unaffected.
// State the resolved mode and the directory it came from: an empty validator
// env means standalone, disabled, or a configDir carrying no validator/, and
// a deploy cannot tell those apart. A statement, never a refusal.
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
    // A hub with no HUB_NETWORK resolves its network to '', which fails every
    // network-keyed ingest gate closed, so a non-validator install can never
    // validate an on-chain PRICE batch. Host env still wins; unresolved stays unset.
    // Capability snapshots are read off a BTC indexer, and with none reachable the
    // hub refuses every on-chain PRICE batch for insufficient signer stake. Compose
    // the co-located one; say so when this deployment has none to compose.
    configure,
    warnHubConfigOnce,
    resolveDeploymentHubNetwork,
    hasBitcoinIndexer,
    configureHubBeforeKey,
    configureHubAccess,
    configureHubValidator
}
