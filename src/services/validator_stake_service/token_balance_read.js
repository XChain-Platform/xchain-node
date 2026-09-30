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
 * XChain Node - Token Balance Read
 *
 * One tick's row from an address's /balances list, read page by page. The
 * explorer serves at most 500 rows a page ordered by tick, and anyone can send
 * tokens to an address, so a tick that sorts late can sit past page one; one
 * unpaged read would then report a held balance as absent.
 ********************************************************************/

// The explorer's per-method row cap for /balances.
const PAGE_LIMIT = 500
// The explorer caps the API OFFSET at 100000, so page 202 would repeat page 201.
const MAX_PAGES = 201

function incomplete(msg) {
    const e = new Error('balance list read incomplete: ' + msg)
    e.incompleteRead = true
    return e
}

// A usable `total`: a finite, non-negative integer, or null when the response has none.
function readTotal(v) {
    if (!v || v.total === undefined || v.total === null || v.total === '') return null
    const t = Number(v.total)
    return Number.isInteger(t) && t >= 0 ? t : null
}

/**
 * The address's row for `tick`, or null only once the whole list has been read without it.
 * Any partial read throws an error tagged `incompleteRead`, so it never reads as "holds none".
 */
async function readTokenRow(sdk, address, tick) {
    let seen = 0
    let total = null
    for (let page = 1; ; page++) {
        if (page > MAX_PAGES) throw incomplete('more than ' + (MAX_PAGES * PAGE_LIMIT) + ' rows')
        const v = await sdk.getBalances(address, { page, limit: PAGE_LIMIT, sortorder: 'ASC' })
        if (!v || !Array.isArray(v.data)) throw incomplete('page ' + page + ' returned no row list')
        const row = v.data.find(b => b && b.tick === tick)
        if (row) return row
        const pageTotal = readTotal(v)
        // A shrinking total means rows left the list mid-read, so offsets shifted under us.
        if (pageTotal !== null && total !== null && pageTotal < total) {
            throw incomplete('the list shrank from ' + total + ' to ' + pageTotal + ' rows mid-read')
        }
        if (pageTotal !== null) total = pageTotal
        seen += v.data.length
        // Done when every counted row is in hand, or, with no total, on a short page.
        if (total !== null ? seen >= total : v.data.length < PAGE_LIMIT) return null
        // An empty page before the total is reached is a truncated read, not the end.
        if (!v.data.length) throw incomplete('saw ' + seen + ' of ' + total + ' rows')
    }
}

module.exports = { readTokenRow }
