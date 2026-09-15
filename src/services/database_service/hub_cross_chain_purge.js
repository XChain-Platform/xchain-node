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
 * XChain Node - Database Service
 * MariaDB management: build, configure users, check readiness
 ********************************************************************/


let { execFile } = require('child_process')
let { HUB_MODULE_NAME, CoinTickerSymbol, EXTERNAL_DB } = require('../../config')
let { redactSecrets } = require('../../utils/helpers')
let { assertSafeDbIdentifier, escapeSqlStringLiteral } = require('../../utils/sql_safety')
let { tablesExistSql } = require('../../db/information_schema')
let { CROSS_CHAIN_MATCH_TABLE, CROSS_CHAIN_CALL_TABLE, CAPABILITY_SNAPSHOT_TABLE, purgeAllMatchesSql, purgeAllCallsSql, purgeChainMatchesSql, purgeChainCallsSql, purgeCapabilitySnapshotsSql, foreignNetworkMatchCountSql, manualPurgeStatements, manualSnapshotPurgeStatement } = require('../../db/cross_chain')
let { getDefaultConfig } = require('../config_service')
let { getLogger } = require('../../observability/logger')
let logger = getLogger()
let { getDatabaseContainerId } = require('./container_access')
let { getExternalDbConfig } = require('./external_db')
let { executeNativeMariaDbCommand, askMariadbRootPassword, executeDockerMariaDbCommand } = require('./mariadb_exec')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, HUB_MODULE_NAME, CoinTickerSymbol, EXTERNAL_DB, redactSecrets, assertSafeDbIdentifier, escapeSqlStringLiteral, tablesExistSql, CROSS_CHAIN_MATCH_TABLE, CROSS_CHAIN_CALL_TABLE, CAPABILITY_SNAPSHOT_TABLE, purgeAllMatchesSql, purgeAllCallsSql, purgeChainMatchesSql, purgeChainCallsSql, purgeCapabilitySnapshotsSql, foreignNetworkMatchCountSql, manualPurgeStatements, manualSnapshotPurgeStatement, getDefaultConfig, getLogger, logger } = dependencies)
}

// The chain every cross-chain row's snapshot_block is anchored on, so its
// re-genesis invalidates the whole set rather than just the legs touching it.
const ANCHOR_CHAIN_TICKER = 'BTC'

// The only network with a re-genesis path. A literal rather than Network.REGTEST
// so this module's one destructive hub-wide DELETE cannot be widened by an edit
// to the shared constants file.
const PURGEABLE_NETWORK = 'regtest'

// Purge the hub's cross-chain relic rows when a regtest chain is re-genesised.
//
// A hub database outlives the chain it federates. `cross_chain_matches`,
// `cross_chain_calls` and `capability_snapshots` are keyed by `network` and a
// BTC-anchored `snapshot_block`, and nothing in them names the chain INSTANCE,
// so on regtest one `network` value spans every chain the venue has ever had.
// Re-genesis without this and the mirror bootstrap hands every FRESH indexer the
// dead chain's finalized matches, which can never settle: 33074 refusals in
// twelve hours on the regtest venue, each holding one of the per-block
// CROSS_SETTLE_MAX_PER_BLOCK settlement slots the live matches need.
//
// Regtest only, asserted here as well as at the call site: mainnet and testnet
// have no re-genesis path, so there this is a wipe of live federation history
// and no argument may reach it.
//
// Returns true when the rows were purged, false when the network is not regtest
// or this MariaDB holds no hub DB to purge them in (a stack pushing to a hub
// elsewhere), in which case nothing is touched and the manual statements are
// printed.
async function purgeHubCrossChainRows(coin, network) {
    const ticker = CoinTickerSymbol[coin]
    if (!ticker) {
        throw new Error("purgeHubCrossChainRows: unknown coin '" + coin + "'")
    }
    if (network !== PURGEABLE_NETWORK) return false

    const cfg = await getDefaultConfig(HUB_MODULE_NAME, null, null)
    const hubDbName = cfg && cfg["HUB_DB_NAME"]
    if (!hubDbName) {
        warnHubCrossChainRowsNotPurged(ticker, "the hub configuration carries no HUB_DB_NAME")
        return false
    }
    // Same contract as clearHubPriceIngestWatermark: a database name is an
    // identifier and cannot be bound, so allowlist it before it reaches SQL. The
    // ticker and the network are values and are escaped as literals below.
    assertSafeDbIdentifier(hubDbName, 'database name')

    let runner
    if (EXTERNAL_DB) {
        const externalCfg = await getExternalDbConfig()
        runner = (sql, options) => executeNativeMariaDbCommand(externalCfg, sql, options)
    } else {
        const mariadbContainerId = await getDatabaseContainerId()
        if (!mariadbContainerId) {
            warnHubCrossChainRowsNotPurged(ticker, "no MariaDB container was found")
            return false
        }
        const mariadbRootPassword = await askMariadbRootPassword(coin, network)
        runner = (sql, options) => executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword, sql, options)
    }

    // Probe first rather than DELETE-and-swallow, for the reason the price fence
    // does it: a hub on another host (the common prod shape) has no tables here,
    // and that case must print the manual statements instead of being
    // indistinguishable from a purge that deleted nothing.
    const requiredTables = ticker === ANCHOR_CHAIN_TICKER
        ? [CROSS_CHAIN_MATCH_TABLE, CROSS_CHAIN_CALL_TABLE, CAPABILITY_SNAPSHOT_TABLE]
        : [CROSS_CHAIN_MATCH_TABLE, CROSS_CHAIN_CALL_TABLE]
    const probe = await runner(
        tablesExistSql(escapeSqlStringLiteral(hubDbName), requiredTables), "-B -N")
    if (parseInt(String(probe).trim(), 10) !== requiredTables.length) {
        warnHubCrossChainRowsNotPurged(ticker,
            "this MariaDB holds no " + hubDbName + " cross-chain tables")
        return false
    }
    return purgeCrossChainTables(runner, cfg, hubDbName, ticker)
}

async function purgeCrossChainTables(runner, cfg, hubDbName, ticker) {
    if (ticker === ANCHOR_CHAIN_TICKER) {
        await runner(purgeAllMatchesSql(hubDbName, PURGEABLE_NETWORK))
        await runner(purgeAllCallsSql(hubDbName, PURGEABLE_NETWORK))
        const foreignHub = await hubHoldsAnotherNetwork(runner, cfg, hubDbName)
        if (foreignHub) warnCapabilitySnapshotsKept(foreignHub)
        else await runner(purgeCapabilitySnapshotsSql(hubDbName))
    } else {
        // A non-Bitcoin re-genesis kills only the legs that touch that chain: a
        // match between two OTHER chains is still valid, and the snapshots are
        // anchored on Bitcoin blocks that did not move, so both stay.
        await runner(purgeChainMatchesSql(hubDbName, PURGEABLE_NETWORK, ticker))
        await runner(purgeChainCallsSql(hubDbName, PURGEABLE_NETWORK, ticker))
    }

    logger.info(redactSecrets("Purged the hub's " + PURGEABLE_NETWORK + " cross-chain relic rows for "
        + ticker + " (" + hubDbName + ") so a fresh indexer does not mirror the dead chain's matches"))
    // The engine rebuilds its committed ledger only at startup, so until the hub
    // is restarted it still holds the purged matches in memory.
    logger.info("Restart the hub so it drops its in-memory match ledger: xchain-node restart " + HUB_MODULE_NAME)
    return true
}

// Whether this hub database may belong to a network other than the one being
// reset. `capability_snapshots` carries no `network` column (a hub serves
// exactly one HUB_NETWORK, so the table never needed one), which leaves its
// DELETE with nothing to scope on: establish first that the co-located hub
// really is this regtest stack's. Two independent tells, because either can be
// absent - the hub's configured network (a host-env passthrough, so often
// unset here) and any sibling row written for another network. Returns the
// reason the purge must stop short, or null.
async function hubHoldsAnotherNetwork(runner, cfg, hubDbName) {
    const hubNetwork = (cfg && typeof cfg["HUB_NETWORK"] === 'string')
        ? cfg["HUB_NETWORK"].trim().toLowerCase()
        : ''
    if (hubNetwork !== '' && hubNetwork !== PURGEABLE_NETWORK) {
        return "the hub on this MariaDB is configured for " + hubNetwork
    }
    const foreign = await runner(foreignNetworkMatchCountSql(hubDbName, PURGEABLE_NETWORK), "-B -N")
    if (parseInt(String(foreign).trim(), 10) > 0) {
        return "this hub database also holds cross-chain rows for another network"
    }
    return null
}

// One wording for every "could not purge them here" branch, so the operator
// always gets the exact statements to run on whichever DB the hub actually uses.
function warnHubCrossChainRowsNotPurged(ticker, reason) {
    logger.warn(redactSecrets("WARNING: the hub's " + PURGEABLE_NETWORK
        + " cross-chain relic rows for " + ticker + " were NOT purged (" + reason + ")."))
    logger.warn("  A fresh indexer on the re-genesised chain mirrors the DEAD chain's finalized matches")
    logger.warn("  back in, where they can never settle and each holds a per-block settlement slot.")
    logger.warn("  Run this on the hub's OWN database before the indexer catches up:")
    for (const statement of manualHubCrossChainPurgeStatements(ticker)) {
        logger.warn("    " + statement)
    }
    logger.warn("  Then restart the hub: xchain-node restart " + HUB_MODULE_NAME)
}

// The snapshots half alone was skipped: the matches and calls are already gone.
function warnCapabilitySnapshotsKept(reason) {
    logger.warn(redactSecrets("WARNING: the hub's " + CAPABILITY_SNAPSHOT_TABLE
        + " rows were NOT purged (" + reason + ")."))
    logger.warn("  That table carries no network column, so purging it from here could take another")
    logger.warn("  network's validator sets with it. The re-genesised chain's matches and calls WERE")
    logger.warn("  purged. If this hub really is the regtest one, run on its own database:")
    logger.warn("    " + manualSnapshotPurgeStatement())
}

// The by-hand form of what purgeHubCrossChainRows issues, shared by the warning
// above and the reset's never-fatal catch. The statements themselves live with
// the tables they name, in the db home.
function manualHubCrossChainPurgeStatements(ticker) {
    return manualPurgeStatements(ticker, PURGEABLE_NETWORK, ANCHOR_CHAIN_TICKER)
}

module.exports = { purgeHubCrossChainRows, manualHubCrossChainPurgeStatements, configureDependencies }
