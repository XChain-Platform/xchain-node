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
const crypto              = require('crypto')
let zlib                  = require('zlib')
let { execFile, spawn }   = require('child_process')
const { promisify }       = require('util')
const { PassThrough }     = require('stream')
let execFileAsync         = promisify(execFile)

let { XChainService, SEP } = require('../../config')
let { db } = require('../../state')
let { getDefaultConfig, getUtxoTrackerVolumeName } = require('../config_service')
let { stopContainer, startContainer } = require('../docker_service')
let { assertBootstrapSourceHealthy } = require('../bootstrap_health_gate')
let bootstrapHealthGate = require('../bootstrap_health_gate')
let { buildBootstrapMeta, writeBootstrapMeta } = require('../bootstrap_archive_meta')
let { declareEncoderMaintenance, clearEncoderMaintenance } = require('../encoder_maintenance_window')
const { redactSecrets } = require('../../utils/helpers')
let { maybeSignBootstrap } = require('./archive_signing')
let { startProgress, buildDateTimeString, getWorkDir, assertBootstrapCapacity, ensureDir, ensureDirWritable } = require('./workspace')
const { getLogger } = require('../../observability/logger')
let logger = getLogger()

function configureDependencies(dependencies) {
    fs = dependencies.fs
    zlib = dependencies.zlib
    ;({ execFile, spawn } = dependencies.childProcess)
    execFileAsync = promisify(execFile)
    ;({ XChainService, SEP } = dependencies.config)
    ;({ db } = dependencies.state)
    ;({ getDefaultConfig, getUtxoTrackerVolumeName } = dependencies.configService)
    ;({ stopContainer, startContainer } = dependencies.dockerService)
    bootstrapHealthGate = dependencies.bootstrapHealthGate
    ;({ assertBootstrapSourceHealthy } = bootstrapHealthGate)
    ;({ buildBootstrapMeta, writeBootstrapMeta } = dependencies.archiveMeta)
    ;({ declareEncoderMaintenance, clearEncoderMaintenance } = dependencies.encoderMaintenance)
    ;({ maybeSignBootstrap } = dependencies.archiveSigning)
    ;({ startProgress, buildDateTimeString, getWorkDir, assertBootstrapCapacity, ensureDir, ensureDirWritable } = dependencies.workspace)
    logger = dependencies.logger
}

// Where the pre-compress hardlink snapshot of the tracker volume lives.
// It has to sit INSIDE the volume, because a hardlink cannot cross a filesystem, and the volume is the only thing mounted into the helper
// container. It is a sibling of the LevelDB store (LevelUpDb opens /data/<dbName>, never /data itself), so the running tracker never looks at
// it. Fixed literal with no shell metacharacters: it is interpolated into the snapshot shell script below.
const TRACKER_SNAPSHOT_DIR = '.xchain-bootstrap-snapshot'

// Freeze the tracker volume without keeping the tracker down for the compress.
// Taken while the container is STOPPED, so the store is quiescent and the result is a byte-exact point-in-time copy. Two passes, because the two kinds
// of file in a classic-level store need different treatment:
//   1. Hardlink everything. Compaction afterwards unlinks the SSTs it merges      away, but the snapshot's links keep those inodes alive, so the compress
//      reads the store as it stood at the stop even though the tracker has been      serving traffic for hours by then. That is the whole trick, and it is
//      only sound because an .ldb/.sst file is written once and never edited.
//   2. Replace the link with a real copy for every OTHER regular file. LevelDB      appends to its live MANIFEST and write-ahead log in place, and a
//      hardlink shares the inode, so those would follow the live store forward      and the archive would carry a manifest describing SSTs it does not hold.
//      In practice leveldb opens a fresh MANIFEST/log per open (reuse_logs is      off) and rewrites CURRENT via rename, so the links would usually survive
//      untouched; "usually" is not a property to hand a published mainnet      bootstrap. These files are kilobytes-to-megabytes next to a 162 GB
//      store, so copying them costs nothing measurable.
// Cost while the snapshot is held: the volume keeps every SST the tracker compacts away during the run, so it needs headroom for that churn rather than
// for a second full copy. The snapshot is dropped in the caller's finally.
// Rejects when the volume's filesystem will not take the hardlinks; the caller falls back to the old behavior (compress with the container stopped).
async function snapshotTrackerVolume(volumeName) {
    const snapPath = `/data/${TRACKER_SNAPSHOT_DIR}`
    const script = [
        'set -e',
        `rm -rf ${snapPath}`,
        `mkdir -p ${snapPath}`,
        // -mindepth 1 -maxdepth 1 walks only the volume's top level, and the ! -name guard keeps the snapshot from copying itself.
        `find /data -mindepth 1 -maxdepth 1 ! -name ${TRACKER_SNAPSHOT_DIR} -exec cp -al {} ${snapPath}/ ';'`,
        // Pass 2. The .xcsnap guard keeps a temp file from being re-processed if the directory walk sees one mid-flight.
        `find ${snapPath} -type f ! -name '*.ldb' ! -name '*.sst' ! -name '*.xcsnap'` +
            ` -exec sh -c 'cp -a "$1" "$1.xcsnap" && mv -f "$1.xcsnap" "$1"' _ {} ';'`
    ].join('\n')

    await execFileAsync('docker', [
        'run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c', script
    ])
    return true
}

// Headroom the volume should have spare before we pin its compaction churn for the length of a compress, as a fraction of the store size. A guess by
// construction (nobody can predict a run's write amplification), so it only gates a warning.
const TRACKER_SNAPSHOT_HEADROOM_RATIO = 0.15

async function warnOnThinTrackerVolume(volumeName, totalBytes) {
    if (!totalBytes || totalBytes <= 0) return
    let availableBytes = 0
    try {
        const { stdout } = await execFileAsync('docker', [
            'run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'df', '-Pk', '/data'
        ])
        const cols = stdout.trim().split('\n').pop().trim().split(/\s+/)
        availableBytes = (parseInt(cols[3], 10) || 0) * 1024
    } catch {
        return   // unknown free space: nothing honest to say
    }
    const wanted = Math.round(totalBytes * TRACKER_SNAPSHOT_HEADROOM_RATIO)
    if (availableBytes >= wanted) return
    const gb = bytes => (bytes / 1024 / 1024 / 1024).toFixed(1)
    logger.info(
        `WARNING: ${volumeName} has ${gb(availableBytes)} GB free against a ${gb(totalBytes)} GB store.\n` +
        `The snapshot holds every SST the tracker compacts away while the archive is built, so a long\n` +
        `run on this volume can fill it and halt the tracker. Free space or expect a stopped tracker.`
    )
}

async function removeTrackerSnapshot(volumeName) {
    await execFileAsync('docker', [
        'run', '--rm', '-v', `${volumeName}:/data`, 'alpine',
        'rm', '-rf', `/data/${TRACKER_SNAPSHOT_DIR}`
    ])
}

// Bundle already-compressed members into the published .tar.gz WITHOUT recompressing them.
//  The outer archive exists only so the payload travels with its own checksum;
// its members (data.tar.gz / dump.sql.gz) are gzip streams already, which deflate cannot shrink. The old `tar czf` therefore pushed the whole dataset
// through gzip a second time for no size win: on 2026-08-01 that was 162.5 GB of incompressible bytes re-deflated. Level 0 emits stored deflate blocks, so
// the result is still a genuine gzip file that every existing consumer reads unchanged (`tar tzf` / `tar xzf`, the tracker's own single-layer restore),
// only without the CPU.
function writeStoredGzipTar(finalOutput, workDir, members) {
    return new Promise((resolve, reject) => {
        const tarProc     = spawn('tar', ['cf', '-', '-C', workDir, ...members])
        const storeStream = zlib.createGzip({ level: 0 })
        const writeStream = fs.createWriteStream(finalOutput)

        let tarExit  = null
        let written  = false
        let settled  = false

        // The half-written file sits in the directory the publish rsyncs from, so it has to go: a truncated archive that survives here is one the
        // next node restores from.
        const discardPartial = () => {
            try { writeStream.destroy() } catch { /* already torn down */ }
            try { fs.rmSync(finalOutput, { force: true }) } catch { /* nothing to remove */ }
        }

        // Both conditions are required: tar can die mid-stream, which ends the pipe and fires 'finish' on a TRUNCATED archive. Resolving on 'finish'
        // alone would publish that truncated file as a good bootstrap.
        const settle = () => {
            if (settled || tarExit === null || !written) return
            settled = true
            if (tarExit !== 0) { discardPartial(); reject(new Error(`tar exited with code ${tarExit}`)) }
            else resolve()
        }
        const fail = err => { if (!settled) { settled = true; discardPartial(); reject(err) } }

        tarProc.stdout.pipe(storeStream).pipe(writeStream)
        tarProc.stderr.on('data', () => {})
        tarProc.on('error', fail)
        storeStream.on('error', fail)
        writeStream.on('error', fail)
        writeStream.on('finish', () => { written = true; settle() })
        tarProc.on('close', code => { tarExit = code; settle() })
    })
}

async function makeBootstrapUtxoTracker(coin, network) {
    const context = await prepareTrackerArchive(coin, network)
    const endMaintenanceWindow = await beginTrackerMaintenance(coin, network)

    logger.info(`Stopping ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
    await stopContainer(context.containerId)

    context.containerRestored = false
    try {
        const snapshotTaken = await takeTrackerSnapshot(context, endMaintenanceWindow)
        await compressTrackerArchive(context, snapshotTaken)
        await finalizeTrackerArchive(coin, network, context)
    } finally {
        await cleanupTrackerArchive(context.volumeName, context.containerId, context.containerRestored, endMaintenanceWindow)
    }

    return true
}

async function prepareTrackerArchive(coin, network) {
    const context = await buildTrackerArchiveContext(coin, network)
    context.totalBytes = await estimateTrackerArchive(context.volumeName)

    // Refuse if either filesystem cannot hold it. Checked before the stop below, so a capacity failure never costs the tracker any downtime.
    assertBootstrapCapacity(context.workDir, context.outputDir, context.totalBytes, `${coin}/${network} utxo-tracker`)

    // Warn, don't refuse: the snapshot below pins every SST the tracker compacts away while the compress runs, so the VOLUME (not just the staging and
    // output filesystems checked above) needs churn headroom for the length of the run. Refusing here would be worse than the old behavior, but filling
    // the volume halts the tracker, so the operator should hear about it.
    await warnOnThinTrackerVolume(context.volumeName, context.totalBytes)

    context.containerId = await db.getModuleContainer(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    if (!context.containerId) throw new Error(`utxo-tracker container not found for ${coin}/${network}`)

    // The height the archive will end at, read from the tracker's own status while it is still running (the store is LevelDB, nothing else can tell).
    // Best-effort: an archive without a height still restores, it just cannot be compared with the coin node at restore time (BootstrapNodeTipGuard).
    context.archiveHeight = await readTrackerCommittedHeight(coin, network, context.containerId)

    // Staging and output dirs are prepared before the stop for the same reason as the capacity check: a read-only mount or a missing parent should not be
    // discovered with the tracker already dark.
    if (fs.existsSync(context.workDir)) fs.rmSync(context.workDir, { recursive: true })
    ensureDir(context.workDir)
    await ensureDirWritable(context.outputDir)
    return context
}

async function buildTrackerArchiveContext(coin, network) {
    const defaultConfig = await getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    const outputDir     = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
    // The shared helper applies NODE_PREFIX so the selected stack's data is archived.
    const volumeName    = getUtxoTrackerVolumeName(coin, network)
    const archiveName   = `${network}${SEP}${XChainService.XCHAIN_UTXO_TRACKER}${SEP}${buildDateTimeString()}.tar.gz`
    const workDir       = getWorkDir(coin, network, XChainService.XCHAIN_UTXO_TRACKER)
    const innerArchive  = path.join(workDir, 'data.tar.gz')
    const checksumFile  = path.join(workDir, 'data.sha256')
    const finalOutput   = path.join(outputDir, archiveName)

    return { archiveName, checksumFile, finalOutput, innerArchive, outputDir, workDir, coin, network, volumeName }
}

async function estimateTrackerArchive(volumeName) {
    // Drop a snapshot left behind by a crashed run BEFORE measuring, so the estimate describes the real dataset and no stale directory can end up
    // inside the archive on the stopped-container fallback path. Deliberately not swallowed: failing here costs no downtime, whereas publishing a
    // snapshot-polluted archive is silent corruption.
    await removeTrackerSnapshot(volumeName)

    let totalBytes = 0
    try {
        const { stdout } = await execFileAsync(
            'docker', ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'du', '-sb', '/data']
        )
        totalBytes = parseInt(stdout.trim().split(/\s+/)[0], 10) || 0
    } catch {
        logger.info('Could not estimate volume size, progress will show as ?%')
    }

    return totalBytes
}

async function beginTrackerMaintenance(coin, network) {
    // Declared BEFORE the stop, so the first probe that sees the tracker gone already has the operator's reason for it. The encoder keeps reporting the
    // outage truthfully (tracker_reachable:false, 503); this only lets the public board call it Maintenance instead of Degraded. Best-effort by
    // construction: a status label must never hold up a publish.
    let maintenanceDeclared = await declareEncoderMaintenance(coin, network, {
        reason: `${XChainService.XCHAIN_UTXO_TRACKER} bootstrap publish`
    })
    // Ends the window the moment the tracker is back, not when the whole
    // multi-hour compress finishes: on the snapshot path the encoder recovers
    // seconds after the stop, and leaving the window open would have /status
    // advertising maintenance on an encoder that is serving again. Idempotent,
    // and never throws for the same reason the declare does not.
    const endMaintenanceWindow = async () => {
        if (!maintenanceDeclared) return
        maintenanceDeclared = false
        await clearEncoderMaintenance(coin, network)
    }

    return endMaintenanceWindow
}

async function takeTrackerSnapshot(context, endMaintenanceWindow) {
    let snapshotTaken = false
    try {
        snapshotTaken = await snapshotTrackerVolume(context.volumeName)
    } catch (err) {
        logger.info(`Volume snapshot unavailable (${err.message}); compressing with the tracker stopped.`)
        // A half-written snapshot must not be swept into the fallback
        // archive, and a volume we cannot clean is not one we can publish
        // from: let this throw into the outer finally, which restarts the
        // container.
        await removeTrackerSnapshot(context.volumeName)
    }

    // The whole point of the snapshot: the outage ends HERE, seconds after
    // the stop, instead of after the multi-hour compress below. Without it
    // the monthly cron took each mainnet encoder's tracker dark for the
    // full run (2026-08-01: 3h36m BTC, 1h04m LTC, 42m DOGE), which the
    // encoder correctly published as tracker_reachable:false.
    if (snapshotTaken) {
        logger.info(`Starting ${XChainService.XCHAIN_UTXO_TRACKER} container (compressing from the snapshot)...`)
        await startContainer(context.containerId)
        context.containerRestored = true
        await endMaintenanceWindow()
    }

    return snapshotTaken
}

async function compressTrackerArchive(context, snapshotTaken) {
        const tarSource = snapshotTaken ? `/data/${TRACKER_SNAPSHOT_DIR}` : '/data'

        const progress = startProgress('Compressing LevelDB data...', context.totalBytes)
        // Hashed inline off the gzip output rather than by re-reading the
        // finished file: at tracker scale that second full read was another
        // pass over 162.5 GB to learn something the write already knew.
        const innerHash = crypto.createHash('sha256')
        await new Promise((resolve, reject) => {
            const tarProc     = spawn('docker', ['run', '--rm', '-v', `${context.volumeName}:/data`, 'alpine', 'tar', 'cf', '-', '-C', tarSource, '.'])
            const counter     = new PassThrough()
            const gzipStream  = zlib.createGzip()
            const writeStream = fs.createWriteStream(context.innerArchive)

            counter.on('data', chunk => progress.update(chunk.length))
            gzipStream.on('data', chunk => innerHash.update(chunk))

            tarProc.stdout.pipe(counter).pipe(gzipStream).pipe(writeStream)

            tarProc.stderr.on('data', () => {})
            tarProc.on('error', err => reject(err))
            writeStream.on('error', err => reject(err))
            writeStream.on('finish', resolve)
            tarProc.on('close', code => {
                if (code !== 0) reject(new Error(`docker tar exited with code ${code}`))
            })
        })
        const innerStats = await fs.promises.stat(context.innerArchive)
        progress.stop(`LevelDB compressed: ${(innerStats.size / 1024 / 1024).toFixed(1)} MB`)

        const checksum = innerHash.digest('hex')
        await fs.promises.writeFile(context.checksumFile, `${checksum}  data.tar.gz\n`)
        logger.info(`Checksum: ${checksum}`)
}

async function finalizeTrackerArchive(coin, network, context) {
        // Metadata leads the wrapper so a restore can read the height without
        // a pass over the whole archive (see BootstrapArchiveMeta).
        const metaMember = await writeBootstrapMeta(context.workDir, buildBootstrapMeta({
            module: XChainService.XCHAIN_UTXO_TRACKER, coin, network, height: context.archiveHeight
        }))

        logger.info(`Wrapping into ${context.archiveName}...`)
        await writeStoredGzipTar(context.finalOutput, context.workDir, [metaMember, 'data.tar.gz', 'data.sha256'])

        await maybeSignBootstrap(context.finalOutput)

        fs.rmSync(context.workDir, { recursive: true })
        logger.info(redactSecrets(`Bootstrap created: ${context.finalOutput}`))
}

async function cleanupTrackerArchive(volumeName, containerId, containerRestored, endMaintenanceWindow) {
        // Cleanup first, but never let it throw past the restart: a pinned
        // snapshot costs disk, a tracker left stopped costs the encoder.
        try {
            await removeTrackerSnapshot(volumeName)
        } catch (err) {
            logger.info(`Warning: could not remove /data/${TRACKER_SNAPSHOT_DIR} in ${volumeName} (${err.message}); it holds disk until removed.`)
        }
        if (!containerRestored) {
            logger.info(`Starting ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
            await startContainer(containerId)
        }
        // After the restart, always: the fallback path held the window for the
        // whole compress, and a failed run must not leave the board excusing an
        // encoder that is serving again.
        await endMaintenanceWindow()
}

// The tracker's committed height from its status surface, or null. Asked
// before the container is stopped for the compress.
async function readTrackerCommittedHeight(coin, network, containerId) {
    try {
        const { probeServiceStatus, MODULE_API_PORT_KEY } = bootstrapHealthGate
        if (typeof probeServiceStatus !== 'function') return null
        const config = await getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
        const port = config && config[MODULE_API_PORT_KEY[XChainService.XCHAIN_UTXO_TRACKER]]
        if (!port) return null
        const runner = (cmd, args) => execFileAsync(cmd, args, { timeout: 15000 })
        const payload = await probeServiceStatus(containerId, port, runner)
        const candidates = ['committed_height', 'tracker_height']
        for (const key of candidates) {
            const value = Number(payload && payload[key])
            if (Number.isInteger(value) && value >= 0) return value
        }
        return null
    } catch (err) {
        logger.info(`Could not read the tracker height for the archive metadata (${redactSecrets(err.message)}); the archive will carry no height.`)
        return null
    }
}

module.exports = {
    configureDependencies,
    makeBootstrapUtxoTracker,
    readTrackerCommittedHeight
}
