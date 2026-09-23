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

let config, peers, logger, readSecretHostEnv, Coin, Network, CoinTickerSymbol, XChainService
let HUB_MODULE_NAME, EXPLORER_MODULE_NAME, getDockerContainerImageName

function configure(dependencies) {
    ({ config, peers, logger, readSecretHostEnv, Coin, Network, CoinTickerSymbol, XChainService,
        HUB_MODULE_NAME, EXPLORER_MODULE_NAME, getDockerContainerImageName } = dependencies)
}

// The validator-onboarding suite STAKEs the hub's own signing pubkey and
// asserts the indexer then admits it to each capability set, so it needs
// to know which key the hub actually runs as. It read VALIDATOR_PUBKEY
// from the env and skipped when unset, which meant the only way to run it
// was for an operator to hand-copy the hex out of `validator status` into
// the coin config - so it skipped everywhere nobody had, including CI.
// Derive it from the same settings file the hub's own env comes from
// (getValidatorEnv above), so the two can never name different keys.
//
// PUBLIC half only. The seed stays in signing.key / SIGNING_PRIVKEY_HEX
// and goes to the hub alone; the test needs the pubkey and nothing else.
//
// A standalone node has no validator, so this is absent and the suite
// still skips - correctly, because there is no identity to onboard.
// The harness discovers every rail's node and indexer credentials through
// the hub's getallconfigs (test/helpers/chainRail.js), and a keyed hub
// gates that read behind HUB_API_KEY. A validator-mode host is keyed
// (`validator init` mints the key into the hub sidecar), so without this
// passthrough the e2e container was the one hub client on the host still
// calling keyless: the litecoin and dogecoin matrix legs 401'd in
// initialCheck's beforeAll (`[chainRail] hub has no config for
// bitcoin/regtest`, run 35120852486) while the standalone bitcoin leg,
// whose hub has no key, never noticed. Host env first, then the sidecar,
// exactly as the indexer and the shared services resolve it; a keyless
// host stays keyless.
// e2e-test also derives addresses (test/cryptoHelper.js) and resolves its
// bitcoinjs network from COIN+NETWORK. initialCheck.test.js reads
// process.env.COIN and only splits NETWORK when COIN is absent; without COIN
// it mis-splits the bare network ("regtest" → COIN="regtest", NETWORK=undefined)
// → getBitcoinJsNetwork returns undefined → bitcoinjs falls back to MAINNET
// ("1..." addresses) and funded txs never confirm on regtest. Inject COIN so
// the resolution is correct while NETWORK stays bare for other env consumers.
//
// The contract-template suites (test:sdk/*Template) load their source from
// xchain-contracts. LIBRARY_BUNDLES stages it into the e2e-test build context
// and the Dockerfile COPYs it to /XChainE2ETest/xchain-contracts, so point the
// resolver there. Without the bundle present the suites skip (they no longer
// abort the run).
function configureE2e(defaultValues, module, coin) {
    if (module === XChainService.XCHAIN_E2E_TEST) {
        defaultValues["COIN"] = coin
        defaultValues["XCHAIN_CONTRACTS_DIR"] = "/XChainE2ETest/xchain-contracts"
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

// Genesis-ledger bootstrap env (xchain-indexer only). The indexer binds its
// consensus-critical genesis parameters from the container environment: mainnet/testnet
// are frozen-pinned in the indexer's configs/<COIN>.js, but regtest reads the activation
// block + ledger/dump hashes from env so an operator can dry-run genesis at a current
// regtest block. Without this passthrough those host vars never reach the container, so
// genesis can't be enabled on a regtest/dev stack. Mirrors hubPassthroughVars: only set,
// non-empty host vars are injected (and a config-file value still wins), so an unset env
// leaves GENESIS_BLOCK at its 0/default and genesis stays off. The path vars point at
// in-container files; override them only when a custom CSV/dump is volume-mounted.
// The GENESIS_AIRDROP_* members carry the XCP/XDP airdrop leg. The indexer honors
// them on regtest ONLY: off regtest the armed bucket set comes from the
// pinned coin bundle, so passing them through cannot arm anything on a mainnet or
// testnet stack, only on the regtest dry-run this passthrough exists for.
// ROLLCALL rail env (xchain-indexer only). Two separate things, both of which a
// deployed indexer needs before an epoch close can do anything at all.
//
// 1. DOGE_INDEXER_API_URL / DOGE_INDEXER_API_KEY, on EVERY network. Roll calls
//    land on DOGECOIN and the BTC indexer is the only place the close runs, so
//    rollcall_proof_client.js (and anchor_proof_client.js beside it) has to be
//    able to ask a DOGE indexer. With no URL the close returns
//    `{decided:false, reason:'DOGE indexer not configured'}` and the BTC indexer
//    DEFERS the block forever, which is exactly how a single-coin venue wedges.
//    Sourced from host env so the pair survives an `update` instead of needing
//    to be hand-set on the container after every deploy.
//
// 2. XC_ROLLCALL_REGTEST_ACTIVATION, on REGTEST ONLY. This is the one value a
//    regtest venue owns: the no-tunable-input rule is scoped to shared-ledger
//    networks, because two regtest venues cannot fork each other. It is gated on
//    the network here as well as in the indexer's own rollcall_activation.js,
//    which is structurally unable to reach the environment for mainnet or
//    testnet - two independent gates, so neither one being edited alone can arm
//    a shared ledger from a host variable.
//
// 3. HUB_SYNC_ANCHOR_ATTEST_GRACE_S, on REGTEST ONLY, for the same reason as
//    (2) and with the same two independent gates: the indexer's own
//    resolveWatermarkGrace IGNORES it off regtest with a warning, because a
//    watermark grace is a consensus input and a per-node value forks
//    settlement.
//
//    WHY A REGTEST VENUE NEEDS IT AT ALL. The anchor-reward attestation
//    barrier holds a block until `streamWatermark >= blockTime + 120`. Off
//    regtest that is free: blocks are ten minutes apart, so by the time one is
//    processed the watermark is long past it. On regtest, blocks are stamped at
//    about wall clock and the watermark tracks wall clock too, so a freshly
//    mined block can NEVER be 120s behind the watermark and the barrier is
//    unsatisfiable by construction. Every affected block then burns the full
//    60s timeout before proceeding anyway.
//
//    MEASURED, on the 2026-09-06 release matrix: the BTC leg parsed 367 blocks
//    in six hours and was killed by the job budget, against 2013 blocks in 1h52m
//    on the pre-mirror build - 160 deferrals at 60s each, about 2.7 hours spent
//    waiting for a condition that could not arrive. The other two coins were
//    unaffected because this barrier is BTC-only. Nothing was wrong with the
//    product: the venue was simply running a shared-ledger constant on a chain
//    whose block cadence it was never sized for.
// 4. HUB_PRICE_SYNC_TIMEOUT_MS, on REGTEST ONLY here even though the value
//    itself is not a consensus input. It bounds ONE mirror-barrier ATTEMPT:
//    on expiry the block is DEFERRED and retried, never committed
//    uncertified, which XChainIndexer states outright ("purely operational:
//    it opens no barrier and commits no block"). So shortening it trades
//    nothing away; it only makes a failed attempt cheaper.
//
//    WHY A FAST VENUE NEEDS IT. Where the mirror legitimately lags the
//    chain, every affected block waits the full attempt before deferring.
//    Measured on the 2026-09-06 release matrix: 119 anchor-attest deferrals
//    at the 60s default burned 119 minutes of a 289-minute BTC leg, 41% of
//    the wall clock, and the indexer fell far enough behind that thirty
//    e2e waits gave up on rows that had not landed yet. The barrier is
//    doing its job; the cost per attempt is what a fast venue cannot afford.
//
//    Gated on regtest anyway, because a shared ledger wants the long
//    attempt: there a lagging mirror is a real fault worth waiting on, not
//    a cadence mismatch.
// 5. XCHAIN_COINPAY_EXPIRATION_S, on REGTEST ONLY, for the same reason as (2)
//    and (3) and with the same two independent gates: the indexer's own
//    resolveCoinpayExpiration IGNORES it off regtest with a warning, because
//    the window is added to a match's BLOCK_TIME and STORED as the
//    obligation's deadline, so a per-node value expires the same escrow at
//    different blocks and forks the ledger.
//
//    WHY A REGTEST VENUE NEEDS IT. The e2e COINPay expiry case cannot wait out
//    a two-hour deadline, so it freezes the node clock past the deadline and
//    mines. That stamps the mined blocks two hours into the FUTURE, and the
//    anchor-attest barrier in (3) compares a block's own timestamp against a
//    wall-clock watermark, so the indexer then waits those two hours in real
//    time on that one block.
//
//    MEASURED, on the 2026-09-06 release matrix run 34015867460: all 119
//    deferrals in the BTC leg named the SAME block, held 2h08m50s, while the
//    watermark tracked wall clock throughout (1-6s behind, advancing at 0.9999
//    of real time) and the hub logged no late heartbeat and no backpressure.
//    Nothing was lagging. Shortening the window on regtest removes the clock
//    jump that causes it, rather than teaching every barrier to special-case a
//    future-stamped block.
// XC_ROLLCALL_GATES_REGTEST_ACTIVATION follows XC_ROLLCALL_REGTEST_ACTIVATION's
// same env-derived regtest shape (D84): it arms ROLLCALL v1 and the rules-aware
// attestation set separately from the rail, so a venue can drive v0 as its control.
//
// XC_MIRROR_ADMISSION_ACTIVATION rides the same regtest-only shape: without a
// path here the indexer side of the admission-map mirror can never be armed on
// regtest (row 24x), and it must arm together with the hub's copy above or the
// admission-era canonical refuses a legacy-map row and halts the block loop.
// The indexer pushes chain tips to HUB_API_URL; when that hub enforces
// HUB_API_KEY, the indexer must present the same key or its writes 401.
// Sourced from host env so it persists across `update`, then from the shared
// hub sidecar so an indexer co-located with a private hub picks up its key.
// Preserve that private credential separately for getallconfigs before a
// per-coin sidecar can override HUB_API_KEY with the feed credential.
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
        const rollcallPassthroughVars = ["DOGE_INDEXER_API_URL", "DOGE_INDEXER_API_KEY"]
        if (network === Network.REGTEST) rollcallPassthroughVars.push("XC_ROLLCALL_REGTEST_ACTIVATION",
                                                                      "XC_ROLLCALL_GATES_REGTEST_ACTIVATION",
                                                                      "HUB_SYNC_ANCHOR_ATTEST_GRACE_S",
                                                                      "HUB_PRICE_SYNC_TIMEOUT_MS",
                                                                      "XCHAIN_COINPAY_EXPIRATION_S",
                                                                      "XC_MIRROR_ADMISSION_ACTIVATION")
        for (const varName of rollcallPassthroughVars) {
            if (config.INDEXER_ROLLCALL_ENV[varName] !== undefined && config.INDEXER_ROLLCALL_ENV[varName] !== "") {
                defaultValues[varName] = config.INDEXER_ROLLCALL_ENV[varName]
            }
        }
        if (config.HUB_API_KEY !== undefined && config.HUB_API_KEY !== "") {
            defaultValues.HUB_API_KEY = config.HUB_API_KEY
        }
    }
}

// The hub authenticates to each indexer's federation API (attestation, stake polling,
// capability snapshots) with <COIN>_INDEXER_API_KEY; the indexer fails closed unless its
// INDEXER_API_KEY matches. Source from host env so it persists across `update`, mirroring
// HUB_API_KEY above. Unset leaves the indexer fail-closed (keyless reads rejected).
// With no key configured the indexer fails closed: every gated method
// (feequotedryrun, the federation reads the staking e2e family asserts
// against) 401s, so a fresh regtest install can never pass those suites
// (audit F-10). Regtest is a local single-operator venue, so default the
// indexer's own documented keyless escape hatch on. A config-file value
// or host INDEXER_API_KEY still wins; mainnet/testnet stay fail-closed.
// Point the indexer's hub-DB connection (its price_snapshots/oracle_prices source)
// at its OWN database on mainnet/testnet: in this single-box topology HubDbSync
// mirrors those hub tables into the indexer DB, so the indexer reads prices from
// itself using its own DB account. Without HUB_DB_NAME the connection is never made
// and the mainnet native-fee price-source gate (XChainIndexer.start) fails closed.
// This mirrors the proven prod per-coin override; operator config overrides still
// win. HUB_DB_PASS is reconciled after the per-install DB password is resolved
// (see below); HUB_DB_HOST/PORT are already set above.
//
// WHY regtest WAS EXCLUDED UNTIL NOW, corrected 2026-07-26 then armed 2026-09-03
// (the regtest mirror wedge). The old note here said "regtest has no hub to sync from", which
// stopped being true at 336a7d5 (HUB_API_URL is now composed for regtest too, and
// a regtest indexer does reach the hub: enabling this on litecoin-regtest
// bootstrapped 3 real rows into oracle_prices). The exclusion stood for a
// different and harder reason: turning the mirror on ARMS the block-loop
// watermark barriers (price, oracle, and now the ATTEST response mirror), and
// each one only opens once the mirror's stream watermark clears the row's time
// plus that barrier's grace. Production block timestamps LAG wall clock, so the
// watermark runs ahead and the escape fires; regtest blocks are stamped at ~now,
// so a real-network grace can NEVER be satisfied and every freshly mined block
// defers forever. Observed live: block 1479 deferred on a 60s timeout, repeatedly,
// until this was reverted.
//
// Armed unconditionally now (mainnet/testnet keep the exact same assignment they
// always had) because leaving the mirror off on regtest silently defeats every
// reader that expects hub state to reach the indexer, not just PRICE but
// the ATTEST response mirror this arms for too. Arming the pointer alone would
// reproduce the price wedge above, so every watermark grace this mirror gates is
// defaulted to 0 on regtest in the SAME step below: a config-file value or a host
// env override for any one of them still wins (resolveWatermarkGrace in
// hub_db_sync.js honours an override on regtest only, so the default below is
// exactly the value that seam already expects). Do not widen these off regtest:
// a per-node grace forks settlement.
// The three barrier graces the armed regtest mirror must clear to avoid the
// wedge above. HUB_SYNC_ATTEST_RESPONSE_GRACE_S is the passthrough this row
// adds (xchain-indexer/src/hub/hub_db_sync.js:615 reads it via resolveWatermarkGrace);
// HUB_SYNC_PRICE_GRACE_S / HUB_SYNC_ORACLE_GRACE_S are the pair the regtest mirror wedge already
// requires be set to 0 alongside it. A host env value always wins over the
// regtest default so an e2e drill can still exercise a nonzero grace.
// The list is EVERY watermark grace hub_db_sync.js resolves, not the three
// that first wedged: each mirrored table has its own barrier, and any one
// left at its frozen default holds every block up to 60s while that
// table's mirror watermark stands still, which on a three-rail regtest
// venue idle for hours is every block; an SDK drive's 120s index wait
// then dies on the second block. Measured 2026-09-09 on the match
// barrier, then again on the anchor-reward attestation barrier once
// match was cleared (hub_db_sync.js reads all of them through
// resolveWatermarkGrace, regtest-overridable only).
// The bridge and policy pair joined the indexer after this list was written
// and was missed. Their barriers stay open while no transfer is finalized, so a
// bitcoin-only venue never paid for it; the litecoin and dogecoin legs get gas
// over the bridge, so after the first transfer every block whose time passed
// the newest effective_time waited out the 120 s grace. Measured on the
// 2026-09-23 nightly (run 35829816064): 8 deferrals, about 2m10s, per affected
// block on the DOGE indexer, and every e2e step there took about 130 s where
// the bitcoin leg's took about 10 s.
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
