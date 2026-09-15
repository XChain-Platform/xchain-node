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

let fs     = require('fs')
const path = require('path')

let config = require('../../config')
let { XChainService } = config
let { getDefaultConfig } = require('../config_service')
let { assessNodeTipForRestore } = require('../bootstrap_node_tip_guard')
const { redactSecrets } = require('../../utils/helpers')
const { BOOTSTRAP_SIG_SUFFIX } = require('./archive_signing')
let { restoreBootstrap } = require('./restore_archive')
let { downloadBootstrap } = require('./download')
const { getLogger } = require('../../observability/logger')
let logger = getLogger()

function configureDependencies(dependencies) {
    fs = dependencies.fs
    config = dependencies.config
    ;({ XChainService } = config)
    ;({ getDefaultConfig } = dependencies.configService)
    ;({ assessNodeTipForRestore } = dependencies.nodeTipGuard)
    ;({ restoreBootstrap } = dependencies.restoreArchive)
    ;({ downloadBootstrap } = dependencies.download)
    logger = dependencies.logger
}

// What each service's bootstrap attempt did, for the end-of-install summary:
// a skipped restore is the difference between a published height and hours of
// rescanning, too costly to leave as one warning mid-log. Reset per run.
const bootstrapOutcomes = []

function recordBootstrapOutcome(module, status, detail, archive) {
    bootstrapOutcomes.push({ module, status, detail, archive: archive || null })
}

function resetBootstrapOutcomes() {
    bootstrapOutcomes.length = 0
}

// Printed at the end of install/update. Says nothing when no bootstrap was
// attempted, so ordinary runs stay quiet.
function reportBootstrapOutcomes() {
    if (bootstrapOutcomes.length === 0) return
    const failed = bootstrapOutcomes.filter((o) => o.status === 'failed')
    // Wiped-then-failed is NOT part of `failed`: those services are down, not
    // syncing from block 0, so the paragraph below would misdescribe them.
    const wipedDown = bootstrapOutcomes.filter((o) => o.status === 'wiped-left-down')
    logger.info('\nBootstrap restore summary:')
    const nodeBehind = bootstrapOutcomes.filter((o) => o.status === 'node-behind')
    for (const o of bootstrapOutcomes) {
        const line = o.status === 'restored' ? 'restored'
            : o.status === 'restored-node-behind' ? `restored, WAITING FOR NODE: ${o.detail}`
            : o.status === 'node-behind' ? `NOT restored, the coin node is behind the archive: ${o.detail}`
            : o.status === 'none-published' ? 'none published, syncing from scratch'
            : o.status === 'disabled' ? 'disabled by XCHAIN_NODE_NO_BOOTSTRAP'
            : o.status === 'wiped-left-down' ? `NOT restored, DATA WIPED, container left stopped: ${o.detail}`
            : `NOT restored: ${o.detail}`
        // Short by design: just the archive's disk fate, not its path or reason
        // again (those are already in the log lines printed during the run).
        const archiveNote = !o.archive ? ''
            : o.archive.removed ? ` (archive removed${o.archive.bytes !== null ? `, ${formatGiB(o.archive.bytes)} GiB` : ''})`
            : ` (archive kept${o.archive.bytes !== null ? `, ${formatGiB(o.archive.bytes)} GiB` : ''})`
        logger.info(`  ${o.module}: ${line}${archiveNote}`)
    }
    if (nodeBehind.length > 0) {
        logger.info(
            '\nThose services were not restored because their coin node has not reached the archive\n' +
            'height yet and their image would read the node\'s lower tip as a reorg. They sync forward\n' +
            'from their start height as the node catches up. To take the restore instead, wait for the\n' +
            'node to pass the archive height and re-run install with XCHAIN_NODE_FORCE_BOOTSTRAP=1.\n'
        )
    }
    if (wipedDown.length > 0) {
        logger.info(
            '\nThose services had their data directory wiped by a restore that then failed, so\n' +
            'their containers were deliberately left STOPPED rather than restarted over an\n' +
            'incomplete store that would report itself caught up. Re-run install with\n' +
            'XCHAIN_NODE_FORCE_BOOTSTRAP=1 to take the restore again, or clear the volume and\n' +
            'start the service to resync from block 0.\n'
        )
    }
    if (failed.length > 0) {
        logger.info(
            '\nThose services are now syncing from block 0, which takes hours to days\n' +
            'rather than minutes. Fix the cause above, then re-run install with\n' +
            'XCHAIN_NODE_FORCE_BOOTSTRAP=1 to take the restore again: without it a\n' +
            'service that has already started syncing is left alone.\n'
        )
    }
}

// Compare the archive's end height with the coin node before a restore. The
// guard never throws; a refusal comes back as { refuse: true, detail } and the
// caller records it instead of restoring. Required late: the guard reaches the
// state db and the health gate, which these ensure paths otherwise do not.
async function assessNodeTipBeforeRestore(coin, network, module, archivePath) {
    return assessNodeTipForRestore({ coin, network, module, archivePath })
}

// A restore that went ahead with the node still below the archive is reported
// as such, so the summary identifies the service's wait state.
function recordRestoredOutcome(module, tip, archive) {
    if (tip && tip.verdict === 'behind-wait') {
        recordBootstrapOutcome(module, 'restored-node-behind', tip.detail, archive)
    } else {
        recordBootstrapOutcome(module, 'restored', null, archive)
    }
}

// Bytes -> a short "N.N GiB" string for the archive-disposition log lines.
function formatGiB(bytes) {
    return (bytes / 1024 / 1024 / 1024).toFixed(1)
}

// Size of the just-downloaded archive, or null when it cannot be statted
// (already gone, or never downloaded). Sizing is cosmetic for the log lines
// below, so a failure here must never block the removal/keep decision it is
// only describing.
async function statBootstrapArchiveBytes(archivePath) {
    try {
        return (await fs.promises.stat(archivePath)).size
    } catch {
        return null
    }
}

// Retire the just-downloaded latest.tgz (+ its detached .sig) once its fate is
// decided, one way or the other: downloadBootstrap has no skip-if-present check
// by design (a stale kept copy is exactly what halted fresh testnet installs
// once) and re-downloads it unconditionally on every run, so a kept copy buys
// nothing back whether the restore just succeeded or was refused for the node
// being behind -- either way the next run downloads a fresh one anyway. Never a
// hard failure: the restore verdict is already settled by the time this runs, so
// a removal failure here is a disk-hygiene warning, not something that should
// undo or fail an otherwise-finished run.
function retireBootstrapArchive(archivePath, bytes, note) {
    const sigPath = archivePath + BOOTSTRAP_SIG_SUFFIX
    try {
        fs.rmSync(archivePath, { force: true })
        fs.rmSync(sigPath, { force: true })
    } catch (err) {
        logger.info(`WARNING: could not remove the bootstrap archive ${archivePath} (${err.message}); remove it manually to reclaim its disk space.`)
        return { removed: false, bytes }
    }
    const gib = bytes !== null ? formatGiB(bytes) : '?'
    logger.info(note
        ? `Bootstrap archive removed (${note}) (${gib} GiB released)`
        : `Bootstrap archive removed after restore (${gib} GiB released)`)
    return { removed: true, bytes }
}

// The archive is left in place only when the restore attempt itself FAILED (as
// opposed to being cleanly refused before it started): it may be the only
// evidence left of what a broken restore was working from, worth trading the
// disk for. Returns null (nothing to report) when the archive was never
// downloaded in the first place.
function reportKeptBootstrapArchive(archivePath, bytes) {
    if (bytes === null) return null
    logger.info(`Bootstrap archive kept after failed restore (${formatGiB(bytes)} GiB at ${archivePath})`)
    return { removed: false, bytes }
}

// Opt-in restore over an already-populated service. Off by default because the
// restore wipes the data directory; needed because a failed restore leaves a
// service scratch-syncing, which reads as populated to every later run.
function forceBootstrapRequested() {
    const v = config.XCHAIN_NODE_FORCE_BOOTSTRAP
    return v !== undefined && v !== '' && v !== '0'
}

// On a FRESH utxo-tracker install, download the published bootstrap and restore
// it. Best-effort: any failure (no bootstrap published, download/restore error)
// logs a warning and returns so the install proceeds with a normal sync.
async function ensureBootstrapUtxoTracker(coin, network) {
    if (config.XCHAIN_NODE_NO_BOOTSTRAP) {
        logger.info('Bootstrap auto-restore disabled (XCHAIN_NODE_NO_BOOTSTRAP): syncing from scratch')
        recordBootstrapOutcome(XChainService.XCHAIN_UTXO_TRACKER, 'disabled')
        return false
    }
    // Tracked outside the try so the catch block can still report on (and keep)
    // whatever was downloaded before the failure, rather than only on a clean
    // success.
    let archivePath = null
    try {
        const defaultConfig = await getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
        const bootstrapDir  = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]

        logger.info(`Checking for a published bootstrap for ${coin}/${network}...`)
        const fileName = await downloadBootstrap(coin, network, XChainService.XCHAIN_UTXO_TRACKER, bootstrapDir)
        if (!fileName) {
            logger.info('No bootstrap available; the tracker will sync from scratch')
            recordBootstrapOutcome(XChainService.XCHAIN_UTXO_TRACKER, 'none-published')
            return false
        }
        archivePath = path.join(bootstrapDir, fileName)
        const tip = await assessNodeTipBeforeRestore(coin, network, XChainService.XCHAIN_UTXO_TRACKER, archivePath)
        if (tip.refuse) {
            // Refused before any restore was attempted, so nothing needs the
            // archive as evidence; see retireBootstrapArchive for why it goes
            // anyway rather than waiting around for a re-run.
            const bytes   = await statBootstrapArchiveBytes(archivePath)
            const archive = retireBootstrapArchive(archivePath, bytes, 'restore refused, node behind; a re-run downloads a fresh copy anyway')
            recordBootstrapOutcome(XChainService.XCHAIN_UTXO_TRACKER, 'node-behind', tip.detail, archive)
            return false
        }
        await restoreBootstrap(coin, network, XChainService.XCHAIN_UTXO_TRACKER, fileName)
        logger.info('Bootstrap installed; tracker will continue from the bootstrap height')
        const bytes   = await statBootstrapArchiveBytes(archivePath)
        const archive = retireBootstrapArchive(archivePath, bytes)
        recordRestoredOutcome(XChainService.XCHAIN_UTXO_TRACKER, tip, archive)
        return true
    } catch (err) {
        const reason  = redactSecrets(err.message)
        const archive = archivePath ? reportKeptBootstrapArchive(archivePath, await statBootstrapArchiveBytes(archivePath)) : null
        // A post-wipe abort did NOT leave a scratch-syncing tracker: the store was
        // emptied and the container was left stopped, so the
        // "will sync from scratch" wording described a state that is not on disk.
        if (err.postWipe) {
            logger.info(
                `WARNING: bootstrap auto-restore failed (${reason}) AFTER the LevelDB volume was wiped: ` +
                `the tracker store is incomplete and its container was left stopped, not syncing.`
            )
            recordBootstrapOutcome(XChainService.XCHAIN_UTXO_TRACKER, 'wiped-left-down', reason, archive)
            return false
        }
        logger.info(`WARNING: bootstrap auto-restore failed (${reason}): the tracker will sync from scratch`)
        recordBootstrapOutcome(XChainService.XCHAIN_UTXO_TRACKER, 'failed', reason, archive)
        return false
    }
}

// On a FRESH decoder/indexer install, download the published bootstrap and
// restore it. Best-effort, mirroring ensureBootstrapUtxoTracker: any failure
// (none published, download/restore error) logs a warning and returns so the
// install proceeds with a normal sync from scratch.
async function ensureBootstrapMariaDb(coin, network, module) {
    if (config.XCHAIN_NODE_NO_BOOTSTRAP) {
        logger.info('Bootstrap auto-restore disabled (XCHAIN_NODE_NO_BOOTSTRAP): syncing from scratch')
        recordBootstrapOutcome(module, 'disabled')
        return false
    }
    // Tracked outside the try so the catch block can still report on (and keep)
    // whatever was downloaded before the failure, rather than only on a clean
    // success.
    let archivePath = null
    try {
        const defaultConfig = await getDefaultConfig(module, coin, network)
        const bootstrapDir  = module === XChainService.XCHAIN_DECODER
            ? defaultConfig["DECODER_BOOTSTRAP_VOLUME"]
            : defaultConfig["INDEXER_BOOTSTRAP_VOLUME"]

        logger.info(`Checking for a published ${module} bootstrap for ${coin}/${network}...`)
        const fileName = await downloadBootstrap(coin, network, module, bootstrapDir)
        if (!fileName) {
            logger.info('No bootstrap available; the service will sync from scratch')
            recordBootstrapOutcome(module, 'none-published')
            return false
        }
        archivePath = path.join(bootstrapDir, fileName)
        const tip = await assessNodeTipBeforeRestore(coin, network, module, archivePath)
        if (tip.refuse) {
            // Refused before any restore was attempted, so nothing needs the
            // archive as evidence; see retireBootstrapArchive for why it goes
            // anyway rather than waiting around for a re-run.
            const bytes   = await statBootstrapArchiveBytes(archivePath)
            const archive = retireBootstrapArchive(archivePath, bytes, 'restore refused, node behind; a re-run downloads a fresh copy anyway')
            recordBootstrapOutcome(module, 'node-behind', tip.detail, archive)
            return false
        }
        await restoreBootstrap(coin, network, module, fileName)
        logger.info('Bootstrap installed; the service will continue from the bootstrap height')
        const bytes   = await statBootstrapArchiveBytes(archivePath)
        const archive = retireBootstrapArchive(archivePath, bytes)
        recordRestoredOutcome(module, tip, archive)
        return true
    } catch (err) {
        const reason  = redactSecrets(err.message)
        const archive = archivePath ? reportKeptBootstrapArchive(archivePath, await statBootstrapArchiveBytes(archivePath)) : null
        logger.info(`WARNING: bootstrap auto-restore failed (${reason}): the service will sync from scratch`)
        recordBootstrapOutcome(module, 'failed', reason, archive)
        return false
    }
}

module.exports = {
    configureDependencies,
    ensureBootstrapUtxoTracker,
    ensureBootstrapMariaDb,
    forceBootstrapRequested,
    reportBootstrapOutcomes,
    resetBootstrapOutcomes
}
