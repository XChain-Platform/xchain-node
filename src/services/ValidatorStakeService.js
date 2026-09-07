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
} = require('./ValidatorService')
const { getCoinConfigByFullName } = require('../coins')

const STAKE_TICK = 'XCHAIN'
// One stake that clears every capability floor at once (llm attestation
// provider is the highest at 25000); see the indexer's STAKING.CAPABILITIES.
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
 * the one the action lands in (xchain-indexer/src/actions/unstake.js:
 * deactivation_block = BLOCK_INDEX + ACTIVATION_DELAY_BLOCKS, COOLDOWN_END_BLOCK
 * = BLOCK_INDEX + COOLDOWN_BLOCKS):
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
    if (process.env.XCHAIN_NODE_STAKE_WIF) return process.env.XCHAIN_NODE_STAKE_WIF
    const typed = promptSecret('WIF for the stake wallet (input hidden): ')
    if (!typed) throw fail('no stake wallet. Run `xchain-node validator init`, or set XCHAIN_NODE_STAKE_WIF.')
    return typed
}

function num(x) {
    const n = Number(x)
    return Number.isFinite(n) ? n : 0
}

// Read everything the plan needs from the explorer. Split out so the
// broadcast path and the tests share one shape.
async function readChainState(sdk, address, pubkey) {
    const addr    = await sdk.explorer.getAddress(address)
    const coinBal = num(addr && addr.balances && addr.balances.confirmed)
    const coinPending = num(addr && addr.balances && addr.balances.pending)

    const bals = await sdk.getBalances(address)
    const row  = ((bals && bals.data) || []).find(b => b && b.tick === STAKE_TICK)
    const tokenBal = num(row && row.amount)

    const token = await sdk.explorer.getToken(STAKE_TICK)
    const mints = (token && token.mints) || {}

    // An existing stake on this pubkey means v1 would be rejected (the indexer
    // refuses a pubkey that already carries one); say so instead of spending.
    //
    // Read the SET and filter, rather than a per-pubkey lookup: the explorer
    // serves /validator/<pubkey>, but the SDK client exposes no method for it,
    // and calling one that does not exist throws a TypeError that a catch here
    // would turn into "no existing stake" - a reassuring null that green-lights
    // a duplicate STAKE. A failed read is reported, never silently treated as
    // an answer.
    let existing = null
    let existingUnknown = null
    try {
        const v = await sdk.explorer.getValidators()
        const rows = (v && v.data) || []
        existing = rows.find(r => r && r.status === 'valid' &&
            String(r.signing_pubkey || '').toLowerCase() === pubkey) || null
    } catch (e) {
        existingUnknown = e.message
    }

    return { coinBal, coinPending, tokenBal, mintMax: num(mints.max), mintAddressMax: num(mints.address_max), existing, existingUnknown }
}

// Plan the mints: how many transactions, at what amount each, to lift the
// balance to `amount`. Pure, so it is testable without a network.
function planMints(network, tokenBal, amount, mintMax, mintAddressMax) {
    const short = Math.max(0, amount - tokenBal)
    if (short === 0) return { short, mints: [], reason: null }
    if (network === 'mainnet') {
        return { short, mints: [], reason: 'XCHAIN is not mintable on mainnet: acquire ' + short + ' more and re-run.' }
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
    return (process.env.EXPLORER_URL || PUBLIC_EXPLORER).replace(/\/$/, '') + '/' + coins.stakeCoin + '/' + pathPart
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * The outputs of `prevTxid` that belong to this address, once the encoder can
 * see them. Seconds (mempool visibility), not a block.
 *
 * Handing these to the encoder as the ONLY candidate inputs is what lets the
 * whole run go out at once safely. The indexer resolves a STAKE's balance from
 * every ledger entry with a LOWER ACTION INDEX (`m.action_index < ?` in db.js
 * getAddressCreditDebit), and that index is global, so the mints count whether
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
        try { utxos = await sdk._requireEncoder().getUTXOs(address) } catch { /* transient; retry */ }
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

/**
 * Run the unstake command: withdraw this validator's stake and leave the set.
 *
 * The counterpart to staking, and it matters more than it looks. Membership is
 * derived from chain stake alone, so a validator that has staked but is not
 * running COUNTS toward every capability's N while contributing nothing, which
 * raises the federation's quorum threshold (CapabilitySnapshot.getQuorum) and
 * puts a hub that cannot answer into publisher elections. Standing down is how
 * an operator stops being that.
 */
async function unstakeValidator(opts = {}, deps = {}) {
    const log = deps.log || console.log
    const { network, coins, pubkey, sdk, session, address } = openValidatorSession(opts, deps)
    const timing = stakeTiming(coins, network)

    // Read the set rather than a per-pubkey lookup (see readChainState): the
    // SDK exposes no getValidator, and a lookup failure must not read as
    // "nothing staked" when that is the very thing being acted on.
    let active = null
    try {
        const v = await sdk.explorer.getValidators()
        active = ((v && v.data) || []).find(r => r && r.status === 'valid' &&
            String(r.signing_pubkey || '').toLowerCase() === pubkey) || null
    } catch (e) {
        throw fail('could not read the validator set (' + e.message + '), so this run cannot tell ' +
                   'whether there is a stake to withdraw. Nothing was sent.')
    }

    log('')
    log('Validator unstake plan')
    log('  signing pubkey : ' + pubkey)
    log('  stake address  : ' + address)

    if (!active) {
        log('')
        log('  This pubkey carries no valid stake. Nothing to withdraw.')
        log('')
        return { unstaked: false, nothingStaked: true }
    }

    log('  active stake   : ' + active.amount + ' ' + STAKE_TICK +
        ' (action ' + active.action_index + ', activated at block ' + active.activation_block + ')')
    log('')
    log('  Steps:')
    log('    UNSTAKE v0: withdraw the full stake for this pubkey')
    log('')
    // Two clocks, printed together on purpose. Leaving the active set and getting
    // the coins back are different events an order of magnitude or two apart, and
    // an operator told only the first one plans an hour and waits a week.
    log('  Two clocks start at the block this lands in, and they are far apart:')
    log('    active set: ' + timing.activationBlocks + ' more blocks' + paren(timing.activationFor) +
        '. Until then the stake keeps')
    log('                counting toward every capability; then it drops out.')
    log('    cooldown  : ' + timing.cooldownBlocks + ' blocks' + paren(timing.cooldownFor) +
        '. The ' + active.amount + ' ' + STAKE_TICK + ' stays locked')
    log('                until the cooldown sweep credits it back, and is NOT')
    log('                spendable before then.')

    if (!opts.broadcast) {
        log('')
        log('  Dry run: nothing sent. Re-run with --broadcast to withdraw.')
        log('')
        return { unstaked: false, dryRun: true, active }
    }

    const timeoutMin = Number(opts.timeout)
    const timeoutMs = (Number.isFinite(timeoutMin) && timeoutMin > 0 ? timeoutMin : 120) * 60 * 1000
    const enc = {}
    if (opts.feePerKb) enc.feePerKb = Number(opts.feePerKb)

    log('')
    log('  Sending UNSTAKE v0...')
    const r = await session.submit({ action: 'UNSTAKE', params: { VERSION: 0, SIGNING_PUBKEY: pubkey } }, enc,
        { waitForIndexer: opts.wait !== false, timeout: timeoutMs, pollInterval: 15000 })
    log('    txid ' + r.txid + (opts.wait !== false ? '  (indexed)' : '  (broadcast)'))
    log('')
    log('  Unstaked. You leave the active set ' + timing.activationBlocks + ' blocks' +
        paren(timing.activationFor) + ' after the block')
    log('  this landed in; until then the federation still counts you, which is why standing')
    log('  down is not instant.')
    log('  Your ' + active.amount + ' ' + STAKE_TICK + ' stays locked for ' + timing.cooldownBlocks +
        ' blocks' + paren(timing.cooldownFor) + ' from that same')
    log('  block, then the cooldown sweep credits it back and it is spendable. Do not plan')
    log('  around having it sooner.')
    log('  Watch it at ' + explorerUrl(coins, 'validator/' + pubkey))
    log('')
    return { unstaked: true, txid: r.txid }
}

/**
 * Run the stake command. `deps` lets tests inject an SDK factory and a
 * logger; production uses the real SDK and console.
 */
async function stakeValidator(opts = {}, deps = {}) {
    const log = deps.log || console.log
    const { network, coins, pubkey, sdk, session, address } = openValidatorSession(opts, deps)
    const amount = parseInt(opts.amount) || DEFAULT_STAKE_AMOUNT
    const timing = stakeTiming(coins, network)

    const state = await readChainState(sdk, address, pubkey)
    const plan  = planMints(network, state.tokenBal, amount, state.mintMax, state.mintAddressMax)

    log('')
    log('Validator stake plan (' + network + ')')
    log('  signing pubkey : ' + pubkey)
    log('  stake address  : ' + address)
    log('  ' + coins.stakeCoin.padEnd(15) + ': ' + state.coinBal + ' confirmed' +
        (state.coinPending ? ' (+' + state.coinPending + ' pending)' : '') + '  (pays the transaction fees)')
    log('  ' + STAKE_TICK.padEnd(15) + ': ' + state.tokenBal + ' held, ' + amount + ' to stake' +
        (plan.short ? ', short ' + plan.short : ''))
    if (state.mintMax) log('  faucet caps    : ' + state.mintMax + ' per MINT, ' + (state.mintAddressMax || 'no') + ' per address')

    if (state.existing) {
        log('')
        log('  This pubkey already carries a valid STAKE of ' + state.existing.amount +
            ' (action ' + state.existing.action_index + ', activates at block ' + state.existing.activation_block + ').')
        log('  Nothing to do. Check it at ' + explorerUrl(coins, 'validator/' + pubkey))
        log('')
        return { staked: false, existing: state.existing }
    }

    if (state.existingUnknown) {
        log('')
        log('  WARNING: could not read the validator set (' + state.existingUnknown + '),')
        log('  so this run cannot tell whether the pubkey is already staked. Check')
        log('  ' + explorerUrl(coins, 'validator/' + pubkey) + ' before broadcasting.')
    }

    const steps = plan.mints.map((a, i) => 'MINT ' + (i + 1) + '/' + plan.mints.length + ': ' + a + ' ' + STAKE_TICK)
    steps.push('STAKE v1: ' + amount + ' ' + STAKE_TICK + ' to ' + pubkey)
    log('')
    log('  Steps:')
    for (const s of steps) log('    ' + s)

    // The exit cost, stated before the money moves rather than after. Getting the
    // stake back is the cooldown clock, not the activation clock, and it is the
    // one that decides whether this XCHAIN is reachable next week.
    log('')
    log('  The ' + amount + ' ' + STAKE_TICK + ' is escrowed for as long as you stay staked. Standing down')
    log('  later frees it only after a cooldown of ' + timing.cooldownBlocks + ' blocks' +
        paren(timing.cooldownFor) + ', on top of the')
    log('  ' + timing.activationBlocks + ' blocks it takes to leave the active set. Do not stake ' +
        STAKE_TICK + ' you may')
    log('  need before then.')

    const blockers = []
    if (plan.reason) blockers.push(plan.reason)
    if (state.coinBal <= 0) blockers.push('no confirmed ' + coins.stakeCoin + ' at ' + address + ' to pay fees; fund it first.')
    if (blockers.length) {
        log('')
        for (const b of blockers) log('  BLOCKED: ' + b)
        log('')
        return { staked: false, plan, blockers }
    }

    if (!opts.broadcast) {
        log('')
        log('  Dry run: nothing sent. Re-run with --broadcast to send the ' + steps.length + ' transaction(s) above.')
        log('  They go out back to back, each funded by the one before it, so the run confirms in the')
        log('  next block or two rather than costing a block per step. (--serialize sends them a block')
        log('  apart instead.)')
        log('')
        return { staked: false, plan, dryRun: true }
    }

    // Long waits, deliberately: the indexer sees an action only once its block
    // is mined, and a testnet block can take twenty minutes. Parsed as a real
    // number rather than an integer, because parseInt('0.5') is 0, which would
    // silently fall through to the 120-minute default for every sub-minute
    // value instead of honouring it.
    const timeoutMin = Number(opts.timeout)
    const timeoutMs = (Number.isFinite(timeoutMin) && timeoutMin > 0 ? timeoutMin : 120) * 60 * 1000
    const baseEncoder = {}
    if (opts.feePerKb) baseEncoder.feePerKb = Number(opts.feePerKb)

    // Every action is sent back to back and funded from the one before it, so
    // the whole run lands in a single block (see chainedInputs). --serialize
    // restores the old one-action-per-block behaviour, which costs a block per
    // step and is only worth it if chaining ever misbehaves on a venue.
    const chain = !opts.serialize
    const sent = []
    let prevTxid = null
    let chainBroken = false

    async function send(kind, params, isLast) {
        const enc = Object.assign({}, baseEncoder)
        if (chain && prevTxid) {
            const inputs = await chainedInputs(sdk, address, prevTxid, opts.chainTimeoutMs)
            if (inputs) enc.utxos = inputs
            else {
                // Nothing spendable came back from the previous transaction, so
                // the ordering guarantee is gone. Say so rather than broadcast a
                // STAKE that a miner may place ahead of its own funding.
                chainBroken = true
                log('    (no spendable output from ' + prevTxid.slice(0, 16) + '..., cannot chain)')
            }
        }
        // Only the final action waits for the indexer: the ones before it are
        // ordered by the funding chain, so waiting on them buys nothing but a
        // block of latency.
        const wait = isLast && opts.wait !== false
        const r = await session.submit({ action: kind, params }, enc,
            { waitForIndexer: wait, timeout: timeoutMs, pollInterval: 15000 })
        if (chain && prevTxid && !(r.spentInputs || []).some(i => i.txid === prevTxid)) chainBroken = true
        prevTxid = r.txid
        sent.push({ step: kind, txid: r.txid })
        log('    txid ' + r.txid + (wait ? '  (indexed)' : '  (broadcast)'))
        return r
    }

    for (let i = 0; i < plan.mints.length; i++) {
        log('')
        log('  Sending MINT ' + (i + 1) + '/' + plan.mints.length + ' (' + plan.mints[i] + ' ' + STAKE_TICK + ')...')
        await send('MINT', { VERSION: 0, TICK: STAKE_TICK, AMOUNT: String(plan.mints[i]) }, opts.serialize === true)
    }

    // A broken chain means in-block order is the miner's choice, and a STAKE
    // evaluated before its own mints is rejected for insufficient funds. Wait
    // the mints out instead: once they are indexed, ordering stops mattering.
    if (plan.mints.length && (chainBroken || opts.serialize)) {
        log('')
        log('  Waiting for the mints to be indexed before staking' +
            (chainBroken ? ' (the funding chain broke, so in-block order is not guaranteed)' : '') + '...')
        const ok = await waitForBalance(sdk, address, amount, timeoutMs, log, opts.balancePollMs)
        if (!ok) {
            log('')
            log('  The mints have not indexed within the timeout. They are broadcast and will confirm;')
            log('  re-run this command to send the STAKE once they do.')
            log('')
            return { staked: false, sent, pendingMints: true }
        }
        prevTxid = null   // fund the STAKE freely; ordering no longer matters
    }

    log('')
    log('  Sending STAKE v1 (' + amount + ' ' + STAKE_TICK + ' to ' + pubkey + ')...')
    const r = await send('STAKE', { VERSION: 1, AMOUNT: String(amount), SIGNING_PUBKEY: pubkey }, true)
    log('')
    if (opts.wait === false) {
        log('  Broadcast. Watch it land at ' + explorerUrl(coins, 'validator/' + pubkey))
    } else {
        log('  Staked. The stake activates ' + timing.activationBlocks + ' blocks' + paren(timing.activationFor) +
            ' after it is indexed; peers')
        log('  admit you on their next signer-set refresh after that.')
        log('  Watch it at ' + explorerUrl(coins, 'validator/' + pubkey))
    }
    log('  Next: xchain-node install master xchain-hub')
    log('')
    return { staked: true, sent, txid: r.txid, chained: chain && !chainBroken }
}

module.exports = {
    stakeValidator, unstakeValidator, planMints, stakeTiming
}
