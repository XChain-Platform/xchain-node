/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'

function dropRestoreDatabaseSql(databaseName) {
    return `DROP DATABASE IF EXISTS \`${databaseName}\``
}

function createRestoreDatabaseSql(databaseName) {
    return `CREATE DATABASE \`${databaseName}\``
}

function grantRestoreDatabaseSql(databaseName, databaseUser) {
    return `GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO '${databaseUser}'@'%'`
}

function flushRestorePrivilegesSql() {
    return 'FLUSH PRIVILEGES'
}

function restoreTableCountSql(databaseName) {
    return `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${databaseName}'`
}

function restoreBlockSummarySql(databaseName) {
    return `SELECT COUNT(*), MAX(block_index) FROM \`${databaseName}\`.blocks`
}

module.exports = {
    dropRestoreDatabaseSql,
    createRestoreDatabaseSql,
    grantRestoreDatabaseSql,
    flushRestorePrivilegesSql,
    restoreTableCountSql,
    restoreBlockSummarySql
}
