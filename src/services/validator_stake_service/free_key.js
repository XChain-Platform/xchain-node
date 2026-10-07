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
 * XChain Node - Validator Stake Free-Key Check
 *
 * Whether a STAKE v1 naming this signing pubkey would be admitted, judged the
 * way the indexer's validateFreeKey judges it
 * (xchain-indexer/src/actions/stake/capability_stake.js), so the CLI refuses
 * before any MINT fee is spent rather than after the STAKE is rejected:
 *   - a stakes row holds the key; once stake_key_reuse_activation is armed,
 *     a row that is deactivated AND past cooldown no longer does
 *     (active_stake.js reuseBlockingOnly);
 *   - a valid delegation holds the key until its deactivation_block has
 *     passed (delegations getDelegationByPubkey): 'already delegated'.
 * The CLI only reads these rules; consensus stays in the indexer.
 ********************************************************************/

const { readValidatorSet } = require('./validator_set_read')

// stake_key_reuse_activation heights, a read-only mirror of the indexer's
// gate row (xchain-indexer/src/protocol_changes/gates_3.js). The unit suite
// holds this copy to that row whenever the sibling checkout is present.
const STAKE_KEY_REUSE_ACTIVATION = Object.freeze({
    'BTC:mainnet':  null,
    'LTC:mainnet':  null,
    'DOGE:mainnet': null,
    mainnet:        null,
    'BTC:testnet':  156000,
    'LTC:testnet':  4897000,
    'DOGE:testnet': 67920000,
    testnet:        null,
    regtest:        0
})

// The coin a stake chain's full name stands for, as the indexer keys its gates.
const COIN_BY_FULL_NAME = Object.freeze({ bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' })

// The explorer's per-method row cap, and the OFFSET ceiling that bounds a sweep.
const PAGE_LIMIT = 100
const MAX_PAGES = 1001

// XCHAIN amounts carry at most 8 decimals, so sums are exact in 1e-8 units.
const UNIT_DIGITS = 8

/**
 * The reuse gate's height for this network and coin, resolved as the indexer
 * resolves it: '<COIN>:<network>' first, then the bare network. Null is inert.
 */
function stakeKeyReuseHeight(network, coin) {
    const own = (k) => Object.prototype.hasOwnProperty.call(STAKE_KEY_REUSE_ACTIVATION, k)
    const key = coin && own(coin + ':' + network) ? coin + ':' + network : network
    const height = own(key) ? STAKE_KEY_REUSE_ACTIVATION[key] : null
    return Number.isInteger(height) ? height : null
}

// The coin the indexer names this stake chain by ('bitcoin-testnet' is BTC).
function stakeCoin(coins) {
    return COIN_BY_FULL_NAME[String(coins.stake).split('-')[0]] || null
}

// An empty deactivation_block is a row no UNSTAKE, REVOKE or eviction has touched.
function isUndeactivated(row) {
    return row.deactivation_block === null || row.deactivation_block === undefined || row.deactivation_block === ''
}

// The deactivation block as a number, or null when it is missing or not an integer.
function deactivationBlock(row) {
    if (isUndeactivated(row)) return null
    const n = Number(row.deactivation_block)
    return Number.isInteger(n) ? n : null
}

/**
 * The stakes rows that still hold the key for a STAKE landing at landBlock.
 * Before the gate every valid row holds it forever; after it, a row stops
 * holding once deactivation_block + cooldownBlocks <= landBlock. A row whose
 * deactivation block cannot be read keeps holding, the refusing side.
 */
function stakeRowsHoldingKey(rows, { reuseActive, landBlock, cooldownBlocks }) {
    if (!reuseActive) return rows.slice()
    return rows.filter(r => {
        const d = deactivationBlock(r)
        if (isUndeactivated(r) || d === null) return true
        return !(d + cooldownBlocks <= landBlock)
    })
}

/**
 * The delegation rows that hold the key for a STAKE landing at landBlock:
 * valid, and not yet deactivated at that block. A pending-activation
 * delegation holds it too. With no landBlock known, any deactivated row
 * still holds, the refusing side.
 */
function delegationRowsHoldingKey(rows, landBlock) {
    return rows.filter(r => {
        if (!r || r.status !== 'valid') return false
        if (isUndeactivated(r)) return true
        const d = deactivationBlock(r)
        return d === null || !Number.isInteger(landBlock) || d > landBlock
    })
}

// One decimal amount string as 1e-8 units, or null when it is not a plain decimal.
function toUnits(amount) {
    const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(String(amount).trim())
    if (!m) return null
    return BigInt(m[1]) * (10n ** BigInt(UNIT_DIGITS)) + BigInt((m[2] || '').padEnd(UNIT_DIGITS, '0'))
}

/**
 * The exact decimal sum of the rows' amounts, trailing zeros trimmed, or null
 * when any amount is not a plain decimal (so nothing false is printed).
 */
function sumAmounts(rows) {
    let total = 0n
    for (const r of rows) {
        const u = toUnits(r && r.amount)
        if (u === null) return null
        total += u
    }
    const scale = 10n ** BigInt(UNIT_DIGITS)
    const frac = (total % scale).toString().padStart(UNIT_DIGITS, '0').replace(/0+$/, '')
    return (total / scale).toString() + (frac ? '.' + frac : '')
}

// The explorer's indexed tip for the stake chain; throws when it is unreadable.
async function readTip(sdk, coins) {
    const status = await sdk.explorer.getStatus()
    const tip = Number(status && status.last_block && status.last_block[coins.stakeCoin])
    if (!Number.isInteger(tip) || tip < 0) throw new Error('the explorer reported no last block for ' + coins.stakeCoin)
    return tip
}

// Memoize readTip so the stake and delegation judgements share one read.
function tipOnce(sdk, coins) {
    let pending = null
    return () => (pending = pending || readTip(sdk, coins))
}

/**
 * Every delegation row the explorer holds for this signing pubkey, paged to
 * the end. Throws on anything short of a complete answer, including an
 * explorer that predates the pubkey lookup, so a failure never reads as
 * "not delegated".
 */
async function readDelegationsByPubkey(sdk, pubkey) {
    if (!sdk.explorer || typeof sdk.explorer.getDelegations !== 'function') {
        throw new Error('this SDK has no getDelegations')
    }
    const rows = []
    for (let page = 1; ; page++) {
        if (page > MAX_PAGES) throw new Error('delegation read incomplete: more than ' + (MAX_PAGES * PAGE_LIMIT) + ' rows')
        const v = await sdk.explorer.getDelegations(pubkey, 'pubkey', { page, limit: PAGE_LIMIT, sortorder: 'ASC' })
        if (!v || !Array.isArray(v.data)) throw new Error('the delegation lookup by pubkey returned no row list')
        rows.push(...v.data)
        const total = Number(v.total)
        const known = v.total !== undefined && v.total !== null && Number.isInteger(total) && total >= 0
        if (known ? rows.length >= total : v.data.length < PAGE_LIMIT) break
        if (!v.data.length) throw new Error('delegation read incomplete: saw ' + rows.length + ' of ' + total + ' rows')
    }
    return rows.filter(r => r && String(r.signing_pubkey || '').toLowerCase() === pubkey)
}

/**
 * Judge this pubkey's stakes rows: which still hold it, and, when the key is
 * held only by withdrawn stake, why. `landBlock` is the explorer tip + 1, the
 * earliest block a STAKE sent now can land in.
 */
async function judgeStakeRows(rows, { network, coins, cooldownBlocks, tip }) {
    const reuseHeight = stakeKeyReuseHeight(network, stakeCoin(coins))
    const judged = { reuseHeight, reuseActive: false, tipBlock: null, tipError: null }
    // The gate can only free a key whose every row is withdrawn, so only then is the tip worth reading.
    if (reuseHeight !== null && rows.every(r => !isUndeactivated(r))) {
        try {
            judged.tipBlock = await tip()
            judged.reuseActive = judged.tipBlock + 1 >= reuseHeight
        } catch (e) {
            judged.tipError = e.message
        }
    }
    const landBlock = judged.tipBlock === null ? null : judged.tipBlock + 1
    judged.holding = stakeRowsHoldingKey(rows, { reuseActive: judged.reuseActive, landBlock, cooldownBlocks })
    // The undeactivated rows are the stake UNSTAKE v0 would sweep, so their sum is the one to print.
    const live = rows.filter(isUndeactivated)
    judged.liveCount = live.length
    judged.liveAmount = live.length ? sumAmounts(live) : null
    const ends = judged.holding.map(deactivationBlock).filter(d => d !== null)
    judged.freeFromBlock = judged.reuseActive && ends.length === judged.holding.length && ends.length
        ? Math.max(...ends) + cooldownBlocks
        : null
    return judged
}

/**
 * Read everything that decides whether this pubkey is free for a STAKE v1.
 * Returns { existing, stakeJudgement, existingUnknown, delegated,
 * delegationUnknown }: `existing` is the newest stakes row still holding the
 * key, `delegated` the delegation rows holding it; each *Unknown is the
 * message of a read that failed, never a silent "free".
 */
async function readKeyHolders(sdk, pubkey, { network, coins, cooldownBlocks }) {
    const tip = tipOnce(sdk, coins)
    const out = { existing: null, stakeJudgement: null, existingUnknown: null, delegated: null, delegationUnknown: null }
    try {
        const v = await readValidatorSet(sdk)
        const rows = ((v && v.data) || []).filter(r => r && r.status === 'valid' &&
            String(r.signing_pubkey || '').toLowerCase() === pubkey)
        if (rows.length) {
            const judged = await judgeStakeRows(rows, { network, coins, cooldownBlocks, tip })
            if (judged.holding.length) {
                out.stakeJudgement = judged
                out.existing = judged.holding.reduce((a, b) => (Number(b.action_index) > Number(a.action_index) ? b : a))
            }
        }
    } catch (e) {
        out.existingUnknown = e.message
    }
    if (out.existing) return out
    try {
        const rows = await readDelegationsByPubkey(sdk, pubkey)
        let landBlock = null
        if (rows.some(r => r && r.status === 'valid' && !isUndeactivated(r))) {
            try { landBlock = (await tip()) + 1 } catch { landBlock = null }
        }
        const holding = delegationRowsHoldingKey(rows, landBlock)
        if (holding.length) out.delegated = holding
    } catch (e) {
        out.delegationUnknown = e.message
    }
    return out
}

module.exports = {
    STAKE_KEY_REUSE_ACTIVATION,
    stakeKeyReuseHeight,
    stakeRowsHoldingKey,
    delegationRowsHoldingKey,
    sumAmounts,
    readDelegationsByPubkey,
    readKeyHolders
}
