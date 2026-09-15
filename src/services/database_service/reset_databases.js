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
let { HUB_MODULE_NAME, XChainService, CoinTickerSymbol, EXTERNAL_DB } = require('../../config')
let { redactSecrets } = require('../../utils/helpers')
let { assertSafeDbIdentifier, escapeSqlStringLiteral } = require('../../utils/sql_safety')
let { tableExistsSql } = require('../../db/information_schema')
let { PRICE_FENCE_TABLE, FENCE_NETWORK_COLUMN, clearChainFenceSql, clearNetworkFenceSql, manualClearStatement } = require('../../db/price_fence')
let { getDefaultConfig, getModuleDatabaseName } = require('../config_service')
let { getLogger } = require('../../observability/logger')
let logger = getLogger()
let { getDatabaseContainerId } = require('./container_access')
let { getExternalDbConfig } = require('./external_db')
let { executeNativeMariaDbCommand, askMariadbRootPassword, executeDockerMariaDbCommand } = require('./mariadb_exec')

const nativeExecFile = execFile
function configureDependencies(dependencies) {
    if (dependencies.execFile === nativeExecFile) return
    ;({ execFile, HUB_MODULE_NAME, XChainService, CoinTickerSymbol, EXTERNAL_DB, redactSecrets, assertSafeDbIdentifier, escapeSqlStringLiteral, tableExistsSql, PRICE_FENCE_TABLE, FENCE_NETWORK_COLUMN, clearChainFenceSql, clearNetworkFenceSql, manualClearStatement, getDefaultConfig, getModuleDatabaseName, getLogger, logger } = dependencies)
}

    // Drop the databases this stack ACTUALLY uses, which is what provisioning
    // resolved: setDatabaseParameters grants on cfg["DECODER_DB_NAME"] /
    // cfg["INDEXER_DB_NAME"], and both are operator-overridable in the
    // <coin>-<network> config file. Deriving the DEFAULT name here instead meant
    // an overridden stack had its live database left untouched while the reset
    // dropped whatever else on that MariaDB happened to answer to the default
    // name: a wipe of another stack's data, reported as a successful reset.
    // The derived name stays the fallback for a config that
    // carries no name at all, and for any module outside the two DB modules.
    //
    // Gate every resolved name on the identifier allowlist before the first DROP.
    // A database name reaches SQL as text (an identifier cannot be bound), which
    // is why addUserPasswordToDatabase, clearHubPriceIngestWatermark and the
    // BootstrapHealthGate readers all assert it; this destructive site was the
    // one that opted out. Assert the whole set up front,
    // not per iteration: a name refused on the second module would otherwise
    // throw with the first module's database already dropped. This also covers
    // an operator-supplied name, which is the only untrusted one.
async function resolveResetTargets(coin, network, modules) {
    const configuredDbNameKey = {
        [XChainService.XCHAIN_DECODER]: "DECODER_DB_NAME",
        [XChainService.XCHAIN_INDEXER]: "INDEXER_DB_NAME"
    }
    const resetTargets = []
    for (const module of modules) {
        let dbName = getModuleDatabaseName(module, coin, network)
        const configKey = configuredDbNameKey[module]
        if (configKey) {
            const cfg = await getDefaultConfig(module, coin, network)
            const configured = cfg ? cfg[configKey] : undefined
            if (typeof configured === "string" && configured.trim() !== "") dbName = configured.trim()
        }
        resetTargets.push(assertSafeDbIdentifier(dbName, 'database name'))
    }
    return resetTargets
}

async function resetDatabases(coin, network, modules = [XChainService.XCHAIN_DECODER, XChainService.XCHAIN_INDEXER]) {
    const resetTargets = await resolveResetTargets(coin, network, modules)
    // External (host-native) MariaDB: there is no database container to exec
    // into it (`docker exec ... null` failed here and aborted the reset mid-way,
    // leaving data wiped, DBs stale, services stopped). Use the driver-based
    // helper instead. DROP and CREATE go as separate statements: unlike the
    // mariadb CLI, the driver rejects multi-statement strings.
    if (EXTERNAL_DB) {
        const cfg = await getExternalDbConfig()
        for (const dbName of resetTargets) {
            await executeNativeMariaDbCommand(cfg, `DROP DATABASE IF EXISTS ${dbName}`)
            await executeNativeMariaDbCommand(cfg, `CREATE DATABASE ${dbName}`)
            logger.info(`Database ${dbName} reset!`)
        }
        return
    }

    const mariadbRootPassword = await askMariadbRootPassword(coin, network)
    const mariadbContainerId  = await getDatabaseContainerId()

    // Refuse a reset with no container, HERE rather than at the caller.
    // getDatabaseContainerId() returns null when no MariaDB container exists,
    // and the loop below would then exec `docker exec ... null mariadb` and
    // abort with an opaque failure part-way through a wipe the caller has
    // already stopped services for. resetModules prechecks this, but the
    // function is exported, so the invariant belongs where the DROPs are
    // issued. Same precheck as addUserPasswordToDatabase.
    if (!mariadbContainerId) {
        throw new Error("MariaDB container not found; install the database first")
    }

    for (const dbName of resetTargets) {
        await executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword,
            `DROP DATABASE IF EXISTS ${dbName}; CREATE DATABASE ${dbName}`
        )
        logger.info(`Database ${dbName} reset!`)
    }
}

async function clearPriceFence(runner, hubDbName, ticker, fenceNetwork) {
    const chainOnlyDelete = clearChainFenceSql(hubDbName, ticker)

    // The network-scoped clause is the one to run whenever the hub can answer it.
    // A hub older than the `network` column cannot: it rejects the statement with
    // ER_BAD_FIELD_ERROR and, before this fallback, the reset printed "clearing
    // the fence failed" and left the rebuilt indexer's price rail dead. The
    // pre-column fence is keyed by source_chain alone, so on that hub the
    // chain-only DELETE is not merely a wider shot: it is the EXACT statement the
    // chain-keyed schema supports, and it reaches exactly the one row that is
    // fencing this chain. It is entered only for the missing `network` column,
    // never for any other SQL failure, because on a hub that does scope by
    // network the same statement would drop the live networks' fences too.
    let networkScoped = true
    try {
        await runner(clearNetworkFenceSql(hubDbName, ticker, fenceNetwork))
    } catch (err) {
        if (!isMissingFenceNetworkColumnError(err)) throw err
        networkScoped = false
        warnPriceFenceNetworkColumnMissing(ticker, hubDbName)
        await runner(chainOnlyDelete)
    }

    logger.info(redactSecrets("Cleared the hub price ingest fence for " + ticker + " on "
        + (networkScoped ? (fenceNetwork || "the unset-network (legacy) scope")
                         : "every network this hub holds (it has no " + FENCE_NETWORK_COLUMN + " column)")
        + " (" + hubDbName + "." + PRICE_FENCE_TABLE + ") so the rebuilt indexer's generation-0 pushes are accepted."
        + (networkScoped ? " Every other network's fence for " + ticker + " is untouched." : "")))
    return true
}


// Clear the hub's price ingest fence row for one source chain ON ONE NETWORK.
//
// `price_ingest_watermarks` holds, per (network, source chain), the highest
// rollback generation whose price retraction the hub has processed.
// PriceAggregator drops any push at or below that generation whose action_index
// sits in the retracted range. A reset indexer DB restarts its
// `push_generations` counter at 0 and, after replay, re-covers the same action
// indices, so EVERY price push from it matches that condition: the chain's price
// rail (and the native-fee / XCHAIN-USD path riding on it) stops, and until the
// hub-side warning landed nothing anywhere named the cause. So the fence row is
// cleared in the same step that wipes the indexer DB, never left to a runbook
// line.
//
// The DELETE is scoped by the RESET'S OWN network, which this function is always
// given, rather than by the hub's HUB_NETWORK, which is a host-env passthrough
// and often unset. That is what replaced the earlier guard: while the row was
// keyed by chain alone there was nothing for a WHERE clause to scope on, so a
// regtest reset beside a hub serving testnet had to be REFUSED (leaving the
// regtest rail down), and could not be refused at all when HUB_NETWORK was
// unset. With the network column the clear simply cannot reach another network's
// row, so it always runs.
//
// The legacy '' bucket is included: those are pre-migration rows, or rows from a
// hub that does not know its own network, and clearing them is exactly the
// behaviour that shipped before the column existed.
//
// Returns true when the delete was issued, false when this MariaDB holds no hub
// DB to clear it in (a stack pushing to a hub elsewhere), in which case the
// manual statement is printed. Only the calling chain's row on the calling
// network is touched: every other chain's fence, and every other network's fence
// for this chain, is still protecting its live ingest.
async function clearHubPriceIngestWatermark(coin, network) {
    const ticker = CoinTickerSymbol[coin]
    if (!ticker) {
        throw new Error("clearHubPriceIngestWatermark: unknown coin '" + coin + "'")
    }
    const fenceNetwork = normalizeFenceNetwork(network)

    const cfg = await getDefaultConfig(HUB_MODULE_NAME, null, null)
    const hubDbName = cfg && cfg["HUB_DB_NAME"]
    if (!hubDbName) {
        warnPriceFenceNotCleared(ticker, fenceNetwork, "the hub configuration carries no HUB_DB_NAME")
        return false
    }
    // Same contract as addUserPasswordToDatabase: the DB name is an identifier
    // and cannot be bound, so allowlist it before it reaches a SQL string. The
    // ticker is a value and is escaped as a literal at the use site.
    assertSafeDbIdentifier(hubDbName, 'database name')

    let runner
    if (EXTERNAL_DB) {
        const externalCfg = await getExternalDbConfig()
        runner = (sql, options) => executeNativeMariaDbCommand(externalCfg, sql, options)
    } else {
        const mariadbContainerId = await getDatabaseContainerId()
        if (!mariadbContainerId) {
            warnPriceFenceNotCleared(ticker, fenceNetwork, "no MariaDB container was found")
            return false
        }
        const mariadbRootPassword = await askMariadbRootPassword(coin, network)
        runner = (sql, options) => executeDockerMariaDbCommand(mariadbContainerId, mariadbRootPassword, sql, options)
    }

    // Probe first rather than DELETE-and-swallow: a hub on another host (the
    // common prod shape) has no table here, and that case must print the manual
    // statement instead of being indistinguishable from a failed delete.
    const probe = await runner(
        tableExistsSql(escapeSqlStringLiteral(hubDbName), escapeSqlStringLiteral(PRICE_FENCE_TABLE)), "-B -N")
    if (parseInt(String(probe).trim(), 10) !== 1) {
        warnPriceFenceNotCleared(ticker, fenceNetwork,
            "this MariaDB holds no " + hubDbName + "." + PRICE_FENCE_TABLE + " table")
        return false
    }

    return clearPriceFence(runner, hubDbName, ticker, fenceNetwork)
}


// The hub release whose schema carries price_ingest_watermarks.network, and so
// the floor below which the network-scoped DELETE cannot be issued at all.
// Measured from the tags: v0.17.0's src/sql/price_ingest_watermarks.sql still
// keys on source_chain alone, v0.18.0's keys on (network, source_chain).
const FENCE_NETWORK_COLUMN_HUB_FLOOR = 'v0.18.0'

// True only for "Unknown column 'network'", the one failure the chain-only
// fallback is allowed to answer. MariaDB reports it as ER_BAD_FIELD_ERROR
// (errno 1054) and the two runners surface it differently: the native driver
// sets err.code/err.errno, while the docker path sets err.code to the client's
// numeric EXIT code and carries the text in err.message, so the column name in
// the message is what both shapes have in common and what is matched. Any other
// unknown column is a different fault and must keep propagating.
function isMissingFenceNetworkColumnError(err) {
    if (!err) return false
    const text = String((err.sqlMessage || '') + ' ' + (err.message || ''))
    const badField = err.code === 'ER_BAD_FIELD_ERROR' || err.errno === 1054
        || /\b1054\b/.test(text) || /unknown column/i.test(text)
    if (!badField) return false
    return new RegExp("unknown column\\s+['\"`]?" + FENCE_NETWORK_COLUMN + "['\"`]?", 'i').test(text)
}

// Said once, at the moment the fallback is taken, because the operator's next
// question is always "why did my other networks' fences go". Names the column
// and the hub release that carries it so the fix is a hub upgrade plus the
// fleet migration, not a guess.
function warnPriceFenceNetworkColumnMissing(ticker, hubDbName) {
    logger.warn("WARNING: " + hubDbName + "." + PRICE_FENCE_TABLE + " has no `" + FENCE_NETWORK_COLUMN
        + "` column, so the network-scoped clear could not run.")
    logger.warn("  That column (and the (network, source_chain) key) arrives with xchain-hub "
        + FENCE_NETWORK_COLUMN_HUB_FLOOR + "; this hub is older.")
    logger.warn("  Falling back to the chain-only delete: DELETE FROM " + PRICE_FENCE_TABLE
        + " WHERE source_chain = '" + ticker + "'")
    logger.warn("  On this pre-" + FENCE_NETWORK_COLUMN_HUB_FLOOR + " schema the fence is keyed by chain alone, so that is"
        + " the whole row. Once the hub is upgraded and the fleet migration has run, the clear scopes to one network again.")
}

// The fence's network scope, folded the same way the hub folds it
// (xchain-hub/src/db/index.js normalizeFenceNetwork) so a reset and the hub that wrote
// the row agree on the key. Both sides lowercase and trim; anything else and the
// reset would delete nothing and report success.
function normalizeFenceNetwork(network) {
    return typeof network === 'string' ? network.trim().toLowerCase() : ''
}

// One wording for every "could not clear it here" branch, so the operator always
// gets the exact statement to run on whichever DB the hub actually uses. The
// network clause is part of that statement: without it the hand-run DELETE drops
// every network's fence for the chain, which is the failure the column was added
// to remove.
function warnPriceFenceNotCleared(ticker, fenceNetwork, reason) {
    logger.warn(redactSecrets("WARNING: the hub price ingest fence for " + ticker + " was NOT cleared (" + reason + ")."))
    logger.warn("  A reset indexer DB restarts its push_generations at 0, and the hub DROPS every")
    logger.warn("  price push at or below its recorded retraction generation, taking that chain's price rail")
    logger.warn("  and the native-fee / XCHAIN-USD path down with it. Run this on the hub's OWN database")
    logger.warn("  before the indexer resumes pushing:")
    logger.warn("    " + manualClearStatement(ticker, fenceNetwork))
    logger.warn("  Keep the network clause: it is what leaves every OTHER network's fence for "
        + ticker + " in place.")
}

module.exports = { resetDatabases, clearHubPriceIngestWatermark, configureDependencies }
