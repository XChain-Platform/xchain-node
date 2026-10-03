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
 * XChain Node - Validator Stake Operations
 ********************************************************************/

const { getLogger } = require('../../observability/logger')
const { sendLockFor, releaseOnIndexWait, holdForSend } = require('./send_lock')

function defaultLog() {
    const logger = getLogger()
    return logger.info.bind(logger)
}

function logStakeBalances(log, network, coins, pubkey, address, amount, state, plan, STAKE_TICK) {
    log('')
    log('Validator stake plan (' + network + ')')
    log('  signing pubkey : ' + pubkey)
    log('  stake address  : ' + address)
    // Print an unreadable native balance as unavailable, never as a number.
    const coinLine = state.coinBal === null
        ? 'unavailable (the explorer could not read it from its UTXO tracker)'
        : state.coinBal + ' confirmed' + (state.coinPending ? ' (+' + state.coinPending + ' pending)' : '')
    log('  ' + coins.stakeCoin.padEnd(15) + ': ' + coinLine + '  (pays the transaction fees)')
    const tokenHeld = state.tokenBal === null ? 'unavailable (balance list read incomplete)' : state.tokenBal + ' held'
    log('  ' + STAKE_TICK.padEnd(15) + ': ' + tokenHeld + ', ' + amount + ' to stake' +
        (plan.short ? ', short ' + plan.short : ''))
    if (state.mintMax) log('  faucet caps    : ' + state.mintMax + ' per MINT, ' + (state.mintAddressMax || 'no') + ' per address')
}

function logStakeSteps(log, amount, pubkey, plan, timing, STAKE_TICK, paren) {
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
    return steps
}

function stakeBlockers(state, plan, coins, address) {
    const blockers = []
    if (plan.reason) blockers.push(plan.reason)
    // Refuse when the fee balance is unreadable, and say it is an outage rather than an empty address.
    if (state.coinBal === null) {
        blockers.push('the ' + coins.stakeCoin + ' balance at ' + address + ' is unavailable (the explorer\'s UTXO ' +
            'tracker did not answer), so this run cannot confirm it can pay fees. Retry, or check the explorer; ' +
            'this does not mean the address is unfunded.')
    } else if (state.coinBal <= 0) {
        blockers.push('no confirmed ' + coins.stakeCoin + ' at ' + address + ' to pay fees; fund it first.')
    }
    // Refuse when the delegation check could not run: the indexer rejects a STAKE on a
    // delegated key only after every MINT fee is spent, so an unknown is not a pass.
    if (state.delegationUnknown) {
        blockers.push('could not confirm this signing pubkey is not delegated (' + state.delegationUnknown + '). ' +
            'An explorer that predates the /delegations/<pubkey>/pubkey lookup cannot answer it, and ' +
            'nothing is sent until one can.')
    }
    // Refuse when the validator set is unreadable: the indexer rejects a STAKE v1 on a key
    // holding any stake row only after every MINT fee is spent, so an unknown is not a pass.
    if (state.existingUnknown) {
        blockers.push('could not read the validator set (' + state.existingUnknown + '), so this run cannot ' +
            'confirm the signing pubkey is not already staked. Nothing is sent until the set can be read; ' +
            'retry, or check the explorer.')
    }
    return blockers
}

// Why a key held only by withdrawn stake cannot be staked yet, in the operator's terms.
function heldKeyReason(judged, timing) {
    if (judged.tipError) {
        return 'could not read the chain tip (' + judged.tipError + '), so this run cannot tell whether the key has been released.'
    }
    if (judged.reuseHeight === null) {
        return 'this network does not yet release a signing key that has staked; stake under a new signing key.'
    }
    if (!judged.reuseActive) {
        return 'this network releases a withdrawn key only from block ' + judged.reuseHeight +
            ' (the explorer is at block ' + judged.tipBlock + '); re-run then, or stake under a new signing key.'
    }
    if (judged.freeFromBlock === null) {
        return 'a stake row for it has no readable deactivation block, so this run cannot tell when the key is released.'
    }
    return 'its ' + timing.cooldownBlocks + '-block cooldown still holds the key; a new STAKE on it is admitted from block ' +
        judged.freeFromBlock + ' (the explorer is at block ' + judged.tipBlock + '). Re-run then.'
}

// Say why the pubkey is not free for a STAKE v1, naming the stake or delegation holding it.
function logKeyHeld(log, state, ctx) {
    const { coins, pubkey, timing, explorerUrl, STAKE_TICK } = ctx
    log('')
    if (state.existing) {
        const judged = state.stakeJudgement
        if (judged.liveCount > 0) {
            const amount = judged.liveAmount === null ? '' : ' of ' + judged.liveAmount + ' ' + STAKE_TICK
            log('  This pubkey already carries a valid STAKE' + amount +
                ' (newest action ' + state.existing.action_index + ', activates at block ' + state.existing.activation_block + ').')
            log('  Nothing to do. Check it at ' + explorerUrl(coins, 'validator/' + pubkey))
        } else {
            log('  This pubkey\'s stake is withdrawn (an UNSTAKE or a ROLLCALL eviction), but the key is not free')
            log('  for a new STAKE: ' + heldKeyReason(judged, timing) + ' Nothing was sent.')
        }
    } else {
        const d = state.delegated[state.delegated.length - 1]
        log('  This pubkey is held by a delegation (action ' + d.action_index + ' from ' + d.source + '), so the indexer')
        log('  would reject a STAKE on it as already delegated. Revoke the delegation, or stake under a')
        log('  new signing key. Nothing was sent.')
    }
    log('')
}

// The previous transaction's outputs for the next action to spend, or null
// when there is no chain to extend or the link could not be formed.
async function linkInputs(context, progress) {
    const { sdk, address, opts, log, chainedInputs } = context
    if (!(progress.chain && progress.prevTxid)) return null
    const inputs = await chainedInputs(sdk, address, progress.prevTxid, opts.chainTimeoutMs)
    if (!inputs) {
        // Nothing spendable came back from the previous transaction, so the
        // ordering guarantee is gone. Say so; broadcastStake then waits the
        // mints out rather than send a STAKE a miner may place ahead of them.
        progress.chainBroken = true
        log('    (no spendable output from ' + progress.prevTxid.slice(0, 16) + '..., cannot chain)')
    }
    return inputs
}

// Submit one action, funded from `inputs` when the funding chain supplied them.
async function sendStakeAction(context, progress, kind, params, isLast, inputs) {
    const { session, opts, log, timeoutMs, baseEncoder, sendLock } = context
    const enc = Object.assign({}, baseEncoder)
    if (inputs) enc.utxos = inputs
    // Only the final action waits for the indexer: the ones before it are
    // ordered by the funding chain, so waiting on them buys nothing but a
    // block of latency.
    const wait = isLast && opts.wait !== false
    // Hold the command lock while this action is sent; the SDK's indexer wait hands it back.
    holdForSend(sendLock, progress.sent, kind)
    const r = await session.submit({ action: kind, params }, enc,
        { waitForIndexer: wait, timeout: timeoutMs, pollInterval: 15000, onProgress: releaseOnIndexWait(sendLock) })
    if (progress.chain && progress.prevTxid && !(r.spentInputs || []).some(i => i.txid === progress.prevTxid)) {
        progress.chainBroken = true
    }
    progress.prevTxid = r.txid
    progress.sent.push({ step: kind, txid: r.txid })
    log('    txid ' + r.txid + (wait ? '  (indexed)' : '  (broadcast)'))
    return r
}

async function broadcastStake(context) {
    const { opts, sdk, address, amount, plan, log, waitForBalance, STAKE_TICK } = context
    // Long waits, deliberately: the indexer sees an action only once its block
    // is mined, and a testnet block can take twenty minutes. Parsed as a real
    // number rather than an integer, because parseInt('0.5') is 0, which would
    // silently fall through to the 120-minute default for every sub-minute
    // value instead of honouring it.
    const timeoutMin = Number(opts.timeout)
    context.timeoutMs = (Number.isFinite(timeoutMin) && timeoutMin > 0 ? timeoutMin : 120) * 60 * 1000
    context.baseEncoder = {}
    if (opts.feePerKb) context.baseEncoder.feePerKb = Number(opts.feePerKb)

    // Every action is sent back to back and funded from the one before it, so
    // the whole run lands in a single block (see chainedInputs). --serialize
    // restores the old one-action-per-block behaviour, which costs a block per
    // step and is only worth it if chaining ever misbehaves on a venue.
    const progress = { chain: !opts.serialize, sent: [], prevTxid: null, chainBroken: false }
    for (let i = 0; i < plan.mints.length; i++) {
        log('')
        log('  Sending MINT ' + (i + 1) + '/' + plan.mints.length + ' (' + plan.mints[i] + ' ' + STAKE_TICK + ')...')
        const inputs = await linkInputs(context, progress)
        await sendStakeAction(context, progress, 'MINT',
            { VERSION: 0, TICK: STAKE_TICK, AMOUNT: String(plan.mints[i]) }, opts.serialize === true, inputs)
    }

    // Form the STAKE's own link to the last mint BEFORE deciding whether to
    // wait: a miss on this final hop breaks the ordering exactly as a miss
    // between mints does, and must reach the same wait below.
    const stakeInputs = progress.chainBroken ? null : await linkInputs(context, progress)

    // A broken chain means in-block order is the miner's choice, and a STAKE
    // evaluated before its own mints is rejected for insufficient funds. Wait
    // the mints out instead: once they are indexed, ordering stops mattering.
    if (plan.mints.length && (progress.chainBroken || opts.serialize)) {
        log('')
        log('  Waiting for the mints to be indexed before staking' +
            (progress.chainBroken ? ' (the funding chain broke, so in-block order is not guaranteed)' : '') + '...')
        // Hand the lock back for the wait; the STAKE takes it again before it is sent.
        context.sendLock.release()
        const ok = await waitForBalance(sdk, address, amount, context.timeoutMs, log, opts.balancePollMs)
        if (!ok) {
            log('')
            log('  The mints have not indexed within the timeout. They are broadcast and will confirm;')
            log('  re-run this command to send the STAKE once they do.')
            log('')
            return { staked: false, sent: progress.sent, pendingMints: true }
        }
        progress.prevTxid = null   // fund the STAKE freely; ordering no longer matters
        return finishStake(context, progress, null)
    }

    return finishStake(context, progress, stakeInputs)
}

async function finishStake(context, progress, stakeInputs) {
    const { opts, coins, pubkey, amount, log, timing, explorerUrl, STAKE_TICK, paren } = context
    log('')
    log('  Sending STAKE v1 (' + amount + ' ' + STAKE_TICK + ' to ' + pubkey + ')...')
    const r = await sendStakeAction(context, progress, 'STAKE',
        { VERSION: 1, AMOUNT: String(amount), SIGNING_PUBKEY: pubkey }, true, stakeInputs)
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
    return { staked: true, sent: progress.sent, txid: r.txid, chained: progress.chain && !progress.chainBroken }
}

// Resolve --amount: the default only when it is absent, else whole XCHAIN above 0, refused rather than coerced.
// Whole units only: the mint split is float arithmetic, so a fractional shortfall would send malformed MINT amounts.
function resolveStakeAmount(raw, DEFAULT_STAKE_AMOUNT, fail, STAKE_TICK) {
    if (raw === undefined || raw === null) return DEFAULT_STAKE_AMOUNT
    const text = String(raw).trim()
    const amount = Number(text)
    if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(amount) || amount <= 0) {
        throw fail('--amount must be a whole number of ' + STAKE_TICK + ' above 0, such as 25000 (got "' + raw +
                   '"). Nothing was sent.')
    }
    return amount
}

// Say that a dry run sent nothing and how --broadcast would send the steps.
function logDryRun(log, stepCount) {
    log('')
    log('  Dry run: nothing sent. Re-run with --broadcast to send the ' + stepCount + ' transaction(s) above.')
    log('  They go out back to back, each funded by the one before it, so the run confirms in the')
    log('  next block or two rather than costing a block per step. (--serialize sends them a block')
    log('  apart instead.)')
    log('')
}

function createStakeValidator(helpers) {
    const { openValidatorSession, stakeTiming, readChainState, planMints, explorerUrl,
        chainedInputs, waitForBalance, fail, paren, STAKE_TICK, DEFAULT_STAKE_AMOUNT } = helpers

    /**
     * Run the stake command. `deps` lets tests inject an SDK factory and a
     * logger; production uses the real SDK and service logger. `deps.sendLock`
     * ({ hold, release }) serializes a --broadcast run's sends on the command lock.
     */
    return async function stakeValidator(opts = {}, deps = {}) {
        const sendLock = sendLockFor(opts, deps)
        try {
            return await planAndStake(opts, deps, sendLock)
        } finally {
            sendLock.release()
        }
    }

    async function planAndStake(opts, deps, sendLock) {
        const log = deps.log || defaultLog()
        // Before the session opens, so a bad amount refuses ahead of any WIF prompt or chain read.
        const amount = resolveStakeAmount(opts.amount, DEFAULT_STAKE_AMOUNT, fail, STAKE_TICK)
        const { network, coins, pubkey, sdk, session, address } = openValidatorSession(opts, deps)
        const timing = stakeTiming(coins, network)
        // Take the lock before reading the plan, so no other broadcast sends between this read and these sends.
        sendLock.hold()
        const state = await readChainState(sdk, address, pubkey, { network, coins, cooldownBlocks: timing.cooldownBlocks })
        const plan = planMints(network, state.tokenBal, amount, state.mintMax, state.mintAddressMax, state.mintUnreadable)

        logStakeBalances(log, network, coins, pubkey, address, amount, state, plan, STAKE_TICK)
        if (state.existing || state.delegated) {
            logKeyHeld(log, state, { coins, pubkey, timing, explorerUrl, STAKE_TICK })
            return state.existing
                ? { staked: false, existing: state.existing }
                : { staked: false, delegated: state.delegated }
        }
        const steps = logStakeSteps(log, amount, pubkey, plan, timing, STAKE_TICK, paren)
        const blockers = stakeBlockers(state, plan, coins, address)
        if (blockers.length) {
            log('')
            for (const b of blockers) log('  BLOCKED: ' + b)
            log('')
            return { staked: false, plan, blockers }
        }
        if (!opts.broadcast) {
            logDryRun(log, steps.length)
            return { staked: false, plan, dryRun: true }
        }

        return broadcastStake({ opts, sdk, session, address, coins, pubkey, amount, plan, log, timing,
            explorerUrl, chainedInputs, waitForBalance, paren, STAKE_TICK, sendLock })
    }
}

module.exports = { createStakeValidator, stakeBlockers, logStakeBalances }
