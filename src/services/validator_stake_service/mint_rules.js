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
 * XChain Node - Validator Stake Mint Rules
 *
 * The token rules the indexer judges a MINT by (xchain-indexer/src/actions/
 * mint/validate.js), read before the stake run spends any MINT fee: LOCK_MINT,
 * the MINT_START_BLOCK/MINT_STOP_BLOCK window at the block a MINT sent now can
 * land in, MAX_MINT, and MINT_ADDRESS_MAX against what this address has
 * already minted itself. A cap or block of 0 is unset, as in the indexer, and
 * a value the explorer did not report is unknown, never 0. The CLI only reads
 * these rules; consensus stays in the indexer.
 ********************************************************************/

const { readTip } = require('./free_key')

// The explorer's per-method row cap, and the OFFSET ceiling that bounds a sweep.
const PAGE_LIMIT = 100
const MAX_PAGES = 1001
// XCHAIN carries 8 decimal places; amounts are summed and compared in these integer units.
const UNITS = 1e8

// A mints-group value as a number, or null when the explorer did not report one.
function reported(x) {
    if (x === null || x === undefined || x === '') return null
    const n = Number(x)
    return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * The token's mint caps, lock and window. `unreadable` names every value the
 * explorer did not report, so a missing cap never reads as the unset 0.
 */
function readTokenMintRules(token, tick) {
    const mints = (token && token.mints && typeof token.mints === 'object') ? token.mints : null
    if (!mints) {
        return { max: null, addressMax: null, unreadable: 'the ' + tick + ' token read returned an unexpected ' +
            'shape (no mints group), so its faucet caps are unknown' }
    }
    const locked = (token.locks && typeof token.locks === 'object') ? token.locks.mint : undefined
    const rules = { max: reported(mints.max), addressMax: reported(mints.address_max),
        startBlock: reported(mints.start_block), stopBlock: reported(mints.stop_block), locked }
    const missing = [['max', 'mints.max'], ['addressMax', 'mints.address_max'], ['startBlock', 'mints.start_block'],
        ['stopBlock', 'mints.stop_block']].filter(([key]) => rules[key] === null).map(([, name]) => name)
    if (typeof locked !== 'boolean') missing.push('locks.mint')
    rules.unreadable = missing.length
        ? 'the ' + tick + ' token read did not report ' + missing.join(', ') + ', so its mint rules are unknown'
        : null
    return rules
}

/**
 * Why the indexer would reject a MINT landing at landBlock for the token's
 * lock or window, or null when the mint is open there.
 */
function mintClosedReason(rules, landBlock, tick) {
    const none = 'the ' + tick + ' token has no open mint: '
    if (rules.locked) return none + 'its mint is locked (LOCK_MINT), and the indexer rejects every MINT of it.'
    if (rules.startBlock > 0 && landBlock < rules.startBlock) {
        return none + 'minting opens at block ' + rules.startBlock + ' (MINT_START_BLOCK), and a MINT sent now ' +
            'lands at block ' + landBlock + ' at the earliest. Re-run from block ' + rules.startBlock + '.'
    }
    if (rules.stopBlock > 0 && landBlock > rules.stopBlock) {
        return none + 'minting closed after block ' + rules.stopBlock + ' (MINT_STOP_BLOCK), and a MINT sent now ' +
            'lands at block ' + landBlock + ' at the earliest.'
    }
    return null
}

// One row's amount in units when it is a valid MINT of `tick` authored by `address`, else 0.
function selfMintUnits(row, address, tick) {
    if (!row || row.status !== 'valid' || String(row.source) !== String(address) || String(row.tick) !== tick) return 0
    const n = Number(row.amount)
    if (row.amount === null || row.amount === '' || !Number.isFinite(n) || n < 0) {
        throw new Error('MINT action ' + row.action_index + ' has no readable amount')
    }
    return Math.round(n * UNITS)
}

/**
 * What this address has already minted itself: its valid MINT rows of `tick`
 * on the explorer's source lane, paged to the end, which is the total the
 * indexer holds MINT_ADDRESS_MAX against. Throws on anything short of a
 * complete answer, so a failed read never counts as nothing minted.
 */
async function readSelfMinted(sdk, address, tick) {
    if (!sdk.explorer || typeof sdk.explorer.getMints !== 'function') throw new Error('this SDK has no getMints')
    let units = 0
    let seen = 0
    for (let page = 1; ; page++) {
        if (page > MAX_PAGES) throw new Error('mint read incomplete: more than ' + (MAX_PAGES * PAGE_LIMIT) + ' rows')
        const v = await sdk.explorer.getMints(address, 'source', { page, limit: PAGE_LIMIT, sortorder: 'ASC' })
        if (!v || !Array.isArray(v.data)) throw new Error('the mint lookup by source returned no row list')
        for (const row of v.data) units += selfMintUnits(row, address, tick)
        seen += v.data.length
        const total = Number(v.total)
        const known = v.total !== undefined && v.total !== null && Number.isInteger(total) && total >= 0
        if (known ? seen >= total : v.data.length < PAGE_LIMIT) break
        if (!v.data.length) throw new Error('mint read incomplete: saw ' + seen + ' of ' + total + ' rows')
    }
    return units / UNITS
}

/**
 * The mint rules as plan state: { mintMax, mintAddressMax, mintUnreadable,
 * mintClosed, mintedSoFar, mintedUnknown }. A failed tip or mint-history read
 * comes back as a reason string, never as an open mint or zero minted.
 */
async function readMintState(sdk, address, token, coins, tick) {
    const rules = readTokenMintRules(token, tick)
    const state = { mintMax: rules.max, mintAddressMax: rules.addressMax, mintUnreadable: rules.unreadable,
        mintClosed: null, mintedSoFar: null, mintedUnknown: null }
    if (rules.unreadable) return state
    try {
        state.mintClosed = rules.locked ? mintClosedReason(rules, null, tick)
            : mintClosedReason(rules, (await readTip(sdk, coins)) + 1, tick)
    } catch (e) {
        state.mintClosed = 'could not confirm the ' + tick + ' mint window is open (' + e.message + '). The ' +
            'indexer rejects a MINT outside it after the fee is spent, so nothing is minted until this can be ' +
            'read. Retry, or check the explorer.'
    }
    if (!(rules.addressMax > 0)) return state
    try {
        state.mintedSoFar = await readSelfMinted(sdk, address, tick)
    } catch (e) {
        state.mintedUnknown = 'could not read what ' + address + ' has already minted (' + e.message + '), so ' +
            'the per-address mint cap cannot be checked. The indexer counts every earlier MINT from this address ' +
            'against it and rejects an over-cap MINT after the fee is spent. Retry, or check the explorer.'
    }
    return state
}

/** Whether `minted` plus `short` passes the per-address cap `cap` (0 is no cap), compared in units. */
function overAddressCap(minted, short, cap) {
    return cap > 0 && Math.round((minted + short) * UNITS) > Math.round(cap * UNITS)
}

module.exports = { readTokenMintRules, mintClosedReason, readSelfMinted, readMintState, overAddressCap }
