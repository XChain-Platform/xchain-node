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
 * XChain Node - Validator Stake Address Sleep Check
 *
 * Whether the stake address is asleep at the block a transaction sent now
 * can land in, judged the way the indexer's isAddressSleeping judges it
 * (xchain-indexer/src/db/sleeps/index.js). The indexer rejects every MINT,
 * STAKE and UNSTAKE from a sleeping SOURCE only after its fee is spent, so
 * the CLI refuses first. The CLI only reads this rule; consensus stays in
 * the indexer.
 ********************************************************************/

const { readTip } = require('./free_key')

// The explorer's per-method row cap, and the OFFSET ceiling that bounds a sweep.
const PAGE_LIMIT = 100
const MAX_PAGES = 1001

// The sleeps.type value of an ADDRESS sleep (a TICK sleep is 2 and never puts an address to sleep).
const ADDRESS_SLEEP_TYPE = 1

/**
 * Judge the address's sleep at landBlock from its SLEEP rows: only the newest
 * valid ADDRESS sleep from this address decides, and it holds while its
 * resume block is -1 (indefinite) or past landBlock. Returns
 * { sleeping, resumeBlock, actionIndex }; throws on an unreadable resume block.
 */
function judgeAddressSleep(rows, address, landBlock) {
    const own = rows.filter(r => r && String(r.source) === String(address) &&
        Number(r.type) === ADDRESS_SLEEP_TYPE && r.status === 'valid')
    if (!own.length) return { sleeping: false, resumeBlock: null, actionIndex: null }
    const newest = own.reduce((a, b) => (Number(b.action_index) > Number(a.action_index) ? b : a))
    const resumeBlock = Number(newest.resume_block)
    if (!Number.isInteger(resumeBlock)) {
        throw new Error('SLEEP action ' + newest.action_index + ' has no readable resume block')
    }
    return { sleeping: resumeBlock === -1 || resumeBlock > landBlock, resumeBlock, actionIndex: Number(newest.action_index) }
}

/**
 * Every SLEEP row the explorer's address lane holds for this address, paged
 * to the end. Throws on anything short of a complete answer, so a failed
 * read never comes back as "not asleep".
 */
async function readSleepRows(sdk, address) {
    if (!sdk.explorer || typeof sdk.explorer.getSleeps !== 'function') {
        throw new Error('this SDK has no getSleeps')
    }
    const rows = []
    for (let page = 1; ; page++) {
        if (page > MAX_PAGES) throw new Error('sleep read incomplete: more than ' + (MAX_PAGES * PAGE_LIMIT) + ' rows')
        const v = await sdk.explorer.getSleeps(address, 'address', { page, limit: PAGE_LIMIT, sortorder: 'ASC' })
        if (!v || !Array.isArray(v.data)) throw new Error('the sleep lookup by address returned no row list')
        rows.push(...v.data)
        const total = Number(v.total)
        const known = v.total !== undefined && v.total !== null && Number.isInteger(total) && total >= 0
        if (known ? rows.length >= total : v.data.length < PAGE_LIMIT) break
        if (!v.data.length) throw new Error('sleep read incomplete: saw ' + rows.length + ' of ' + total + ' rows')
    }
    return rows
}

// Read and judge the address's sleep at landBlock; throws when it cannot be read.
async function readAddressSleep(sdk, address, landBlock) {
    return judgeAddressSleep(await readSleepRows(sdk, address), address, landBlock)
}

/**
 * The stake address's sleep at the explorer tip + 1, as plan state:
 * { sleep, sleepUnknown }, where sleepUnknown is the message of a failed
 * tip or sleep read, never a silent "awake".
 */
async function readSleepState(sdk, address, coins) {
    try {
        const tip = await readTip(sdk, coins)
        return { sleep: await readAddressSleep(sdk, address, tip + 1), sleepUnknown: null }
    } catch (e) {
        return { sleep: null, sleepUnknown: e.message }
    }
}

/**
 * Why `action` (the operator's words for what would be sent) cannot go out
 * from a sleeping address, or null when the address is awake. An address
 * slept indefinitely cannot wake itself: the indexer rejects its SLEEP too.
 */
function sleepRefusal(sleep, address, action) {
    if (!sleep || !sleep.sleeping) return null
    const slept = 'the stake address ' + address + ' is asleep'
    const rejects = ' (SLEEP at action ' + sleep.actionIndex + '), and the indexer rejects ' + action +
        ' from a sleeping address after the fees are spent.'
    if (sleep.resumeBlock === -1) {
        return slept + ' indefinitely' + rejects + ' It also rejects a SLEEP from a sleeping address, so this ' +
            'address cannot wake itself; nothing it sends can be accepted.'
    }
    return slept + ' until block ' + sleep.resumeBlock + rejects + ' Re-run from block ' + sleep.resumeBlock + '.'
}

// Why a failed sleep read stops `action`, in the operator's terms.
function sleepUnknownRefusal(message, address, action) {
    return 'could not confirm the stake address ' + address + ' is not asleep (' + message + '). The indexer ' +
        'rejects ' + action + ' from a sleeping address after the fees are spent, so nothing is sent until this ' +
        'can be read. Retry, or check the explorer.'
}

module.exports = { judgeAddressSleep, readAddressSleep, readSleepState, sleepRefusal, sleepUnknownRefusal }
