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
     */
    return async function unstakeValidator(opts = {}, deps = {}) {
        const log = deps.log || defaultLog()
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

        logUnstakePlan(log, pubkey, address, active, timing, STAKE_TICK, paren)
        if (!active) {
            log('')
            log('  This pubkey carries no valid stake. Nothing to withdraw.')
            log('')
            return { unstaked: false, nothingStaked: true }
        }
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
        logUnstakeSuccess(log, active, timing, coins, pubkey, STAKE_TICK, paren, explorerUrl)
        return { unstaked: true, txid: r.txid }
    }
}

module.exports = { createUnstakeValidator }
