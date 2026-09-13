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
 * XChain Node - information_schema reads
 *
 * Every statement this CLI runs against MariaDB's catalogue: does a database
 * exist, does a table exist in it, how many tables does it hold, how big is it,
 * when were its tables created.
 *
 * WHY THE STATEMENTS ARE BUILDERS AND NOT METHODS ON THE STORE. The store owns
 * one pool against this stack's own xchain_node database. These reads go to
 * OTHER services' databases, reached by shelling into a MariaDB container or by
 * a one-shot native connection, and the caller picks which. So the caller keeps
 * its runner and the SQL lives here, which is the part that has to be in one
 * place: a statement is text, and text nobody can find is text that gets
 * rewritten slightly differently the next time it is needed.
 *
 ********************************************************************/

const { escapeSqlStringLiteral } = require('../utils/sql_safety')

/** How many schemas carry this exact name: 1 when the database exists, 0 when it does not. */
function schemaExistsSql(databaseName) {
    return "SELECT COUNT(SCHEMA_NAME) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = '" + databaseName + "'"
}

/** How many tables a database holds. 0 is a real answer and means an untouched schema. */
function tableCountSql(databaseLiteral) {
    return 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ' + databaseLiteral
}

/**
 * Whether one named table exists in one database. TABLE_SCHEMA + TABLE_NAME is
 * unique here, so the answer is 0 or 1 and anything else means the output is not
 * an answer to the question that was asked.
 */
function tableExistsSql(databaseLiteral, tableLiteral) {
    return tableCountSql(databaseLiteral) + ' AND TABLE_NAME = ' + tableLiteral
}

/** The same question asked of several tables at once; the answer is how many of them exist. */
function tablesExistSql(databaseLiteral, tableNames) {
    return tableCountSql(databaseLiteral) + ' AND TABLE_NAME IN ('
        + tableNames.map(escapeSqlStringLiteral).join(', ') + ')'
}

/**
 * Bytes on disk for a whole database, used only to size a progress bar, so an
 * approximate figure from the catalogue beats an exact one that costs a scan.
 */
function schemaSizeSql(dbName) {
    return `SELECT SUM(DATA_LENGTH + INDEX_LENGTH) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${dbName}'`
}

/**
 * Table creation times as EPOCH SECONDS, for the named tables of one schema.
 *
 * THE EPOCH CONVERSION IS THE WHOLE POINT, and a plain CREATE_TIME instead of
 * this query silently passes survivors, which a real run proved:
 *
 *   MariaDB returns CREATE_TIME as a zone-less DATETIME in the SESSION time zone. The
 *   driver then builds a JS Date by interpreting those digits in the CLIENT's LOCAL zone.
 *   On a host at UTC-7 a table created at 23:26:38 UTC came back as 06:26:38 the next day
 *   UTC, i.e. seven hours in the future, so a table that predated the window compared as
 *   fresh and the sweep reported PASS on a store that had not rebased at all.
 *
 * Asking the server for epoch seconds under a pinned UTC session removes every zone from
 * the path: no driver conversion, no client locale, and nothing left for the caller to
 * guess. The failure direction is what makes it worth the ceremony - the naive version
 * does not error, it certifies a fork.
 */
function createTimeSql(tableCount) {
    return 'SELECT TABLE_NAME AS table_name, UNIX_TIMESTAMP(CREATE_TIME) AS create_time '
         + 'FROM information_schema.TABLES '
         + 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (' + new Array(tableCount).fill('?').join(', ') + ')'
}

/** The session pin the create-time read above depends on. Run it on the same connection, first. */
const SESSION_UTC_SQL = "SET SESSION time_zone = '+00:00'"

module.exports = {
    schemaExistsSql,
    tableCountSql,
    tableExistsSql,
    tablesExistSql,
    schemaSizeSql,
    createTimeSql,
    SESSION_UTC_SQL
}
