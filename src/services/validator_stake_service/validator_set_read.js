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
 * XChain Node - Validator Set Read
 *
 * The whole /validators set, read page by page. The explorer serves at most
 * 100 rows a page, newest first, and counts every valid stakes row (top-ups
 * and partial-unstake residuals included), so one unpaged read silently drops
 * every older validator once the set passes 100 rows, and a stake that is on
 * chain reads as "nothing staked".
 ********************************************************************/

// The explorer's per-method row cap for /validators.
const PAGE_LIMIT = 100
// The explorer caps the API OFFSET at 100000, so page 1002 would repeat page 1001.
const MAX_PAGES = 1001

function incomplete(msg) {
    return new Error('validator set read incomplete: ' + msg)
}

// A usable `total`: a finite, non-negative integer, or null when the response has none.
function readTotal(v) {
    if (!v || v.total === undefined || v.total === null || v.total === '') return null
    const t = Number(v.total)
    return Number.isInteger(t) && t >= 0 ? t : null
}

/**
 * Every /validators row, oldest first (action_index ASC), so a stake landing mid-sweep appends at the
 * end instead of shifting rows across a page; any partial read throws, so it never reads as "not staked".
 */
async function readValidatorSet(sdk) {
    const rows = []
    let total = null
    for (let page = 1; ; page++) {
        if (page > MAX_PAGES) throw incomplete('more than ' + (MAX_PAGES * PAGE_LIMIT) + ' rows')
        const v = await sdk.explorer.getValidators({ page, limit: PAGE_LIMIT, sortorder: 'ASC' })
        if (!v || !Array.isArray(v.data)) throw incomplete('page ' + page + ' returned no row list')
        const pageTotal = readTotal(v)
        // A shrinking total means rows left the set mid-sweep, so offsets shifted under us.
        if (pageTotal !== null && total !== null && pageTotal < total) {
            throw incomplete('the set shrank from ' + total + ' to ' + pageTotal + ' rows mid-read')
        }
        if (pageTotal !== null) total = pageTotal
        rows.push(...v.data)
        // Done when every counted row is in hand, or, with no total, on a short page.
        if (total !== null ? rows.length >= total : v.data.length < PAGE_LIMIT) break
        // An empty page before the total is reached is a truncated read, not the end.
        if (!v.data.length) throw incomplete('saw ' + rows.length + ' of ' + total + ' rows')
    }
    return { total: rows.length, data: rows }
}

module.exports = { readValidatorSet }
