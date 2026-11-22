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
const { getDatabaseContainerId } = require('./database_service')
const { stopContainer, startContainer, getContainerStopSettings } = require('./docker_service')
const { stopModuleContainer } = require('./stop_budget_service')
const { confirmDestructiveReset } = require('../operations/module_operations/repo_refs')
const { configuredDatabaseName } = require('../utils/module_database_name')
const { assertSafeDbIdentifier } = require('../utils/sql_safety')
const { getLogger } = require('../observability/logger')
const {
    dropRestoreDatabaseSql,
    createRestoreDatabaseSql,
    grantRestoreDatabaseSql,
    flushRestorePrivilegesSql,
    restoreTableCountSql,
    restoreBlockSummarySql
} = require('../db/dump_restore')

const DUMP_SUFFIX = '.sql.gz'
const TAIL_BYTES = 64 * 1024
const SUPPORTED_SERVICES = [config.XChainService.XCHAIN_DECODER, config.XChainService.XCHAIN_INDEXER]

function defaultDependencies() {
    return {
        fs, path, zlib, spawn, pipeline, Writable, config, db,
        getDefaultConfig, getModuleDatabaseName, getDatabaseContainerId,
        stopContainer, startContainer, getContainerStopSettings, stopModuleContainer,
        confirmDestructiveReset, configuredDatabaseName, assertSafeDbIdentifier,
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

async function inspectGzip(filePath, deps) {
    let tail = Buffer.alloc(0)
    const sink = new deps.Writable({
        write(chunk, encoding, callback) {
            tail = Buffer.concat([tail, chunk])
            if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES)
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
    await inspectGzip(filePath, deps)

    const userKey = service === deps.config.XChainService.XCHAIN_DECODER
        ? 'DECODER_DB_USER'
        : 'INDEXER_DB_USER'
    const databaseUser = cfg[userKey]
    deps.assertSafeDbIdentifier(databaseUser, 'database user')
    const databaseContainerId = await deps.getDatabaseContainerId()
    if (!databaseContainerId) throw new Error('restore-dump: MariaDB container not found')
    const serviceContainerId = await deps.db.getModuleContainerStrict(service, chain, network)
    return { databaseContainerId, databaseName, databaseUser, filePath, serviceContainerId }
}

function containerMariaArgs(containerId, databaseName = null, batch = false) {
    const script = 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mariadb -u root' +
        (batch ? ' -B -N' : '') +
        (databaseName ? ' "$1"' : '')
    const args = ['exec', '-i', containerId, 'sh', '-c', script]
    if (databaseName) args.push('xchain-restore', databaseName)
    return args
}

function runSql(context, sql, deps) {
    return new Promise((resolve, reject) => {
        const child = deps.spawn('docker', containerMariaArgs(context.databaseContainerId, null, true), {
            stdio: ['pipe', 'pipe', 'pipe']
        })
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
    const child = deps.spawn('docker', containerMariaArgs(
        context.databaseContainerId, context.databaseName
    ), { stdio: ['pipe', 'ignore', 'pipe'] })
    child.stderr.on('data', () => {})
    const closed = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', code => code === 0
            ? resolve()
            : reject(new Error(`restore-dump: MariaDB import failed with exit ${code}`)))
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

async function performRestore(context, service, chain, network, deps) {
    let stopped = false
    if (context.serviceContainerId) {
        deps.logger.info(`Stopping ${service} container...`)
        await deps.stopModuleContainer(deps.stopContainer, service, chain, network,
            context.serviceContainerId, undefined, deps.getContainerStopSettings)
        stopped = true
    }
    // From the first DDL call onward a failure may have left the database
    // absent or partially imported. Keep the service stopped in that case so
    // it cannot resume over an indeterminate store.
    await runSql(context, dropRestoreDatabaseSql(context.databaseName), deps)
    await runSql(context, createRestoreDatabaseSql(context.databaseName), deps)
    await importDump(context, deps)
    await runSql(context, grantRestoreDatabaseSql(context.databaseName, context.databaseUser), deps)
    await runSql(context, flushRestorePrivilegesSql(), deps)
    if (stopped) {
        deps.logger.info(`Starting ${service} container...`)
        await deps.startContainer(context.serviceContainerId)
    }
    return verifyRestore(context, deps)
}

function createDumpRestore(overrides = {}) {
    const deps = { ...defaultDependencies(), ...overrides }
    return async function restoreDump(service, chain, network, options = {}) {
        const context = await preflight(service, chain, network, options, deps)
        if (!options.yes) {
            const confirmed = await deps.confirmDestructiveReset(chain, network, [
                `${service} database (${context.databaseName}) replaced from ${context.filePath}`
            ])
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
    containerMariaArgs
}
