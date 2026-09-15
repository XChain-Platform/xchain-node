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

let { XChainService, SEP, EXTERNAL_DB } = require('../../config')
const { schemaSizeSql } = require('../../db/information_schema')
const { tipHeightSql } = require('../../db/blocks')
let { getDefaultConfig, getModuleDatabaseName } = require('../config_service')
let { getDatabaseContainerId, getExternalDbConfig, executeNativeMariaDbCommand } = require('../database_service')
let databaseService = require('../database_service')
let { assertBootstrapSourceHealthy } = require('../bootstrap_health_gate')
let { buildBootstrapMeta, writeBootstrapMeta } = require('../bootstrap_archive_meta')
const { dockerMariadbArgs, mariadbEnv } = require('../../utils/docker_mariadb')
const { redactSecrets } = require('../../utils/helpers')
let { maybeSignBootstrap, computeSha256 } = require('./archive_signing')
let { startProgress, buildDateTimeString, getWorkDir, ensureDir, ensureDirWritable } = require('./workspace')
const { getLogger } = require('../../observability/logger')
let logger = getLogger()

function configureDependencies(dependencies) {
    fs = dependencies.fs
    zlib = dependencies.zlib
    ;({ execFile, spawn } = dependencies.childProcess)
    execFileAsync = promisify(execFile)
    ;({ XChainService, SEP, EXTERNAL_DB } = dependencies.config)
    ;({ getDefaultConfig, getModuleDatabaseName } = dependencies.configService)
    databaseService = dependencies.databaseService
    ;({ getDatabaseContainerId, getExternalDbConfig, executeNativeMariaDbCommand } = databaseService)
    ;({ assertBootstrapSourceHealthy } = dependencies.bootstrapHealthGate)
    ;({ buildBootstrapMeta, writeBootstrapMeta } = dependencies.archiveMeta)
    ;({ maybeSignBootstrap, computeSha256 } = dependencies.archiveSigning)
    ;({ startProgress, buildDateTimeString, getWorkDir, ensureDir, ensureDirWritable } = dependencies.workspace)
    logger = dependencies.logger
}

// `preflightWatermark` is the marker-table reading the pre-flight gate took before
// this dump started; the post-dump gate needs it to bound the dump window.
async function makeBootstrapMariaDb(coin, network, module, preflightWatermark = null) {
    const context = await prepareMariaArchive(coin, network, module)
    const totalBytes = await estimateMariaDatabase(context)

    if (fs.existsSync(context.workDir)) fs.rmSync(context.workDir, { recursive: true })
    ensureDir(context.workDir)
    await ensureDirWritable(context.outputDir)

    await dumpMariaDatabase(context, totalBytes)
    await assertMariaSourceStayedHealthy(coin, network, module, preflightWatermark, context)
    await finalizeMariaArchive(coin, network, module, context)
    return true
}

async function prepareMariaArchive(coin, network, module) {
    const { askMariadbRootPassword } = databaseService

    const defaultConfig = await getDefaultConfig(module, coin, network)
    const outputDir     = module === XChainService.XCHAIN_DECODER
        ? defaultConfig["DECODER_BOOTSTRAP_VOLUME"]
        : defaultConfig["INDEXER_BOOTSTRAP_VOLUME"]
    const dbName        = getModuleDatabaseName(module, coin, network)
    const archiveName   = `${network}${SEP}${module}${SEP}${buildDateTimeString()}.tar.gz`
    const workDir       = getWorkDir(coin, network, module)
    const innerArchive  = path.join(workDir, 'dump.sql.gz')
    const checksumFile  = path.join(workDir, 'dump.sha256')
    const finalOutput   = path.join(outputDir, archiveName)

    // Get DB credentials (and container ID when not using external DB).
    // In external-DB mode there is no local container; talk to the DB over the
    // native connection (mirrors restoreBootstrapMariaDb's EXTERNAL_DB branch)
    // so bootstrap publishing works from an external-DB host too.
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

    return { archiveName, checksumFile, dbContainerId, dbName, externalCfg, finalOutput, innerArchive, outputDir, rootPassword, workDir }
}

async function estimateMariaDatabase({ dbContainerId, dbName, externalCfg, rootPassword }) {
    let totalBytes = 0
    try {
        const sizeQuery = schemaSizeSql(dbName)
        let sizeOut
        if (EXTERNAL_DB) {
            sizeOut = await executeNativeMariaDbCommand(externalCfg, sizeQuery, '-BN')
        } else {
            const { stdout } = await execFileAsync(
                'docker', dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', '-BN', '-e', sizeQuery, 'information_schema']),
                { env: mariadbEnv(rootPassword) }
            )
            sizeOut = stdout
        }
        totalBytes = parseInt(String(sizeOut).trim(), 10) || 0
    } catch {
        logger.info('Could not estimate DB size, progress will show as ?%')
    }
    return totalBytes
}

async function dumpMariaDatabase({ dbContainerId, dbName, externalCfg, innerArchive, rootPassword }, totalBytes) {
    const progress = startProgress(`Dumping ${dbName}...`, totalBytes)
    await new Promise((resolve, reject) => {
        const dumpProc    = EXTERNAL_DB
            ? spawn('mariadb-dump',
                ['-h', externalCfg.host, '-P', String(externalCfg.port), '-u', externalCfg.root_user,
                 '--single-transaction', '--routines', '--triggers', dbName],
                { env: mariadbEnv(externalCfg.root_password) })
            : spawn('docker', dockerMariadbArgs(dbContainerId, ['mariadb-dump', '-u', 'root', '--single-transaction', '--routines', '--triggers', dbName], { interactive: true }), { env: mariadbEnv(rootPassword) })
        const counter     = new PassThrough()
        const gzipStream  = zlib.createGzip()
        const writeStream = fs.createWriteStream(innerArchive)

        counter.on('data', chunk => progress.update(chunk.length))

        dumpProc.stdout.pipe(counter).pipe(gzipStream).pipe(writeStream)

        dumpProc.stderr.on('data', () => {})
        dumpProc.on('error', err => reject(err))
        writeStream.on('error', err => reject(err))
        writeStream.on('finish', resolve)
        dumpProc.on('close', code => {
            if (code !== 0) reject(new Error(`mariadb-dump exited with code ${code}`))
        })
    })
    const innerStats = await fs.promises.stat(innerArchive)
    progress.stop(`${dbName} dumped: ${(innerStats.size / 1024 / 1024).toFixed(1)} MB compressed`)
}

async function assertMariaSourceStayedHealthy(coin, network, module, preflightWatermark, { dbName, workDir }) {
    // Re-gate the SOURCE before anything is packaged, checksummed or signed.
    //
    // The pre-flight gate in makeBootstrap runs before the dump, and the producers
    // stay live throughout it: a decoder can write events.code='REORG_HALT' and
    // xchain-sync can insert an uncleared sync_halt row while mariadb-dump is
    // streaming. Without this second reading the archive ships carrying the very
    // marker the gate exists to refuse, signed, as the newest (and therefore
    // default) file in the served directory.
    //
    // A live reading alone cannot speak for the archive: the bytes that ship are the
    // --single-transaction snapshot taken when the dump started, so a halt raised
    // after the pre-flight gate and cleared before this call lands INSIDE the
    // snapshot while both readings look clean. `since` is the pre-flight gate's
    // marker-table watermark, and the marker tables are append-only and id-ordered,
    // so the gate can ask what was RAISED anywhere in the dump window rather than
    // only the current live state.
    //
    // Still deliberately conservative rather than exact: a halt raised after the
    // snapshot point, which the archive therefore does not carry, also refuses.
    // Publishing nothing beats publishing unverified, and the same reading also
    // catches every other late fault the gate covers (the container died mid-dump,
    // lag grew past the ceiling, the module went wedged). Cheap:
    // askMariadbRootPassword caches, so no second prompt, and a skipped gate
    // (XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE) skips both calls alike.
    try {
        await assertBootstrapSourceHealthy(coin, network, module, { since: preflightWatermark })
    } catch (err) {
        logger.info(`The ${module} source stopped being known-good while ${dbName} was dumping; `
            + 'discarding the finished dump rather than publishing it.')
        try { fs.rmSync(workDir, { recursive: true }) } catch { /* the refusal is what matters */ }
        throw err
    }
}

async function finalizeMariaArchive(coin, network, module, context) {
    const { archiveName, checksumFile, dbContainerId, dbName, externalCfg, finalOutput, innerArchive, rootPassword, workDir } = context
    process.stdout.write('Computing checksum... ')
    const checksum = await computeSha256(innerArchive)
    await fs.promises.writeFile(checksumFile, `${checksum}  dump.sql.gz\n`)
    logger.info(checksum)

    // The height the dump ends at, for the restore-time comparison with the
    // coin node (BootstrapNodeTipGuard). Read after the dump so it can only
    // sit at or above the dump's own tip. Metadata leads the wrapper so the
    // restore reads it without a pass over the archive.
    const archiveHeight = await readMariaDbTipHeight(dbName, { dbContainerId, rootPassword, externalCfg })
    const metaMember = await writeBootstrapMeta(workDir, buildBootstrapMeta({ module, coin, network, height: archiveHeight }))

    logger.info(`Wrapping into ${archiveName}...`)
    await execFileAsync('tar', ['czf', finalOutput, '-C', workDir, metaMember, 'dump.sql.gz', 'dump.sha256'])

    await maybeSignBootstrap(finalOutput)

    fs.rmSync(workDir, { recursive: true })
    logger.info(redactSecrets(`Bootstrap created: ${finalOutput}`))

}

// MAX(block_index) of the decoder/indexer `blocks` table, or null when it
// cannot be read. Both schemas carry the column; the indexer's rows can be
// sparse but its highest index is still the height the dump reaches.
async function readMariaDbTipHeight(dbName, { dbContainerId, rootPassword, externalCfg }) {
    const query = tipHeightSql(dbName)
    try {
        let out
        if (EXTERNAL_DB) {
            out = await executeNativeMariaDbCommand(externalCfg, query, '-BN')
        } else {
            const { stdout } = await execFileAsync(
                'docker', dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', '-BN', '-e', query]),
                { env: mariadbEnv(rootPassword) }
            )
            out = stdout
        }
        const height = parseInt(String(out).trim(), 10)
        return Number.isInteger(height) && height >= 0 ? height : null
    } catch (err) {
        logger.info(`Could not read the ${dbName} tip height for the archive metadata (${redactSecrets(err.message)}); the archive will carry no height.`)
        return null
    }
}

module.exports = {
    configureDependencies,
    makeBootstrapMariaDb,
    readMariaDbTipHeight
}
