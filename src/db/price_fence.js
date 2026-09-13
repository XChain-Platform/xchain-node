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
 *
 * XChain Node - the hub's `price_ingest_watermarks` fence
 *
 * A wiped indexer database restarts its push_generations at 0, which the hub's
 * price ingest fence reads as a stale replay and DROPS, killing that chain's
 * price rail. The statements below are how a reset clears the fence row so the
 * first push after the restart lands.
 *
 ********************************************************************/

const { escapeSqlStringLiteral } = require('../utils/sqlSafety')

const PRICE_FENCE_TABLE = 'price_ingest_watermarks'

// The column that scopes a fence row to one network, and so the thing whose
// absence forces the chain-only fallback below.
const FENCE_NETWORK_COLUMN = 'network'

/**
 * Clear this chain's fence on every network the hub holds.
 *
 * This is the statement a hub OLDER than the network column supports, and on
 * that hub it is not merely a wider shot: the pre-column fence is keyed by
 * source_chain alone, so this is the EXACT statement that schema supports and it
 * reaches exactly the one row fencing this chain.
 */
function clearChainFenceSql(hubDbName, ticker) {
    return "DELETE FROM `" + hubDbName + "`." + PRICE_FENCE_TABLE
        + " WHERE source_chain = " + escapeSqlStringLiteral(ticker)
}

/**
 * Clear this chain's fence on ONE network, plus the '' bucket that pre-migration
 * rows sit in. This is the statement to run whenever the hub can answer it: on a
 * hub that does scope by network, the chain-only form above would drop the live
 * networks' fences too.
 */
function clearNetworkFenceSql(hubDbName, ticker, fenceNetwork) {
    return clearChainFenceSql(hubDbName, ticker)
        + " AND network IN (" + escapeSqlStringLiteral(fenceNetwork) + ", '')"
}

/**
 * The by-hand form of the clear above, for an operator connected to the hub's
 * own database. Unqualified and literal on purpose: the operator is already IN
 * that database, and the statement has to be copy-pasteable as printed.
 *
 * The network clause is part of the statement, not decoration: without it the
 * hand-run DELETE drops every network's fence for the chain, which is the
 * failure the column was added to remove.
 */
function manualClearStatement(ticker, fenceNetwork) {
    return "DELETE FROM " + PRICE_FENCE_TABLE + " WHERE source_chain = '" + ticker + "'"
        + " AND network IN ('" + fenceNetwork + "', '');"
}

module.exports = {
    PRICE_FENCE_TABLE,
    FENCE_NETWORK_COLUMN,
    clearChainFenceSql,
    clearNetworkFenceSql,
    manualClearStatement
}
