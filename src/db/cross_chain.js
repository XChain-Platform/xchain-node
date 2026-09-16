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
 * XChain Node - the hub's cross-chain relic tables
 *
 * A re-genesised regtest chain leaves the hub's cross-chain rows behind: they
 * are keyed by `network` and a Bitcoin-anchored snapshot_block, and nothing in
 * them names the chain INSTANCE, so the mirror bootstrap hands every fresh
 * indexer the dead chain's finalized matches and it refuses them at every block
 * for as long as it runs. These are the statements that purge them.
 *
 ********************************************************************/

const { escapeSqlStringLiteral } = require('../utils/sql_safety')

const CROSS_CHAIN_MATCH_TABLE    = 'cross_chain_matches'
const CROSS_CHAIN_CALL_TABLE     = 'cross_chain_calls'
const CAPABILITY_SNAPSHOT_TABLE  = 'capability_snapshots'

/** Fully qualify a hub table, so a purge cannot land in whatever schema the session defaulted to. */
function qualify(hubDbName, table) {
    return "`" + hubDbName + "`." + table
}

/** Every match row for one network, whichever chains it joins. */
function purgeAllMatchesSql(hubDbName, network) {
    return "DELETE FROM " + qualify(hubDbName, CROSS_CHAIN_MATCH_TABLE)
        + " WHERE network = " + escapeSqlStringLiteral(network)
}

/** Every call row for one network. */
function purgeAllCallsSql(hubDbName, network) {
    return "DELETE FROM " + qualify(hubDbName, CROSS_CHAIN_CALL_TABLE)
        + " WHERE network = " + escapeSqlStringLiteral(network)
}

/**
 * Only the match rows that touch ONE chain. A non-anchor re-genesis kills only
 * the legs that touch that chain: a match between two OTHER chains is still
 * valid.
 */
function purgeChainMatchesSql(hubDbName, network, ticker) {
    const tickerLiteral = escapeSqlStringLiteral(ticker)
    return "DELETE FROM " + qualify(hubDbName, CROSS_CHAIN_MATCH_TABLE)
        + " WHERE network = " + escapeSqlStringLiteral(network)
        + " AND (a_chain = " + tickerLiteral + " OR b_chain = " + tickerLiteral + ")"
}

/** The call-row twin of the read above, keyed on the source and target chains. */
function purgeChainCallsSql(hubDbName, network, ticker) {
    const tickerLiteral = escapeSqlStringLiteral(ticker)
    return "DELETE FROM " + qualify(hubDbName, CROSS_CHAIN_CALL_TABLE)
        + " WHERE network = " + escapeSqlStringLiteral(network)
        + " AND (source_chain = " + tickerLiteral + " OR target_chain = " + tickerLiteral + ")"
}

/**
 * The capability snapshots, all of them. That table carries no network column,
 * which is why the caller only issues this after proving the hub holds no other
 * network's rows.
 */
function purgeCapabilitySnapshotsSql(hubDbName) {
    return "DELETE FROM " + qualify(hubDbName, CAPABILITY_SNAPSHOT_TABLE)
}

/**
 * How many match rows belong to some OTHER network. A non-zero answer means the
 * hub is shared and the snapshot purge must stop short.
 */
function foreignNetworkMatchCountSql(hubDbName, network) {
    return "SELECT COUNT(*) FROM `" + hubDbName + "`." + CROSS_CHAIN_MATCH_TABLE
        + " WHERE network <> " + escapeSqlStringLiteral(network)
}

/**
 * The by-hand form of what the purge issues, for an operator connected to the
 * hub's own database. Unqualified and literal on purpose, like the fence's
 * manual statement: the operator is already in that database and the lines have
 * to be copy-pasteable as printed.
 */
function manualPurgeStatements(ticker, network, anchorTicker) {
    if (ticker === anchorTicker) {
        return [
            "DELETE FROM " + CROSS_CHAIN_MATCH_TABLE + " WHERE network = '" + network + "';",
            "DELETE FROM " + CROSS_CHAIN_CALL_TABLE + " WHERE network = '" + network + "';",
            "DELETE FROM " + CAPABILITY_SNAPSHOT_TABLE + ";"
        ]
    }
    return [
        "DELETE FROM " + CROSS_CHAIN_MATCH_TABLE + " WHERE network = '" + network
            + "' AND (a_chain = '" + ticker + "' OR b_chain = '" + ticker + "');",
        "DELETE FROM " + CROSS_CHAIN_CALL_TABLE + " WHERE network = '" + network
            + "' AND (source_chain = '" + ticker + "' OR target_chain = '" + ticker + "');"
    ]
}

/** The snapshots half of the manual form, printed on its own when only it was skipped. */
function manualSnapshotPurgeStatement() {
    return "DELETE FROM " + CAPABILITY_SNAPSHOT_TABLE + ";"
}

module.exports = {
    manualPurgeStatements,
    manualSnapshotPurgeStatement,
    CROSS_CHAIN_MATCH_TABLE,
    CROSS_CHAIN_CALL_TABLE,
    CAPABILITY_SNAPSHOT_TABLE,
    purgeAllMatchesSql,
    purgeAllCallsSql,
    purgeChainMatchesSql,
    purgeChainCallsSql,
    purgeCapabilitySnapshotsSql,
    foreignNetworkMatchCountSql
}
