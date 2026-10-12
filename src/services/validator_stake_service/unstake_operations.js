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
 * XChain Node - Validator Unstake Operations
 ********************************************************************/

const { getLogger } = require('../../observability/logger')
// Reads /validators to the end: one unpaged read drops every stake past the newest 100 rows.
const { readValidatorSet } = require('./validator_set_read')
const { sumAmounts } = require('./free_key')
const { sendLockFor, releaseOnIndexWait } = require('./send_lock')
const { readAddressSleep, sleepRefusal, sleepUnknownRefusal } = require('./address_sleep')

function defaultLog() {
    const logger = getLogger()
    return logger.info.bind(logger)
}

function logUnstakePlan(log, pubkey, address, active, timing, STAKE_TICK, paren) {
    log('')
    log('Validator unstake plan')
    log('  signing pubkey : ' + pubkey)
    log('  stake address  : ' + address)
    if (!active) return

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
}

function logUnstakeSuccess(log, active, timing, coins, pubkey, STAKE_TICK, paren, explorerUrl) {
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
}

// An empty deactivation_block is a stake no UNSTAKE or ROLLCALL eviction has touched.
function isUndeactivated(row) {
    return row.deactivation_block === null || row.deactivation_block === undefined || row.deactivation_block === ''
}

// Sort rows as the indexer admits an UNSTAKE landing at landBlock: undeactivated AND activation_block <= landBlock.
// The explorer keeps status='valid' on deactivated rows, so status alone never means "active".
function classifyUnstakeRows(rows, landBlock) {
    const live = rows.filter(isUndeactivated)
    return {
        deactivated: rows.filter(r => !isUndeactivated(r)),
        admissible:  live.filter(r => Number(r.activation_block) <= landBlock),
        pending:     live.filter(r => !(Number(r.activation_block) <= landBlock))
    }
}

// The stake being withdrawn: the one admissible row as-is, or several summed, since the indexer withdraws them all.
function withdrawnStake(admissible) {
    if (admissible.length === 1) return admissible[0]
    // Sum in exact 1e-8 units; a float sum drifts and prints tiny totals as '1e-8'.
    const exact = sumAmounts(admissible)
    const total = admissible.reduce((s, r) => s + Number(r.amount), 0)
    return {
        amount: exact !== null ? exact : String(Math.round(total * 1e8) / 1e8),
        action_index: admissible.map(r => r.action_index).join(', '),
        activation_block: String(Math.max(...admissible.map(r => Number(r.activation_block))))
    }
}

// The explorer's indexed tip for the stake coin; unreadable means refuse, never guess.
async function readTip(sdk, coins, fail) {
    let tip
    try {
        const status = await sdk.explorer.getStatus()
        tip = Number(status && status.last_block && status.last_block[coins.stakeCoin])
    } catch (e) {
        throw fail('could not read the chain tip (' + e.message + '), so this run cannot tell ' +
                   'whether the stake is active yet. Nothing was sent.')
    }
    if (!Number.isInteger(tip) || tip < 0) {
        throw fail('the explorer reported no last block for ' + coins.stakeCoin + ', so this run cannot tell ' +
                   'whether the stake is active yet. Nothing was sent.')
    }
    return tip
}

// Refuse unless `address` owns every undeactivated row: the indexer rejects an UNSTAKE v0
// from any other SOURCE after its fee is spent, and matches the address exactly.
function assertOwnsStake(live, address, fail) {
    if (live.some(r => r.source === undefined || r.source === null || r.source === '')) {
        throw fail('the validator set does not say which address owns this stake, so this run cannot ' +
                   'confirm ' + address + ' may withdraw it. Nothing was sent.')
    }
    const owners = [...new Set(live.map(r => String(r.source)))].filter(o => o !== String(address))
    if (owners.length) {
        throw fail('this stake is owned by ' + owners.join(', ') + ', not ' + address + ', the address this run ' +
                   'signs with. The indexer rejects an UNSTAKE from any address but the owner, after the fee ' +
                   'is spent; run with the owning address\'s key. Nothing was sent.')
    }
}

// Refuse a partial exit: an UNSTAKE now withdraws only the active rows, and the indexer leaves these pending ones staked.
function pendingTopUpRefusal(pending, tip, STAKE_TICK) {
    const rows = pending.map(r => 'action ' + r.action_index + ' (' + r.amount + ' ' + STAKE_TICK +
        ', activates at block ' + r.activation_block + ')').join(', ')
    const from = Math.max(...pending.map(r => Number(r.activation_block)))
    return 'part of this stake is not active yet: ' + rows + '. An UNSTAKE now would withdraw only the active ' +
        'part, and the indexer leaves those rows staked, so this pubkey would stay in the active set once they ' +
        'activate. An UNSTAKE covering the whole stake can land from block ' + from + ' (the explorer is at block ' +
        tip + '). Re-run then. Nothing was sent.'
}

/**
 * Decide what an UNSTAKE would withdraw, before anything is sent. Returns
 * { active } when the indexer would admit one, or { done } with the result to
 * return when there is nothing to withdraw; throws when it would reject or not be a full exit.
 */
async function resolveUnstakeTarget({ sdk, coins, pubkey, address, timing, log, fail, paren, STAKE_TICK }) {
    // Read the set rather than a per-pubkey lookup (see readChainState): the
    // SDK exposes no getValidator, and a lookup failure must not read as
    // "nothing staked" when that is the very thing being acted on.
    let rows = []
    try {
        const v = await readValidatorSet(sdk)
        rows = ((v && v.data) || []).filter(r => r && r.status === 'valid' &&
            String(r.signing_pubkey || '').toLowerCase() === pubkey)
    } catch (e) {
        throw fail('could not read the validator set (' + e.message + '), so this run cannot tell ' +
                   'whether there is a stake to withdraw. Nothing was sent.')
    }

    if (!rows.length) {
        logUnstakePlan(log, pubkey, address, null, timing, STAKE_TICK, paren)
        log('')
        log('  This pubkey carries no valid stake. Nothing to withdraw.')
        log('')
        return { done: { unstaked: false, nothingStaked: true } }
    }

    // Stop when every row is already deactivated: the indexer rejects a second UNSTAKE.
    if (!rows.some(isUndeactivated)) {
        const deactivationBlock = Math.max(...rows.map(r => Number(r.deactivation_block)))
        const cooldownEndBlock = deactivationBlock - timing.activationBlocks + timing.cooldownBlocks
        logUnstakePlan(log, pubkey, address, null, timing, STAKE_TICK, paren)
        log('')
        log('  This stake is already withdrawn (an earlier UNSTAKE, or a ROLLCALL eviction).')
        log('  It drops out of the active set at block ' + deactivationBlock +
            ' and its cooldown ends at block ' + cooldownEndBlock + '. Nothing was sent.')
        log('')
        return { done: { unstaked: false, alreadyUnstaking: true, deactivationBlock, cooldownEndBlock } }
    }

    assertOwnsStake(rows.filter(isUndeactivated), address, fail)

    // The UNSTAKE lands no earlier than the next block, so that is the block admission is judged at.
    const tip = await readTip(sdk, coins, fail)
    const { admissible, pending } = classifyUnstakeRows(rows, tip + 1)
    if (!admissible.length) {
        const from = Math.min(...pending.map(r => Number(r.activation_block)))
        throw fail('this stake is not active yet: an UNSTAKE can land from block ' +
                   (Number.isFinite(from) ? from : '(unknown)') +
                   ' (the explorer is at block ' + tip + '). Re-run then. Nothing was sent.')
    }
    // The indexer's UNSTAKE leaves a pending top-up undeactivated, so it would activate later and keep this key in N.
    if (pending.length) throw fail(pendingTopUpRefusal(pending, tip, STAKE_TICK))
    await assertOwnerAwake(sdk, address, tip + 1, fail)
    return { active: withdrawnStake(admissible) }
}

// Refuse when the owning address is asleep at landBlock, or its sleep state cannot be read.
async function assertOwnerAwake(sdk, address, landBlock, fail) {
    const action = 'the UNSTAKE'
    let sleep
    try {
        sleep = await readAddressSleep(sdk, address, landBlock)
    } catch (e) {
        throw fail(sleepUnknownRefusal(e.message, address, action) + ' Nothing was sent.')
    }
    const refusal = sleepRefusal(sleep, address, action)
    if (refusal) throw fail(refusal + ' Nothing was sent.')
}

function createUnstakeValidator({
    openValidatorSession, stakeTiming, fail, paren, explorerUrl, STAKE_TICK
}) {
    /**
     * Run the unstake command: withdraw this validator's stake and leave the set.
     *
     * The counterpart to staking, and it matters more than it looks. Membership is
     * derived from chain stake alone, so a validator that has staked but is not
     * running COUNTS toward every capability's N while contributing nothing, which
     * raises the federation's quorum threshold (CapabilitySnapshot.getQuorum) and
     * puts a hub that cannot answer into publisher elections. Standing down is how
     * an operator stops being that.
     *
     * `deps.sendLock` ({ hold, release }) serializes a --broadcast run's send on the command lock.
     */
    return async function unstakeValidator(opts = {}, deps = {}) {
        const sendLock = sendLockFor(opts, deps)
        try {
            return await planAndUnstake(opts, deps, sendLock)
        } finally {
            sendLock.release()
        }
    }

    async function planAndUnstake(opts, deps, sendLock) {
        const log = deps.log || defaultLog()
        const { network, coins, pubkey, sdk, session, address } = openValidatorSession(opts, deps)
        const timing = stakeTiming(coins, network)

        // Take the lock before reading the stake, so no other broadcast sends between this read and this send.
        sendLock.hold()
        const target = await resolveUnstakeTarget({ sdk, coins, pubkey, address, timing, log, fail, paren, STAKE_TICK })
        if (target.done) return target.done
        const active = target.active

        logUnstakePlan(log, pubkey, address, active, timing, STAKE_TICK, paren)
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
        // Hand the command lock back once the UNSTAKE is broadcast and the SDK starts its indexer wait.
        const r = await session.submit({ action: 'UNSTAKE', params: { VERSION: 0, SIGNING_PUBKEY: pubkey } }, enc,
            { waitForIndexer: opts.wait !== false, timeout: timeoutMs, pollInterval: 15000,
                onProgress: releaseOnIndexWait(sendLock) })
        log('    txid ' + r.txid + (opts.wait !== false ? '  (indexed)' : '  (broadcast)'))
        logUnstakeSuccess(log, active, timing, coins, pubkey, STAKE_TICK, paren, explorerUrl)
        return { unstaked: true, txid: r.txid }
    }
}

module.exports = { createUnstakeValidator, classifyUnstakeRows }
