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
 ********************************************************************/

const fs = require('fs')

const { EXTERNAL_DB } = require('../../config')
const { tableCountSql, tableExistsSql } = require('../../db/information_schema')
const { appliedMigrationsSql } = require('../../db/migrations')
const { migrationFiles } = require('../../utils/migration_files')
const { getDockerContainerImageName } = require('../config_service')
const { readMigrateCli, migrateCliPathFor } = require('../../utils/indexer_migrate_cli')

const SKIP_ENV     = 'XCHAIN_NODE_SKIP_MIGRATION_PRECONDITION'
const LEDGER_TABLE = 'schema_migrations'

/**
 * Does this migration file's header declare itself a deploy precondition?
 *
 * Prologue-anchored: the scan stops at the first non-blank, non-comment line, so
 * the token can only arm the flag from the leading comment block and never from
 * body prose or a data literal. Widening that to the whole file is how a
 * migration that merely DISCUSSES the convention would start refusing deploys.
 *
 * Twin of xchain-indexer src/db/database/migration_registry.js and xchain-decoder
 * src/db/migration_preconditions.js (both Database.migrationDeclaresDeployPrecondition).
 * Duplicated, not shared: this tool reads a cloned source tree whose dependencies are
 * not installed, so it cannot require either module. Keep all three in step.
 */
function migrationDeclaresDeployPrecondition(raw) {
    const prologue = []
    for (const line of String(raw).split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('--')) { prologue.push(line); continue }
        break
    }
    return /^\s*--\s*xchain:migration\b[^\n]*\bdeploy-precondition\s*=\s*required\b/im.test(prologue.join('\n'))
}

/**
 * The `mode=` a migration header declares: 'auto', or 'manual' for anything else,
 * because the runners gate every non-auto file and an unscoped operator run applies it.
 * Prologue-anchored like migrationDeclaresDeployPrecondition, so a token in body prose
 * or a data literal cannot answer for the file.
 *
 * Twin of Database.prototype.migrationMode in xchain-indexer src/db/database/migration_scan.js
 * and xchain-decoder src/db/migration_statements.js, duplicated for the reason given
 * above. Keep the scan, the tag regex and the default in step.
 */
function migrationMode(raw) {
    const prologue = []
    for (const line of String(raw).split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('--')) { prologue.push(line); continue }
        break
    }
    const m = prologue.join('\n').match(/^\s*--\s*xchain:migration\b[^\n]*\bmode\s*=\s*(auto|manual)\b/im)
    return m ? m[1].toLowerCase() : 'manual'
}

/**
 * Every gated (not mode=auto) migration in `dir` that the ledger has not recorded,
 * sorted. This is the blast radius of an UNSCOPED migrate run against that
 * database: the runner applies every pending manual file, not just the one an
 * operator names. The refusal names that whole set, so the consequence is on
 * screen rather than left for the operator to discover.
 */
function pendingManualMigrations(dir, applied) {
    return migrationFiles(dir).filter(([f, file]) => {
        if (applied && applied.has(f)) return false
        try {
            return migrationMode(fs.readFileSync(file, 'utf8')) === 'manual'
        } catch {
            return false
        }
    }).map(([f]) => f)
}

/**
 * Read the running container's migrate CLI through its read-only status contract.
 * `rows` is the file list THAT build carries, kept only when the response passed
 * every check, because the refusal's remedy runs on that build and not on the
 * source being deployed.
 */
async function readRunningBuildMigrationStatus(container, deps = {}) {
    const refused = { supportsPerFile: false, rows: null }
    try {
        const cat = deps.getDockerContainerFileCat || require('../docker_service').getDockerContainerFileCat
        const found = await readMigrateCli(cat, container)
        if (!found) return { supportsPerFile: null, rows: null }
        if (!/(['"])--status\1/.test(found.source)) return refused

        const execContainer = deps.execContainer || require('../docker_service').execContainer
        let raw
        try {
            raw = await execContainer(container, ['node', found.cliPath, '--status', '--json'])
        } catch {
            return refused
        }

        let status
        try {
            status = JSON.parse(String(raw))
        } catch {
            return refused
        }
        if (!status || Array.isArray(status) || typeof status !== 'object') return refused
        if (typeof status.database !== 'string' || status.database.length === 0) return refused
        if (!Array.isArray(status.migrations)) return refused
        for (const row of status.migrations) {
            if (!row || Array.isArray(row) || typeof row !== 'object') return refused
            if (typeof row.file !== 'string' || row.file.length === 0) return refused
            if (typeof row.applied !== 'boolean') return refused
        }

        const counts = ['total', 'applied', 'pending']
        if (!counts.every(k => Number.isInteger(status[k]) && status[k] >= 0)) return refused
        const applied = status.migrations.filter(row => row.applied).length
        const consistent = status.total === status.migrations.length &&
            status.applied === applied && status.pending === status.total - applied
        if (!consistent) return refused
        return {
            supportsPerFile: true,
            rows: status.migrations.map(row => ({ file: row.file, applied: row.applied, mode: row.mode }))
        }
    } catch {
        return { supportsPerFile: null, rows: null }
    }
}

/** Verify the running container's migrate CLI through its read-only status contract. */
async function runningBuildSupportsPerFileMigrations(container, deps = {}) {
    return (await readRunningBuildMigrationStatus(container, deps)).supportsPerFile
}

/**
 * The gated files an unscoped migrate run inside the running build would apply:
 * its own pending rows (a row with no mode is the runners' manual default),
 * minus any whose end state the database already embodies.
 */
function runningBuildPendingManual(rows, applied) {
    return rows.filter(row => !row.applied && (row.mode == null || row.mode === 'manual') &&
        !(applied && applied.has(row.file))).map(row => row.file)
}

/**
 * Every migration filename in `dir` whose header declares a deploy precondition,
 * sorted. A missing directory yields [] - a module (or a ref) with no migrations
 * declares no preconditions, which is not an error.
 */
function listDeployPreconditionMigrations(dir) {
    return migrationFiles(dir).filter(([, file]) => {
        try {
            return migrationDeclaresDeployPrecondition(fs.readFileSync(file, 'utf8'))
        } catch {
            return false
        }
    }).map(([f]) => f)
}

function databaseLiteral(database) {
    // The name comes from getModuleDatabaseName, but it reaches SQL as text (an
    // identifier cannot be bound), so gate it on the same allowlist the
    // provisioning DDL uses rather than trusting its provenance.
    return /^[A-Za-z0-9_]+$/.test(String(database)) ? "'" + database + "'" : null
}

/**
 * Read the applied-migration ledger of one module database.
 *
 * Returns { state: 'ledger', applied: Set<string> } when the ledger was read,
 * { state: 'empty-database' } when the schema holds no tables at all (or does
 * not exist yet), and { state: 'unreadable', reason } for everything else. The
 * three are deliberately distinct: only the middle one is safe to proceed on.
 *
 * WHY ROOT AND NOT THE MODULE'S OWN ACCOUNT
 * -----------------------------------------
 * The first cut of this guard connected with the module's generated credentials
 * (INDEXER_DB_USER/PASS) over the published port. Run against the live regtest
 * stack it produced `Access denied for user 'xchain_indexer_bitcoin_regtest'`,
 * i.e. an unknown-state REFUSAL of a perfectly deployable update - the sidecar
 * password and the live account had drifted, which is a documented recurring
 * condition here and has nothing to do with migrations. A guard that fails
 * closed on a routine credential drift blocks every deploy and gets switched
 * off. So this uses the same root-credential runner every other DB read in
 * xchain-node uses (see clearHubPriceIngestWatermark), which the update path
 * already resolves non-interactively for its own credential parity pass.
 */
async function readAppliedMigrations({ database, coin, network }, deps = {}) {
    const literal = databaseLiteral(database)
    if (!literal) return { state: 'unreadable', reason: 'refusing to query a database name that is not a plain identifier' }

    let runner = deps.runner
    try {
        if (!runner) {
            const {
                getExternalDbConfig, executeNativeMariaDbCommand,
                executeDockerMariaDbCommand, askMariadbRootPassword, getDatabaseContainerId
            } = require('../database_service')
            if (EXTERNAL_DB) {
                const cfg = await getExternalDbConfig()
                runner = (sql) => executeNativeMariaDbCommand(cfg, sql, '-B -N')
            } else {
                const containerId = await getDatabaseContainerId()
                if (!containerId) return { state: 'unreadable', reason: 'no MariaDB container found on this host' }
                const rootPassword = await askMariadbRootPassword(coin, network)
                runner = (sql) => executeDockerMariaDbCommand(containerId, rootPassword, sql, '-B -N')
            }
        }

        const rawTableCount = String(await runner(tableCountSql(literal))).trim()
        const tableCount = parseInt(rawTableCount, 10)
        // An unreadable or non-numeric count (empty output, a driver notice, NaN)
        // is not the same fact as a genuinely empty schema: `!tableCount` is true
        // for both 0 and NaN, and collapsing them here is exactly the outage this
        // guard exists to prevent - an unknown migration state waved through as
        // "empty" instead of refused. Only a real, parseable zero counts as empty.
        if (Number.isNaN(tableCount)) {
            return { state: 'unreadable', reason: 'could not read a table count for ' + database + ' (got ' + JSON.stringify(rawTableCount) + ')' }
        }
        // No tables at all: either the database does not exist yet or it is
        // untouched. A fresh install builds its schema from src/sql, which already
        // carries the post-migration widths, so it cannot be behind.
        if (tableCount === 0) return { state: 'empty-database' }

        const rawHasLedger = String(await runner(
            tableExistsSql(literal, "'" + LEDGER_TABLE + "'"))).trim()
        const hasLedger = parseInt(rawHasLedger, 10)
        // Same collapse shape applies to the ledger-presence count: an unreadable
        // or NaN result must refuse, not be read as "no ledger table".
        if (Number.isNaN(hasLedger)) {
            return { state: 'unreadable', reason: 'could not read whether ' + database + ' has a ' + LEDGER_TABLE + ' ledger (got ' + JSON.stringify(rawHasLedger) + ')' }
        }
        // Tables but no ledger: this database predates the migration runner, or is
        // not the database we think it is. Either way its migration state is
        // unknowable, which is the case this guard must not wave through.
        if (!hasLedger) {
            return { state: 'unreadable', reason: database + ' holds ' + tableCount + ' table(s) but no ' + LEDGER_TABLE + ' ledger' }
        }

        const out = String(await runner(appliedMigrationsSql(database, LEDGER_TABLE)))
        const applied = new Set(out.split('\n').map(s => s.trim()).filter(Boolean))
        return { state: 'ledger', applied }
    } catch (err) {
        return { state: 'unreadable', reason: (err && err.message) ? err.message : String(err) }
    }
}

function refusalMessage(module, coin, network, dbName, missing, remedy = {}) {
    const container = getDockerContainerImageName(module, coin, network)
    const files = missing.join(', ')
    const plural = missing.length > 1

    // The remedy runs on the build inside the container, which is the one being
    // REPLACED. Only name the scoped command when that build was confirmed to
    // honour --file; otherwise the command would quietly widen to every pending
    // manual migration, so state that instead of printing it.
    // With the running build's own file list in hand, a file it does not carry
    // (one first shipping in this release) can neither be named to --file there
    // nor be applied by an unscoped run there.
    const carriedSet  = Array.isArray(remedy.runningFiles) ? new Set(remedy.runningFiles) : null
    const carried     = carriedSet ? missing.filter(f => carriedSet.has(f)) : missing
    const notCarried  = carriedSet ? missing.filter(f => !carriedSet.has(f)) : []
    const notCarriedNote = notCarried.length
        ? '\n  The running build in ' + container + ' does not carry ' + notCarried.join(', ') +
          ' (it first ships in the release being deployed), so no migrate run inside that container can apply ' +
          (notCarried.length > 1 ? 'them' : 'it') + '. Apply the statements in ' +
          (notCarried.length > 1 ? 'those files' : 'that file') + ' from the release being deployed by hand, ' +
          'with the writer quiesced, then re-run the update; if this check still refuses because no ledger ' +
          'row records the hand-applied file, set ' + SKIP_ENV + '=1 for that one deploy.'
        : ''

    let instructions
    if (remedy.supportsPerFile === true) {
        instructions = (carried.length
            ? 'apply ' + (carried.length > 1 ? 'them' : 'it') +
              ' deliberately, with the writer quiesced, then re-run the update:\n' +
              carried.map(f => '    docker exec -i ' + container + ' node ' + migrateCliPathFor(container) + ' --file ' + f).join('\n')
            : 'none of ' + (plural ? 'them' : 'it') + ' can be applied by the migrate CLI inside ' + container + '.') +
            notCarriedNote
    } else {
        const wouldApply = (remedy.pendingManual && remedy.pendingManual.length)
            ? remedy.pendingManual
            : carried
        const source = carriedSet ? '' : ' (listed from the source being deployed; that build may differ)'
        instructions = 'DO NOT run `node ' + migrateCliPathFor(container) + '` inside ' + container + '. ' +
            (remedy.supportsPerFile === false
                ? 'That container did not return a valid --status --json response, so --file support is not verified'
                : 'Whether that container\'s build honours --file could not be read, and an unverified capability is not one: it may ignore --file') +
            ' and apply EVERY pending manual migration on ' + dbName + ', which is ' +
            wouldApply.length + ' file(s)' + source + ':\n' +
            wouldApply.map(f => '    ' + f + (carried.includes(f) ? '  (the one you need)' : '')).join('\n') + '\n' +
            '  Apply ' + (plural ? 'the needed files' : 'the needed file') + ' with a build that supports ' +
            '--file, or apply the statement by hand with the writer quiesced, then re-run the update.' +
            notCarriedNote
    }

    return 'update refused: the ' + module + ' source about to be deployed asserts migration' +
        (plural ? 's' : '') + ' ' + files + ' at startup, but ' + dbName +
        ' has not applied ' + (plural ? 'them' : 'it') + '. Deploying now replaces a working ' +
        'container with one that crash-loops on boot (the 2026-08-09 mainnet halt: all three indexers went to ' +
        'Restarting(1) on exactly this). These migrations are operator-gated on purpose - ' +
        instructions + '\n' +
        '  Take a fresh backup first: DEPLOY-ORDER.md says so for every migration-bearing deploy, ' +
        'and the coin boxes back up only WEEKLY. ' +
        'Set ' + SKIP_ENV + '=1 to override.'
}

module.exports = {
    migrationDeclaresDeployPrecondition,
    migrationMode,
    pendingManualMigrations,
    runningBuildSupportsPerFileMigrations,
    readRunningBuildMigrationStatus,
    runningBuildPendingManual,
    listDeployPreconditionMigrations,
    readAppliedMigrations,
    refusalMessage
}
