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
 * XChain Node - Bootstrap Service
 * Create and restore bootstrap files for XChain modules
 * Supported: xchain-utxo-tracker, xchain-decoder, xchain-indexer
 ********************************************************************/

let { execFile }      = require('child_process')
const { promisify }   = require('util')
let execFileAsync     = promisify(execFile)

let { XChainService, EXTERNAL_DB } = require('../../config')
const { tableExistsSql } = require('../../db/information_schema')
const { rowCountSql } = require('../../db/blocks')
let { getModuleDatabaseName, getUtxoTrackerVolumeName } = require('../config_service')
let { getDatabaseContainerId, getDatabaseContainerPresence, getExternalDbConfig, executeNativeMariaDbCommand } = require('../database_service')
let databaseService = require('../database_service')
const { dockerMariadbArgs, mariadbEnv } = require('../../utils/docker_mariadb')
const { redactSecrets } = require('../../utils/helpers')
const { getLogger } = require('../../observability/logger')
let logger = getLogger()

function configureDependencies(dependencies) {
    execFile = dependencies.childProcess.execFile
    execFileAsync = promisify(execFile)
    ;({ XChainService, EXTERNAL_DB } = dependencies.config)
    ;({ getModuleDatabaseName, getUtxoTrackerVolumeName } = dependencies.configService)
    databaseService = dependencies.databaseService
    ;({ getDatabaseContainerId, getDatabaseContainerPresence, getExternalDbConfig, executeNativeMariaDbCommand } = databaseService)
    logger = dependencies.logger
}

// The three answers a freshness probe may give. Only EMPTY is a positive
// finding of "there is nothing here to lose", and only EMPTY may authorise the
// destructive restore path. UNKNOWN keeps an inspection FAILURE distinct from
// that finding: conflated, a transient MariaDB or docker fault during a rolling
// update reads a populated store as fresh and drives an unforced DROP DATABASE
// + restore over it.
const FRESHNESS_EMPTY     = 'empty'
const FRESHNESS_POPULATED = 'populated'
const FRESHNESS_UNKNOWN   = 'unknown'

// Say so once, in the operator's log, whenever a probe could not answer. Silent
// UNKNOWNs are how the old conflation stayed invisible for so long.
function reportUnknownFreshness(subject, err) {
    logger.info(`WARNING: could not determine whether ${subject} already holds data `
        + `(${redactSecrets(String((err && err.message) || err))}).`)
    logger.info('  Treating it as NOT empty: automatic bootstrap restore is skipped rather than')
    logger.info('  risking a DROP over populated data. Re-run once the inspection works, or set')
    logger.info('  FORCE_BOOTSTRAP to restore anyway.')
}

// The in-container listing behind utxoTrackerVolumeFreshness, kept as a named
// constant so a test can run the exact string a real shell sees.
//
// It must EXIT NON-ZERO when the listing fails. `ls -A /data | head -1` cannot:
// a pipeline exits with its LAST stage's status, so a failed `ls` still leaves
// head exiting 0 with empty stdout, the exec resolves, and empty stdout reads
// as a confirmed-empty volume. Capturing into a variable puts `ls`'s own status
// on the assignment, so a failed listing rejects the exec and lands in the
// UNKNOWN catch. stderr is deliberately NOT suppressed: the reason travels into
// the rejection message and reaches the operator warning. (Alpine's /bin/sh is
// busybox ash, so this stays POSIX and does not lean on `set -o pipefail`.)
const UTXO_TRACKER_LISTING_COMMAND = 'entries=$(ls -A /data) || exit 1; printf %s "$entries" | head -n 1'

// Freshness of the utxo-tracker LevelDB volume. Used as a race-free gate: it
// must be checked BEFORE the container starts, because a freshly-started tracker
// creates an (empty) LevelDB immediately.
//
// EMPTY when docker itself says there is no such volume, or the volume is there
// and holds nothing. POPULATED when it holds anything. UNKNOWN for every other
// inspection failure, which is NOT evidence of absence.
async function utxoTrackerVolumeFreshness(coin, network) {
    // The shared helper applies NODE_PREFIX so freshness is read from the
    // selected stack.
    const volumeName = getUtxoTrackerVolumeName(coin, network)
    try {
        await execFileAsync('docker', ['volume', 'inspect', volumeName])
    } catch (err) {
        if (/no such volume/i.test(String((err && (err.message || err.stderr)) || ''))) {
            return FRESHNESS_EMPTY // docker SAID it is absent: a fresh install
        }
        reportUnknownFreshness(`the Docker volume ${volumeName}`, err)
        return FRESHNESS_UNKNOWN
    }
    try {
        const { stdout } = await execFileAsync('docker',
            ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c', UTXO_TRACKER_LISTING_COMMAND])
        return String(stdout).trim().length > 0 ? FRESHNESS_POPULATED : FRESHNESS_EMPTY
    } catch (err) {
        reportUnknownFreshness(`the Docker volume ${volumeName}`, err)
        return FRESHNESS_UNKNOWN
    }
}

// Freshness of the decoder/indexer MariaDB database. The MariaDB analogue of
// utxoTrackerVolumeFreshness: a fresh install has either no database yet or an
// empty `blocks` table (both decoder and indexer carry a `blocks` table that
// fills as they follow the chain). Used as the freshness gate before the service
// container starts decoding/indexing.
//
// EMPTY only on a successful inspection that found no database, no `blocks`
// table, or no rows. POPULATED on a successful inspection that found rows.
// UNKNOWN whenever the inspection itself failed or answered something that will
// not parse: a lookup error says nothing about how much data the database holds,
// and reading it as EMPTY is what let a rolling-update blip authorise
// DROP DATABASE over a populated store.
async function mariaDbModuleFreshness(coin, network, module) {
    const dbName = getModuleDatabaseName(module, coin, network)
    if (EXTERNAL_DB) return externalMariaFreshness(dbName)
    const local = await prepareLocalMariaFreshness(coin, network, dbName)
    if (Object.prototype.hasOwnProperty.call(local, 'freshness')) return local.freshness
    return inspectLocalMariaFreshness(dbName, local.dbContainerId, local.rootPassword)
}

// Row counts and table counts are only evidence when they parse: an answer
// that does not parse becomes null, never a number that lands on "fresh".
function countOf(out) {
    const n = parseInt(String(out).trim(), 10)
    return Number.isFinite(n) ? n : null
}

async function externalMariaFreshness(dbName) {
    // External-DB mode has no local `xchain-node-database` container, so the
    // container-id lookup below always returns null and would report "fresh"
    // regardless of how much data the external DB holds, re-triggering the
    // bootstrap DROP/restore over a populated database on every install/update.
    // Check freshness over the native connection instead (mirrors the
    // EXTERNAL_DB branch in restoreBootstrapMariaDb / resetDatabases).
    try {
        const externalCfg = await getExternalDbConfig()
        const existsQuery = tableExistsSql(`'${dbName}'`, "'blocks'")
        const tables = countOf(await executeNativeMariaDbCommand(externalCfg, existsQuery, '-BN'))
        if (tables === null) throw new Error(`unparseable table count for ${dbName}.blocks`)
        if (tables === 0) return FRESHNESS_EMPTY
        const countQuery = rowCountSql(dbName)
        const rows = countOf(await executeNativeMariaDbCommand(externalCfg, countQuery, '-BN'))
        if (rows === null) throw new Error(`unparseable row count for ${dbName}.blocks`)
        return rows > 0 ? FRESHNESS_POPULATED : FRESHNESS_EMPTY
    } catch (err) {
        reportUnknownFreshness(`the external database ${dbName}`, err)
        return FRESHNESS_UNKNOWN
    }
}

async function prepareLocalMariaFreshness(coin, network, dbName) {
    const { askMariadbRootPassword } = databaseService
    // Ask the tri-state probe FIRST. getDatabaseContainerId() answers null for
    // an inspect that failed as readily as for a container that is not there,
    // and only the second of those is a fresh install; the first authorised a
    // DROP DATABASE over a populated store.
    let presence
    try {
        presence = await getDatabaseContainerPresence()
    } catch (err) {
        reportUnknownFreshness(`the database ${dbName}`, err)
        return { freshness: FRESHNESS_UNKNOWN }
    }
    if (presence !== 'exists' && presence !== 'gone') {
        reportUnknownFreshness(`the database ${dbName}`,
            new Error('could not determine whether the database container exists'))
        return { freshness: FRESHNESS_UNKNOWN }
    }
    if (presence === 'gone') return { freshness: FRESHNESS_EMPTY } // docker SAID it is absent: a fresh install

    let dbContainerId
    try {
        dbContainerId = await getDatabaseContainerId()
    } catch (err) {
        reportUnknownFreshness(`the database ${dbName}`, err)
        return { freshness: FRESHNESS_UNKNOWN }
    }
    // The container existed a moment ago, so a null id here is a lookup that
    // failed, not an absence, and must not authorise the restore.
    if (!dbContainerId) {
        reportUnknownFreshness(`the database ${dbName}`,
            new Error('the database container is present but its id could not be resolved'))
        return { freshness: FRESHNESS_UNKNOWN }
    }

    let rootPassword
    try {
        rootPassword = await askMariadbRootPassword(coin, network)
    } catch (err) {
        reportUnknownFreshness(`the database ${dbName}`, err)
        return { freshness: FRESHNESS_UNKNOWN }
    }
    return { dbContainerId, rootPassword }
}

async function inspectLocalMariaFreshness(dbName, dbContainerId, rootPassword) {
    try {
        // Does the `blocks` table exist? (DB or table absent means fresh)
        const existsQuery = tableExistsSql(`'${dbName}'`, "'blocks'")
        const { stdout: tblOut } = await execFileAsync(
            'docker', dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', '-BN', '-e', existsQuery, 'information_schema']),
            { env: mariadbEnv(rootPassword) }
        )
        const tables = countOf(tblOut)
        if (tables === null) throw new Error(`unparseable table count for ${dbName}.blocks`)
        if (tables === 0) return FRESHNESS_EMPTY

        // Table exists: does it hold any rows?
        const countQuery = rowCountSql(dbName)
        const { stdout: cntOut } = await execFileAsync(
            'docker', dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', '-BN', '-e', countQuery]),
            { env: mariadbEnv(rootPassword) }
        )
        const rows = countOf(cntOut)
        if (rows === null) throw new Error(`unparseable row count for ${dbName}.blocks`)
        return rows > 0 ? FRESHNESS_POPULATED : FRESHNESS_EMPTY
    } catch (err) {
        reportUnknownFreshness(`the database ${dbName}`, err)
        return FRESHNESS_UNKNOWN
    }
}

module.exports = {
    configureDependencies,
    FRESHNESS_EMPTY,
    FRESHNESS_POPULATED,
    FRESHNESS_UNKNOWN,
    UTXO_TRACKER_LISTING_COMMAND,
    utxoTrackerVolumeFreshness,
    mariaDbModuleFreshness
}
