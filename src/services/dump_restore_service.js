/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { spawn } = require('child_process')
const { Writable } = require('stream')
const { pipeline } = require('stream/promises')
const config = require('../config')
const { db } = require('../state')
const { getDefaultConfig, getModuleDatabaseName } = require('./config_service')
const { getDatabaseContainerId, getExternalDbConfig, askMariadbRootPassword } = require('./database_service')
const { stopContainer, startContainer, getContainerStopSettings } = require('./docker_service')
const { stopModuleContainer } = require('./stop_budget_service')
const { confirmDestructiveReset } = require('../operations/module_operations/repo_refs')
const { configuredDatabaseName } = require('../utils/module_database_name')
const { assertSafeDbIdentifier } = require('../utils/sql_safety')
const { dockerMariadbArgs, mariadbEnv } = require('../utils/docker_mariadb')
const { getLogger } = require('../observability/logger')
const {
    dropRestoreDatabaseSql,
    createRestoreDatabaseSql,
    grantRestoreDatabaseSql,
    flushRestorePrivilegesSql,
    restoreTableCountSql,
    restoreBlockSummarySql
} = require('../db/dump_restore')
const { PING_SQL } = require('../db/connectivity')

const DUMP_SUFFIX = '.sql.gz'
const TAIL_BYTES = 64 * 1024
const SUPPORTED_SERVICES = [config.XChainService.XCHAIN_DECODER, config.XChainService.XCHAIN_INDEXER]

function defaultDependencies() {
    return {
        fs, path, zlib, spawn, pipeline, Writable, config, db,
        getDefaultConfig, getModuleDatabaseName, getDatabaseContainerId, getExternalDbConfig,
        askMariadbRootPassword, dockerMariadbArgs,
        stopContainer, startContainer, getContainerStopSettings, stopModuleContainer,
        confirmDestructiveReset, configuredDatabaseName, assertSafeDbIdentifier, mariadbEnv,
        logger: getLogger()
    }
}

function validateTarget(service, chain, network, options, deps) {
    if (!SUPPORTED_SERVICES.includes(service)) {
        throw new Error(`restore-dump: unsupported service '${service}'; expected ${SUPPORTED_SERVICES.join(' or ')}`)
    }
    if (!Object.values(deps.config.Coin).includes(chain)) {
        throw new Error(`restore-dump: unknown chain '${chain}'`)
    }
    if (!Object.values(deps.config.Network).includes(network)) {
        throw new Error(`restore-dump: unknown network '${network}'`)
    }
    if (network === deps.config.Network.MAINNET && !options.allowMainnet) {
        throw new Error('restore-dump: refusing mainnet restore without --allow-mainnet')
    }
}

function dumpDatabasePart(filePath, deps) {
    const base = deps.path.basename(filePath)
    if (!base.endsWith(DUMP_SUFFIX)) {
        throw new Error('restore-dump: --file must end in .sql.gz')
    }
    const stem = base.slice(0, -DUMP_SUFFIX.length)
    const stampSeparator = stem.lastIndexOf('.')
    if (stampSeparator < 1 || stampSeparator === stem.length - 1) {
        throw new Error('restore-dump: file name must be <database>.<stamp>.sql.gz')
    }
    return stem.slice(0, stampSeparator)
}

// A restore writes only the database it names. The import runs as root, so a
// statement that switches database or names another schema would write there
// and still end in a clean verify. Statements are one per line in a
// mariadb-dump (newlines inside data are escaped), and row data (INSERT and
// REPLACE) is skipped so stored text cannot trip the scan.
const DATABASE_SWITCH = /^\s*(?:USE\b|(?:CREATE|DROP|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:DATABASE|SCHEMA)\b)/i
const ROW_DATA = /^\s*(?:INSERT|REPLACE)\b/i
const QUALIFIED_NAME = /`([^`]+)`\s*\.\s*`/g

function foreignStatement(line, databaseName) {
    if (ROW_DATA.test(line)) return null
    if (DATABASE_SWITCH.test(line)) return line.trim().slice(0, 80)
    if (!databaseName) return null
    QUALIFIED_NAME.lastIndex = 0
    let match
    while ((match = QUALIFIED_NAME.exec(line)) !== null) {
        if (match[1] !== databaseName) return line.trim().slice(0, 80)
    }
    return null
}

async function inspectGzip(filePath, deps, databaseName = null) {
    let tail = Buffer.alloc(0)
    let pending = ''
    let foreign = null
    const scan = text => {
        if (foreign) return
        const lines = (pending + text).split('\n')
        pending = lines.pop()
        for (const line of lines) {
            foreign = foreignStatement(line, databaseName)
            if (foreign) return
        }
        if (pending.length > 1024 * 1024) pending = ''
    }
    const sink = new deps.Writable({
        write(chunk, encoding, callback) {
            tail = Buffer.concat([tail, chunk])
            if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES)
            scan(chunk.toString('latin1'))
            callback()
        },
        final(callback) {
            scan('\n')
            callback()
        }
    })
    try {
        await deps.pipeline(
            deps.fs.createReadStream(filePath),
            deps.zlib.createGunzip(),
            sink
        )
    } catch (err) {
        throw new Error(`restore-dump: gzip integrity check failed (${err.message})`)
    }
    if (foreign) {
        throw new Error(`restore-dump: dump writes outside ${databaseName || 'its own database'}: ${foreign}`)
    }
    if (!/(?:^|\n)-- Dump completed(?: on .*)?\s*$/.test(tail.toString('utf8'))) {
        throw new Error("restore-dump: decompressed dump has no final '-- Dump completed' line")
    }
}

async function preflight(service, chain, network, options, deps) {
    validateTarget(service, chain, network, options, deps)
    if (!options.file) throw new Error('restore-dump: --file is required')
    const filePath = deps.path.resolve(options.file)
    let stats
    try {
        stats = await deps.fs.promises.stat(filePath)
    } catch (err) {
        if (err && err.code === 'ENOENT') throw new Error(`restore-dump: file not found: ${filePath}`)
        throw err
    }
    if (!stats.isFile()) throw new Error(`restore-dump: not a regular file: ${filePath}`)

    const cfg = await deps.getDefaultConfig(service, chain, network)
    const databaseName = deps.configuredDatabaseName(
        service, cfg, deps.getModuleDatabaseName(service, chain, network)
    )
    deps.assertSafeDbIdentifier(databaseName, 'database name')
    const namedDatabase = dumpDatabasePart(filePath, deps)
    if (namedDatabase !== databaseName) {
        throw new Error(`restore-dump: file names database ${namedDatabase}, expected ${databaseName}`)
    }
    await inspectGzip(filePath, deps, databaseName)

    const userKey = service === deps.config.XChainService.XCHAIN_DECODER
        ? 'DECODER_DB_USER'
        : 'INDEXER_DB_USER'
    const databaseUser = cfg[userKey]
    deps.assertSafeDbIdentifier(databaseUser, 'database user')
    let databaseContainerId = null
    let external = null
    let rootPassword = null
    if (deps.config.EXTERNAL_DB) {
        external = await deps.getExternalDbConfig()
    } else {
        databaseContainerId = await deps.getDatabaseContainerId()
        if (!databaseContainerId) throw new Error('restore-dump: MariaDB container not found')
        // Root comes from the CLI's shared resolver (env override, the
        // container's own env, then the stored credential, each verified),
        // not from the container env alone: a database container need not
        // carry MYSQL_ROOT_PASSWORD.
        rootPassword = await deps.askMariadbRootPassword(chain, network)
        if (!rootPassword) throw new Error('restore-dump: no MariaDB root password is available; nothing was stopped or changed')
    }
    const serviceContainerId = await deps.db.getModuleContainerStrict(service, chain, network)
    const context = { databaseContainerId, databaseName, databaseUser, external, filePath, rootPassword, serviceContainerId }
    await probeRootAccess(context, deps)
    return context
}

// A restore that cannot authenticate must refuse before the service is
// stopped: once performRestore has stopped it, any SQL failure leaves it
// stopped by design, even when the failure changed nothing.
async function probeRootAccess(context, deps) {
    try {
        await runSql(context, PING_SQL, deps)
    } catch (err) {
        throw new Error('restore-dump: MariaDB root access check failed; nothing was stopped or changed ' +
            `(${err.message.replace(/^restore-dump: /, '')})`)
    }
}

function containerMariaArgs(containerId, databaseName = null, batch = false, deps = defaultDependencies()) {
    return deps.dockerMariadbArgs(containerId, [
        'mariadb', '-u', 'root',
        ...(batch ? ['-B', '-N'] : []),
        ...(databaseName ? ['--one-database', databaseName] : [])
    ], { interactive: true })
}

function mariaCommand(context, databaseName, batch, deps) {
    if (!context.external) {
        return {
            file: 'docker',
            args: containerMariaArgs(context.databaseContainerId, databaseName, batch, deps),
            env: deps.mariadbEnv(context.rootPassword)
        }
    }
    const external = context.external
    return {
        file: 'mariadb',
        args: [
            '-h', external.host, '-P', String(external.port), '-u', external.root_user,
            ...(batch ? ['-B', '-N'] : []),
            ...(databaseName ? ['--one-database', databaseName] : [])
        ],
        env: deps.mariadbEnv(external.root_password)
    }
}

function runSql(context, sql, deps) {
    return new Promise((resolve, reject) => {
        const command = mariaCommand(context, null, true, deps)
        const options = { stdio: ['pipe', 'pipe', 'pipe'] }
        if (command.env) options.env = command.env
        const child = deps.spawn(command.file, command.args, options)
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.once('error', reject)
        child.once('close', code => {
            if (code === 0) return resolve(stdout.trim())
            reject(new Error(`restore-dump: MariaDB command failed with exit ${code}` +
                (stderr.trim() ? `: ${stderr.trim()}` : '')))
        })
        child.stdin.on('error', () => {})
        child.stdin.end(sql.endsWith(';') ? `${sql}\n` : `${sql};\n`)
    })
}

async function importDump(context, deps) {
    const command = mariaCommand(context, context.databaseName, false, deps)
    const options = { stdio: ['pipe', 'ignore', 'pipe'] }
    if (command.env) options.env = command.env
    const child = deps.spawn(command.file, command.args, options)
    // Keep MariaDB's own error (bounded) so the operator sees which statement failed.
    let stderr = ''
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk })
    const closed = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', code => code === 0
            ? resolve()
            : reject(new Error(`restore-dump: MariaDB import failed with exit ${code}` +
                (stderr.trim() ? `: ${stderr.trim().slice(0, 2048)}` : ''))))
    })
    await Promise.all([
        deps.pipeline(
            deps.fs.createReadStream(context.filePath),
            deps.zlib.createGunzip(),
            child.stdin
        ),
        closed
    ])
}

function parseNonNegativeInteger(text, label) {
    const value = Number(String(text).trim())
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`restore-dump: could not read ${label} from MariaDB`)
    }
    return value
}

async function verifyRestore(context, deps) {
    const tableCount = parseNonNegativeInteger(await runSql(context,
        restoreTableCountSql(context.databaseName), deps),
    'table count')
    const blockResult = String(await runSql(context,
        restoreBlockSummarySql(context.databaseName), deps)).trim().split(/\s+/)
    const blockRows = parseNonNegativeInteger(blockResult[0], 'block row count')
    const maxBlockIndex = blockResult[1] === 'NULL'
        ? 'NULL'
        : parseNonNegativeInteger(blockResult[1], 'maximum block index')
    deps.logger.info(`Verified ${context.databaseName}: tables=${tableCount}, blocks=${blockRows}, max_block_index=${maxBlockIndex}`)
    return { tableCount, blockRows, maxBlockIndex }
}

// Names the state a failed restore leaves behind, so the operator reads
// from the error alone whether the service is down and whether the
// database can still be trusted.
function describeLeftState(phase, context, service, chain, network) {
    const target = `${service} (${chain} ${network})`
    const database = context.databaseName
    switch (phase) {
    case 'stopping':
        return `${target} may be stopped; ${database} was not changed`
    case 'replacing':
        return context.serviceContainerId
            ? `${target} was left stopped because ${database} may be missing or partially imported; ` +
                `restore a sound dump before starting it`
            : `${database} may be missing or partially imported`
    case 'starting':
        return `${database} was restored but ${target} did not start`
    default:
        return `${database} was restored` + (context.serviceContainerId ? ` and ${target} was restarted` : '') +
            ', but the restored contents could not be verified'
    }
}

async function performRestore(context, service, chain, network, deps) {
    let phase = 'stopping'
    try {
        if (context.serviceContainerId) {
            deps.logger.info(`Stopping ${service} container...`)
            await deps.stopModuleContainer(deps.stopContainer, service, chain, network,
                context.serviceContainerId, undefined, deps.getContainerStopSettings)
        }
        // From the first DDL call onward a failure may have left the database
        // absent or partially imported. Keep the service stopped in that case
        // so it cannot resume over an indeterminate store.
        phase = 'replacing'
        await runSql(context, dropRestoreDatabaseSql(context.databaseName), deps)
        await runSql(context, createRestoreDatabaseSql(context.databaseName), deps)
        await importDump(context, deps)
        await runSql(context, grantRestoreDatabaseSql(context.databaseName, context.databaseUser), deps)
        await runSql(context, flushRestorePrivilegesSql(), deps)
        if (context.serviceContainerId) {
            phase = 'starting'
            deps.logger.info(`Starting ${service} container...`)
            await deps.startContainer(context.serviceContainerId)
        }
        phase = 'verifying'
        return await verifyRestore(context, deps)
    } catch (err) {
        const reason = String(err && err.message ? err.message : err).replace(/^restore-dump: /, '')
        throw new Error(`restore-dump: ${reason}; ${describeLeftState(phase, context, service, chain, network)}`)
    }
}

function createDumpRestore(overrides = {}) {
    const deps = { ...defaultDependencies(), ...overrides }
    return async function restoreDump(service, chain, network, options = {}) {
        const context = await preflight(service, chain, network, options, deps)
        if (!options.yes) {
            const confirmed = await deps.confirmDestructiveReset(chain, network, [
                `${service} database (${context.databaseName}) replaced from ${context.filePath}`
            ], { command: 'restore-dump', action: 'destructive restore' })
            if (!confirmed) throw new Error('restore-dump: restore was not confirmed; no data was touched')
        }
        return performRestore(context, service, chain, network, deps)
    }
}

const restoreDump = createDumpRestore()

module.exports = {
    createDumpRestore,
    dumpDatabasePart,
    inspectGzip,
    restoreDump,
    validateTarget,
    containerMariaArgs
}
