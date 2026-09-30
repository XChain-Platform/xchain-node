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
 * XChain Node - Validator Stake Service
 *
 * `xchain-node validator stake`: put this validator's signing key on chain.
 * Reads the stake wallet init wrote, checks the address's coin and XCHAIN
 * balances against the public explorer, mints XCHAIN on testnet when the
 * balance is short (the faucet token's per-transaction cap is read live from
 * the token, never assumed), then broadcasts STAKE v1 naming the pubkey.
 *
 * Dry run by default: without --broadcast it prints the plan (balances, the
 * mints it would send, the STAKE it would send) and exits, which doubles as
 * the "have I funded it enough yet" check. Every on-chain step waits for the
 * indexer to see the previous one, because a STAKE that races its own MINT
 * into a block is rejected for insufficient balance.
 *
 * Nothing here prints a WIF. The wallet file is 0600 and the key goes from
 * that file into the SDK session and nowhere else.
 ********************************************************************/

const {
    getValidatorSettings, readWallets, publicWalletInfo, promptSecret, loadSdk,
    COIN_NETWORKS, WALLETS_FILE
} = require('./validator_service')
const { getCoinConfigByFullName } = require('../coins')
const config = require('../config');
const { readKeyHolders } = require('./validator_stake_service/free_key')

const STAKE_TICK = 'XCHAIN'
// One stake that clears every capability floor at once. The highest is the hub's llm attestation
// provider floor (min_stake_xchain in xchain-hub/src/validators/provider_registry/defaults.js), not the
// indexer's STAKING.CAPABILITIES (top 5000); governance can raise it per block, so this is a snapshot.
const DEFAULT_STAKE_AMOUNT = 25000
const PUBLIC_EXPLORER = 'https://explorer.xchain.io'

// Approximate target block spacing per chain, used ONLY to gloss a block count
// as wall-clock time an operator can plan around. Display-only: nothing branches
// on it, and every block count itself comes from the coin registry. The coin
// files carry no spacing field, so these mirror the arithmetic their own STAKING
// comments already state ("~7 days at ~10 min/block").
const BLOCK_MINUTES = { bitcoin: 10, litecoin: 2.5, dogecoin: 1 }

// A block count as a duration. Empty on regtest, where blocks are mined on
// demand and any wall-clock figure would be a fabrication, and empty for a chain
// with no spacing entry rather than a wrong one.
function roughDuration(blocks, fullName, network) {
    const perBlock = BLOCK_MINUTES[fullName]
    if (network === 'regtest' || !(perBlock > 0) || !(blocks > 0)) return ''
    const minutes = blocks * perBlock
    if (minutes < 90) return 'roughly ' + Math.round(minutes) + ' minutes'
    const hours = minutes / 60
    if (hours < 36) return 'roughly ' + Math.round(hours) + ' hours'
    return 'roughly ' + Math.round(hours / 24) + ' days'
}

function paren(text) {
    return text ? ' (' + text + ')' : ''
}

/**
 * The two clocks that govern a stake, read per-chain from the vendored canonical
 * coin registry (src/coins/<COIN>.js STAKING) rather than restated here. Both
 * are per-chain (BTC 6/1000, LTC 24/4032, DOGE 60/10080), so a hardcoded pair
 * would misreport two of the three chains.
 *
 * They are separate clocks and they differ by more than two orders of magnitude,
 * which is exactly why both have to be printed. Both count from the same block,
 * the one the action lands in (xchain-indexer/src/actions/unstake/index.js:
 * deactivation_block = BLOCK_INDEX + ACTIVATION_DELAY_BLOCKS in sweepCapabilityStake,
 * COOLDOWN_END_BLOCK = BLOCK_INDEX + COOLDOWN_BLOCKS; the STAKE side's activation
 * delay is in xchain-indexer/src/actions/stake/capability_stake.js):
 *   activation: how long a STAKE waits before it counts, and how long an
 *     UNSTAKEd one keeps counting toward every capability before it drops out.
 *   cooldown:   how long the escrowed XCHAIN stays locked afterwards, until the
 *     indexer's block-end sweep credits it back and it can be spent again.
 *
 * Reads the in-repo registry, so the dry-run path stays offline.
 */
function stakeTiming(coins, network) {
    const fullName = String(coins.stake).split('-')[0]
    const staking  = getCoinConfigByFullName(fullName, network).STAKING || {}
    return {
        activationBlocks: staking.ACTIVATION_DELAY_BLOCKS,
        cooldownBlocks:   staking.COOLDOWN_BLOCKS,
        activationFor:    roughDuration(staking.ACTIVATION_DELAY_BLOCKS, fullName, network),
        cooldownFor:      roughDuration(staking.COOLDOWN_BLOCKS, fullName, network)
    }
}

function fail(msg) {
    const e = new Error(msg)
    e.validatorStake = true
    return e
}

// The stake WIF: wallets.env first, then the env var, then a hidden prompt.
function resolveStakeWif(wallets) {
    if (wallets && wallets.STAKE_WIF_SECRET) return wallets.STAKE_WIF_SECRET
    if (config.XCHAIN_NODE_STAKE_WIF) return config.XCHAIN_NODE_STAKE_WIF
    const typed = promptSecret('WIF for the stake wallet (input hidden): ')
    if (!typed) throw fail('no stake wallet. Run `xchain-node validator init`, or set XCHAIN_NODE_STAKE_WIF.')
    return typed
}

function num(x) {
    const n = Number(x)
    return Number.isFinite(n) ? n : 0
}

// Unwrap an explorer entity read: some deployments answer a one-element array
// of the record rather than the record itself (the SDK's findToken handles both).
function entity(body) {
    return Array.isArray(body) ? body[0] : body
}

// Read the address's native balance, or null when the explorer could not.
// A tracker outage answers confirmed: null with tracker_available: false, and
// Number(null) is 0, so reading it as a number would tell a funded operator to fund it.
function nativeBalance(addr) {
    const balances = addr && addr.balances
    if (!balances || addr.tracker_available === false) return null
    const confirmed = balances.confirmed
    if (confirmed === null || confirmed === undefined || !Number.isFinite(Number(confirmed))) return null
    return { confirmed: Number(confirmed), pending: num(balances.pending) }
}

// getToken() throws a raw HTTP error when the tick has no token record at
// all, which is exactly the state a freshly reset regtest venue is in (a
// reset does not reissue XCHAIN). Left uncaught that surfaces as an
// unexplained "Explorer returned HTTP 404 for /.../token/XCHAIN" - name the
// missing token and point at the fix instead of letting the 404 leak through.
async function getStakeToken(sdk) {
    try {
        return await sdk.explorer.getToken(STAKE_TICK)
    } catch (e) {
        const status = e && e.details ? e.details.status : undefined
        if (status === 404 || (e && e.code === 'EXPLORER_HTTP_404')) {
            throw fail('the ' + STAKE_TICK + ' gas token does not exist on this venue. A regtest reset ' +
                'does not reissue it, so nothing here can stake, mint, or price a transaction until it ' +
                'is seeded. Run this venue\'s gas-token bootstrap (the same ISSUE the e2e harness runs) ' +
                'before staking.')
        }
        throw e
    }
}

// Read everything the plan needs from the explorer. Split out so the
// broadcast path and the tests share one shape. `keyCtx` ({ network, coins,
// cooldownBlocks }) is what the free-key rules are judged against.
async function readChainState(sdk, address, pubkey, keyCtx) {
    const native  = nativeBalance(entity(await sdk.explorer.getAddress(address)))
    const coinBal = native ? native.confirmed : null
    const coinPending = native ? native.pending : null

    const bals = await sdk.getBalances(address)
    const row  = ((bals && bals.data) || []).find(b => b && b.tick === STAKE_TICK)
    const tokenBal = num(row && row.amount)

    // Read the faucet caps from the token's mints group; a token with no such
    // group is an unreadable answer, not a MAX_MINT of 0.
    const token = entity(await getStakeToken(sdk))
    const mints = (token && token.mints && typeof token.mints === 'object') ? token.mints : null
    const mintUnreadable = mints ? null : 'the ' + STAKE_TICK + ' token read returned an unexpected shape (no mints group), ' +
        'so its faucet caps are unknown'

    // An existing stake on this pubkey means v1 would be rejected (the indexer
    // refuses a pubkey that already carries one); say so instead of spending.
    //
    // Read the SET and filter, rather than a per-pubkey lookup: the explorer
    // serves /validator/<pubkey>, but the SDK client exposes no method for it,
    // and calling one that does not exist throws a TypeError that a catch here
    // would turn into "no existing stake" - a reassuring null that green-lights
    // a duplicate STAKE. A failed read is reported, never silently treated as
    // an answer. The set is read page by page to the end (readValidatorSet), and
    // a truncated read throws into the same catch rather than reading as absent.
    // readKeyHolders also applies the reuse gate and reads the key's delegations.
    const holders = await readKeyHolders(sdk, pubkey, keyCtx)

    return { coinBal, coinPending, tokenBal, mintMax: num(mints && mints.max),
        mintAddressMax: num(mints && mints.address_max), mintUnreadable, ...holders }
}

// Plan the mints: how many transactions, at what amount each, to lift the
// balance to `amount`. Pure, so it is testable without a network.
// `mintUnreadable` names why the caps could not be read, so it is not reported as MAX_MINT 0.
function planMints(network, tokenBal, amount, mintMax, mintAddressMax, mintUnreadable) {
    const short = Math.max(0, amount - tokenBal)
    if (short === 0) return { short, mints: [], reason: null }
    if (network === 'mainnet') {
        return { short, mints: [], reason: 'XCHAIN is not mintable on mainnet: acquire ' + short + ' more and re-run.' }
    }
    if (mintUnreadable) {
        return { short, mints: [], reason: mintUnreadable + '; cannot plan the mints for the shortfall. Retry, or check the explorer.' }
    }
    if (!(mintMax > 0)) {
        return { short, mints: [], reason: 'the ' + STAKE_TICK + ' token reports no open mint (MAX_MINT is 0); cannot mint the shortfall.' }
    }
    const mints = []
    let left = short
    while (left > 0) { const a = Math.min(mintMax, left); mints.push(a); left -= a }
    let reason = null
    if (mintAddressMax > 0 && short > mintAddressMax) {
        reason = 'the shortfall (' + short + ') exceeds the per-address mint cap (' + mintAddressMax + '); ' +
                 'this address cannot mint enough on its own.'
    }
    return { short, mints, reason }
}

function explorerUrl(coins, pathPart) {
    return (config.EXPLORER_URL || PUBLIC_EXPLORER).replace(/\/$/, '') + '/' + coins.stakeCoin + '/' + pathPart
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function requireEncoder(sdk) {
    return typeof sdk.requireEncoder === 'function' ? sdk.requireEncoder() : sdk['_requireEncoder']()
}

/**
 * The outputs of `prevTxid` that belong to this address, once the encoder can
 * see them. Seconds (mempool visibility), not a block.
 *
 * Handing these to the encoder as the ONLY candidate inputs is what lets the
 * whole run go out at once safely. The indexer resolves a STAKE's balance from
 * every ledger entry with a LOWER ACTION INDEX (`m.action_index < ?` in
 * xchain-indexer/src/db/misc/index.js getAddressCreditDebit), and that index
 * is global, so the mints count whether
 * they share the STAKE's block or sit in an earlier one. All that matters is
 * that they come FIRST, which the funding chain guarantees by construction:
 * consensus requires a parent transaction to precede its child, so a chain
 * cannot be reordered within a block or split out of order across two. Left to
 * choose freely, the encoder could fund the STAKE from an unrelated output at
 * the same address, and a miner would then be free to place it ahead of the
 * mints that pay for it.
 *
 * Measured 2026-08-29 on testnet4: five chained actions spanned two blocks
 * (three mints at action_index 40-42 in 150306, the last mint and the STAKE at
 * 43-44 in 150307) and the STAKE indexed valid, because relative order held
 * across the block boundary exactly as the chain guarantees.
 *
 * Returns null if nothing spendable appears in time, which is the caller's
 * signal to stop chaining and fall back to waiting.
 */
async function chainedInputs(sdk, address, prevTxid, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 90000)
    for (;;) {
        let utxos = null
        try { utxos = await requireEncoder(sdk).getUTXOs(address) } catch { /* transient; retry */ }
        const outs = ((utxos && utxos.utxos) || []).filter(o => (o.fullTxid || o.txid) === prevTxid)
        if (outs.length) return outs
        const left = deadline - Date.now()
        if (left <= 0) return null
        // Never sleep past our own deadline: a fixed poll interval turns a
        // short timeout into a wait far longer than the caller asked for.
        await sleep(Math.min(2000, left))
    }
}

// Poll until the address's confirmed XCHAIN balance covers `amount`. The
// fallback when a chain cannot be formed: once the mints are indexed, the
// STAKE no longer depends on in-block ordering at all.
async function waitForBalance(sdk, address, amount, timeoutMs, log, pollMs) {
    const deadline = Date.now() + (timeoutMs || 7200000)
    for (;;) {
        let held = 0
        try {
            const b = await sdk.getBalances(address)
            const row = ((b && b.data) || []).find(t => t && t.tick === STAKE_TICK)
            held = num(row && row.amount)
        } catch { /* transient; retry */ }
        if (held >= amount) return true
        const left = deadline - Date.now()
        if (left <= 0) return false
        log('    waiting for the mints to index (' + held + '/' + amount + ' ' + STAKE_TICK + ')...')
        await sleep(Math.min(pollMs || 30000, left))
    }
}

/**
 * Everything both the stake and unstake commands need: this validator's
 * identity, its network, and a wallet session proven to control the recorded
 * stake address. Shared so the two commands cannot drift on the guards that
 * matter (network resolution and the WIF/address match).
 */
function openValidatorSession(opts, deps) {
    // An explicit null is the caller SAYING there is no validator, not an absent
    // injection: `||` treats the two alike and falls through to the real validator
    // directory, which leaves the no-validator path exercisable only on a machine
    // that happens to have none. Same idiom as deps.wallets below.
    const settings = deps.settings !== undefined ? deps.settings : getValidatorSettings()
    if (!settings) throw fail('no validator configured. Run: xchain-node validator init')
    const network = settings.network || (settings.P2P_PORT === 10002 ? 'testnet' : (settings.P2P_PORT === 10001 ? 'mainnet' : null))
    if (!network || !COIN_NETWORKS[network]) throw fail('validator network unknown; re-run `validator init --network testnet|mainnet`.')
    const coins  = COIN_NETWORKS[network]
    const pubkey = String(settings.pubkey || '').toLowerCase()

    const wallets = deps.wallets !== undefined ? deps.wallets : readWallets()
    const wif     = deps.wif || resolveStakeWif(wallets)
    const info    = publicWalletInfo(wallets)

    const { XChainSDK } = deps.sdk || loadSdk()
    const sdk = deps.makeSdk ? deps.makeSdk(coins.stake) : new XChainSDK({ network: coins.stake })
    const session = sdk.session(wif, { waitForIndexer: true })
    if (info && info.stakeAddress && session.address !== info.stakeAddress) {
        throw fail('the stake WIF controls ' + session.address + ', not the ' + info.stakeAddress +
                   ' recorded in ' + WALLETS_FILE + '. Nothing was sent.')
    }
    return { settings, network, coins, pubkey, sdk, session, address: session.address }
}

const { createStakeValidator } = require('./validator_stake_service/stake_operations')
const { createUnstakeValidator } = require('./validator_stake_service/unstake_operations')

const operationHelpers = {
    openValidatorSession, stakeTiming, readChainState, planMints, explorerUrl,
    chainedInputs, waitForBalance, fail, paren, STAKE_TICK, DEFAULT_STAKE_AMOUNT
}
const stakeValidator = createStakeValidator(operationHelpers)
const unstakeValidator = createUnstakeValidator(operationHelpers)

module.exports = {
    stakeValidator, unstakeValidator, planMints, stakeTiming, readChainState
}
