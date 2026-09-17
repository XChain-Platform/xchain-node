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

function logStakeBalances(log, network, coins, pubkey, address, amount, state, plan, STAKE_TICK) {
    log('')
    log('Validator stake plan (' + network + ')')
    log('  signing pubkey : ' + pubkey)
    log('  stake address  : ' + address)
    log('  ' + coins.stakeCoin.padEnd(15) + ': ' + state.coinBal + ' confirmed' +
        (state.coinPending ? ' (+' + state.coinPending + ' pending)' : '') + '  (pays the transaction fees)')
    log('  ' + STAKE_TICK.padEnd(15) + ': ' + state.tokenBal + ' held, ' + amount + ' to stake' +
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
    if (state.coinBal <= 0) blockers.push('no confirmed ' + coins.stakeCoin + ' at ' + address + ' to pay fees; fund it first.')
    return blockers
}

async function sendStakeAction(context, progress, kind, params, isLast) {
    const { sdk, session, address, opts, log, timeoutMs, baseEncoder, chainedInputs } = context
    const enc = Object.assign({}, baseEncoder)
    if (progress.chain && progress.prevTxid) {
        const inputs = await chainedInputs(sdk, address, progress.prevTxid, opts.chainTimeoutMs)
        if (inputs) enc.utxos = inputs
        else {
            // Nothing spendable came back from the previous transaction, so
            // the ordering guarantee is gone. Say so rather than broadcast a
            // STAKE that a miner may place ahead of its own funding.
            progress.chainBroken = true
            log('    (no spendable output from ' + progress.prevTxid.slice(0, 16) + '..., cannot chain)')
        }
    }
    // Only the final action waits for the indexer: the ones before it are
    // ordered by the funding chain, so waiting on them buys nothing but a
    // block of latency.
    const wait = isLast && opts.wait !== false
    const r = await session.submit({ action: kind, params }, enc,
        { waitForIndexer: wait, timeout: timeoutMs, pollInterval: 15000 })
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
        await sendStakeAction(context, progress, 'MINT',
            { VERSION: 0, TICK: STAKE_TICK, AMOUNT: String(plan.mints[i]) }, opts.serialize === true)
    }

    // A broken chain means in-block order is the miner's choice, and a STAKE
    // evaluated before its own mints is rejected for insufficient funds. Wait
    // the mints out instead: once they are indexed, ordering stops mattering.
    if (plan.mints.length && (progress.chainBroken || opts.serialize)) {
        log('')
        log('  Waiting for the mints to be indexed before staking' +
            (progress.chainBroken ? ' (the funding chain broke, so in-block order is not guaranteed)' : '') + '...')
        const ok = await waitForBalance(sdk, address, amount, context.timeoutMs, log, opts.balancePollMs)
        if (!ok) {
            log('')
            log('  The mints have not indexed within the timeout. They are broadcast and will confirm;')
            log('  re-run this command to send the STAKE once they do.')
            log('')
            return { staked: false, sent: progress.sent, pendingMints: true }
        }
        progress.prevTxid = null   // fund the STAKE freely; ordering no longer matters
    }

    return finishStake(context, progress)
}

async function finishStake(context, progress) {
    const { opts, coins, pubkey, amount, log, timing, explorerUrl, STAKE_TICK, paren } = context
    log('')
    log('  Sending STAKE v1 (' + amount + ' ' + STAKE_TICK + ' to ' + pubkey + ')...')
    const r = await sendStakeAction(context, progress, 'STAKE',
        { VERSION: 1, AMOUNT: String(amount), SIGNING_PUBKEY: pubkey }, true)
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

function createStakeValidator(helpers) {
    const { openValidatorSession, stakeTiming, readChainState, planMints, explorerUrl,
        chainedInputs, waitForBalance, paren, STAKE_TICK, DEFAULT_STAKE_AMOUNT } = helpers

    /**
     * Run the stake command. `deps` lets tests inject an SDK factory and a
     * logger; production uses the real SDK and console.
     */
    return async function stakeValidator(opts = {}, deps = {}) {
        const log = deps.log || console.log
        const { network, coins, pubkey, sdk, session, address } = openValidatorSession(opts, deps)
        const amount = parseInt(opts.amount) || DEFAULT_STAKE_AMOUNT
        const timing = stakeTiming(coins, network)
        const state = await readChainState(sdk, address, pubkey)
        const plan = planMints(network, state.tokenBal, amount, state.mintMax, state.mintAddressMax)

        logStakeBalances(log, network, coins, pubkey, address, amount, state, plan, STAKE_TICK)
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

        const steps = logStakeSteps(log, amount, pubkey, plan, timing, STAKE_TICK, paren)
        const blockers = stakeBlockers(state, plan, coins, address)
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

        return broadcastStake({ opts, sdk, session, address, coins, pubkey, amount, plan, log, timing,
            explorerUrl, chainedInputs, waitForBalance, paren, STAKE_TICK })
    }
}

module.exports = { createStakeValidator }
