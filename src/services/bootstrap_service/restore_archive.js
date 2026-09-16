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

let fs                    = require('fs')
const path                = require('path')
let zlib                  = require('zlib')
let { execFile, spawn }   = require('child_process')
const { promisify }       = require('util')
const { PassThrough }     = require('stream')
let execFileAsync         = promisify(execFile)

let { XChainService, EXTERNAL_DB } = require('../../config')
let { db } = require('../../state')
let { getDefaultConfig, getModuleDatabaseName, getUtxoTrackerVolumeName } = require('../config_service')
let { stopContainer, startContainer } = require('../docker_service')
let { getDatabaseContainerId, ensureDatabasePool, getExternalDbConfig, executeNativeMariaDbCommand } = require('../database_service')
let databaseService = require('../database_service')
const { dockerMariadbArgs, mariadbEnv } = require('../../utils/docker_mariadb')
let { checkBootstrapSignature, ensureVerifiedInnerArchive } = require('./archive_signing')
let { startProgress, getWorkDir } = require('./workspace')
const { getLogger } = require('../../observability/logger')
let logger = getLogger()

function configureDependencies(dependencies) {
    fs = dependencies.fs
    zlib = dependencies.zlib
    ;({ execFile, spawn } = dependencies.childProcess)
    execFileAsync = promisify(execFile)
    ;({ XChainService, EXTERNAL_DB } = dependencies.config)
    ;({ db } = dependencies.state)
    ;({ getDefaultConfig, getModuleDatabaseName, getUtxoTrackerVolumeName } = dependencies.configService)
    ;({ stopContainer, startContainer } = dependencies.dockerService)
    databaseService = dependencies.databaseService
    ;({ getDatabaseContainerId, ensureDatabasePool, getExternalDbConfig, executeNativeMariaDbCommand } = databaseService)
    ;({ checkBootstrapSignature, ensureVerifiedInnerArchive } = dependencies.archiveSigning)
    ;({ startProgress, getWorkDir } = dependencies.workspace)
    logger = dependencies.logger
}

async function restoreBootstrap(coin, network, module, fileName) {
    switch (module) {
        case XChainService.XCHAIN_UTXO_TRACKER:
            return restoreBootstrapUtxoTracker(coin, network, fileName)
        case XChainService.XCHAIN_DECODER:
        case XChainService.XCHAIN_INDEXER:
            return restoreBootstrapMariaDb(coin, network, module, fileName)
        default:
            throw new Error(`Unsupported module for bootstrap restore: ${module}`)
    }
}

async function restoreBootstrapUtxoTracker(coin, network, fileName) {
    const context = await prepareTrackerRestore(coin, network, fileName)

    logger.info(`Stopping ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
    await stopContainer(context.containerId)

    await restoreTrackerVolume(context)

    logger.info(`Starting ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
    await startContainer(context.containerId)

    return true
}

async function prepareTrackerRestore(coin, network, fileName) {
    const defaultConfig = await getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    const bootstrapDir  = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
    const archivePath   = path.join(bootstrapDir, fileName)
    // The shared helper applies NODE_PREFIX so the archive is unpacked into
    // the selected stack's volume.
    const volumeName    = getUtxoTrackerVolumeName(coin, network)
    const workDir       = getWorkDir(coin, network, `${XChainService.XCHAIN_UTXO_TRACKER}-restore`)

    if (!fs.existsSync(archivePath)) throw new Error(`Bootstrap file not found: ${archivePath}`)

    // Supply-chain gate: the embedded data.sha256 below only detects transport
    // corruption (it ships inside the same archive). Provenance comes from the
    // detached signature checked here.
    await checkBootstrapSignature(archivePath)

    // Extract and verify the inner archive against the checksum that
    // shipped inside the signature-verified outer archive (resumable, but the
    // reused bytes are always re-bound to the verified archive; see the helper).
    const innerArchive = await ensureVerifiedInnerArchive(archivePath, workDir, 'data.tar.gz', 'data.sha256')

    // Make sure the DB pool is open first; when this routine is invoked outside
    // the CLI precheck the pool is null, and getModuleContainer would silently
    // return null, masquerading as a missing container.
    await ensureDatabasePool()
    const containerId = await db.getModuleContainer(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    if (!containerId) {
        if (!db.isReady()) {
            throw new Error(`utxo-tracker container lookup failed: MariaDB connection pool is not initialized for ${coin}/${network}`)
        }
        throw new Error(`utxo-tracker container not found for ${coin}/${network} (DB pool is ready but no matching row in the modules table)`)
    }

    return { containerId, innerArchive, volumeName, workDir }
}

async function restoreTrackerVolume({ containerId, innerArchive, volumeName, workDir }) {
    try {
        logger.info('Clearing LevelDB volume...')
        await execFileAsync('docker', ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c', 'find /data -mindepth 1 -delete'])

        const stats      = await fs.promises.stat(innerArchive)
        const totalBytes = stats.size
        const progress   = startProgress('Restoring LevelDB data...', totalBytes)

        await new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(innerArchive)
            const counter    = new PassThrough()
            const gunzip     = zlib.createGunzip()
            const tarProc    = spawn('docker', ['run', '--rm', '-i', '-v', `${volumeName}:/data`, 'alpine', 'tar', 'xf', '-', '-C', '/data'], { stdio: ['pipe', 'inherit', 'pipe'] })

            counter.on('data', chunk => progress.update(chunk.length))
            readStream.pipe(counter).pipe(gunzip).pipe(tarProc.stdin)

            readStream.on('error', err => reject(err))
            gunzip.on('error',    err => reject(err))
            tarProc.on('error',   err => reject(err))
            tarProc.on('close', code => {
                if (code === 0) resolve()
                else reject(new Error(`docker tar restore exited with code ${code}`))
            })
        })
        progress.stop('LevelDB data restored')

        fs.rmSync(workDir, { recursive: true })
        logger.info('Bootstrap restore complete')

    } catch (err) {
        // Every statement in the try above runs
        // at or after `find /data -mindepth 1 -delete`, so a failure here leaves
        // the LevelDB store partially wiped. Restarting the container over it (the
        // old unconditional `finally`) boots a fresh XChainUtxoTracker with
        // halted=false, so get_sync_status / GET /status report a normal non-503
        // status and BootstrapHealthGate has nothing to refuse on: an emptied
        // store reads as caught up. Mirrors the tracker's own contract in
        // xchain-utxo-tracker/src/bootstrap/bootstrap_recovery.js `handleRestoreFailure`,
        // where a post-wipe abort fails loud instead of resuming.
        err.postWipe = true
        logger.info(
            `[fatal] ${XChainService.XCHAIN_UTXO_TRACKER} bootstrap restore failed AFTER the LevelDB\n` +
            `volume was wiped; the store is incomplete and the container has been left STOPPED so it\n` +
            `cannot report a wiped store as caught up. Re-run the restore with\n` +
            `XCHAIN_NODE_FORCE_BOOTSTRAP=1, or clear the volume and resync from scratch.`
        )
        throw err
    }
}

async function restoreBootstrapMariaDb(coin, network, module, fileName) {
    const context = await prepareMariaRestore(coin, network, module, fileName)
    try {
        return await restoreMariaDatabase(context)
    } finally {
        // Always restart the service so a failed restore doesn't leave it down.
        if (context.serviceContainerId) {
            logger.info(`Starting ${module} container...`)
            await startContainer(context.serviceContainerId)
        }
    }
}

async function prepareMariaRestore(coin, network, module, fileName) {
    const { askMariadbRootPassword } = databaseService

    const defaultConfig = await getDefaultConfig(module, coin, network)
    const bootstrapDir  = module === XChainService.XCHAIN_DECODER
        ? defaultConfig["DECODER_BOOTSTRAP_VOLUME"]
        : defaultConfig["INDEXER_BOOTSTRAP_VOLUME"]
    const archivePath   = path.join(bootstrapDir, fileName)
    const dbName        = getModuleDatabaseName(module, coin, network)
    const workDir       = getWorkDir(coin, network, `${module}-restore`)

    if (!fs.existsSync(archivePath)) throw new Error(`Bootstrap file not found: ${archivePath}`)

    // Supply-chain gate: the embedded dump.sha256 below only detects transport
    // corruption (it ships inside the same archive). Provenance comes from the
    // detached signature checked here.
    await checkBootstrapSignature(archivePath)

    // Extract and verify the inner archive against the checksum that
    // shipped inside the signature-verified outer archive (resumable, but the
    // reused bytes are always re-bound to the verified archive; see the helper).
    const innerArchive = await ensureVerifiedInnerArchive(archivePath, workDir, 'dump.sql.gz', 'dump.sha256')

    let dbContainerId = null
    let rootPassword  = null
    let externalCfg   = null

    if (EXTERNAL_DB) {
        externalCfg = await getExternalDbConfig()
    } else {
        dbContainerId = await getDatabaseContainerId()
        if (!dbContainerId) throw new Error('MariaDB container not found')
        rootPassword = await askMariadbRootPassword(coin, network)
    }

    // Stop the service that owns this DB so it isn't writing rows or holding
    // connections while we DROP and reimport (mirrors the utxo-tracker path,
    // which stops the tracker before clearing its volume). Best-effort: a
    // manual restore run before the service is installed has no container to
    // stop. Open the DB pool first so getModuleContainer can resolve the row.
    await ensureDatabasePool()
    let serviceContainerId = null
    try {
        serviceContainerId = await db.getModuleContainer(module, coin, network)
    } catch { /* service not installed yet, proceed without stopping */ }
    if (serviceContainerId) {
        logger.info(`Stopping ${module} container...`)
        await stopContainer(serviceContainerId)
    }

    return { dbContainerId, dbName, externalCfg, innerArchive, module, rootPassword, serviceContainerId, workDir }
}

async function restoreMariaDatabase({ dbContainerId, dbName, externalCfg, innerArchive, rootPassword, workDir }) {
    logger.info(`Recreating database ${dbName}...`)
    if (EXTERNAL_DB) {
        // Driver-based path: DROP and CREATE as separate statements (the
        // mariadb driver rejects multi-statement strings unlike the CLI).
        await executeNativeMariaDbCommand(externalCfg, `DROP DATABASE IF EXISTS ${dbName}`)
        await executeNativeMariaDbCommand(externalCfg, `CREATE DATABASE ${dbName}`)
    } else {
        await execFileAsync(
            'docker', dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', '-e', `DROP DATABASE IF EXISTS ${dbName}; CREATE DATABASE ${dbName}`]),
            { env: mariadbEnv(rootPassword) }
        )
    }

    const stats      = await fs.promises.stat(innerArchive)
    const totalBytes = stats.size
    const progress   = startProgress(`Restoring ${dbName}...`, totalBytes)

    await new Promise((resolve, reject) => {
        const readStream  = fs.createReadStream(innerArchive)
        const counter     = new PassThrough()
        const gunzip      = zlib.createGunzip()

        // For external (native) MariaDB, invoke the mariadb CLI directly
        // over TCP. The password travels via MYSQL_PWD env only, never argv.
        let mysqlProc
        if (EXTERNAL_DB) {
            mysqlProc = spawn('mariadb',
                ['-h', externalCfg.host, '-P', String(externalCfg.port),
                 '-u', externalCfg.root_user, dbName],
                { stdio: ['pipe', 'inherit', 'pipe'], env: mariadbEnv(externalCfg.root_password) })
        } else {
            mysqlProc = spawn('docker', dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', dbName], { interactive: true }),
                { stdio: ['pipe', 'inherit', 'pipe'], env: mariadbEnv(rootPassword) })
        }

        counter.on('data', chunk => progress.update(chunk.length))
        readStream.pipe(counter).pipe(gunzip).pipe(mysqlProc.stdin)

        readStream.on('error',  err => reject(err))
        gunzip.on('error',      err => reject(err))
        mysqlProc.on('error',   err => reject(err))
        mysqlProc.on('close', code => {
            if (code === 0) resolve()
            else reject(new Error(`mariadb restore exited with code ${code}`))
        })
    })
    progress.stop(`${dbName} restored`)

    fs.rmSync(workDir, { recursive: true })
    logger.info('Bootstrap restore complete')

    return true
}

module.exports = {
    configureDependencies,
    restoreBootstrap
}
