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
 * XChain Node - Explorer Address Balance Read
 ********************************************************************/

'use strict'

function num(x) {
    const n = Number(x)
    return Number.isFinite(n) ? n : 0
}

// Some explorer deployments return a one-record array for an entity read.
function entity(body) {
    return Array.isArray(body) ? body[0] : body
}

// A tracker outage returns a null confirmed balance. Preserve that unknown state
// rather than allowing Number(null) to turn it into a funded-to-zero balance.
function nativeBalance(addr) {
    const balances = addr && addr.balances
    if (!balances || addr.tracker_available === false) return null
    const confirmed = balances.confirmed
    if (confirmed === null || confirmed === undefined || !Number.isFinite(Number(confirmed))) return null
    return { confirmed: Number(confirmed), pending: num(balances.pending) }
}

module.exports = { entity, nativeBalance }
