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

const fs = require('fs')
const axios = require('axios')
const zlib = require('zlib')
const childProcess = require('child_process')

const config = require('../config')
const state = require('../state')
const configService = require('./config_service')
const dockerService = require('./docker_service')
const databaseService = require('./database_service')
const bootstrapHealthGate = require('./bootstrap_health_gate')
const republishLedger = require('./bootstrap_republish_ledger')
const encoderMaintenance = require('./encoder_maintenance_window')
const archiveMeta = require('./bootstrap_archive_meta')
const nodeTipGuard = require('./bootstrap_node_tip_guard')
const { getLogger } = require('../observability/logger')
const logger = getLogger()
const BOOTSTRAP_STALE_AFTER_DAYS = 10

const {
    configureDependencies: configureArchiveSigning,
    BootstrapIntegrityError,
    signBootstrapArchive,
    verifyBootstrapSignature,
    checkBootstrapSignature,
    loadBootstrapPublicKey,
    maybeSignBootstrap,
    computeSha256,
    ensureVerifiedInnerArchive
} = require('./bootstrap_service/archive_signing')
const {
    configureDependencies: configureWorkspace,
    startProgress,
    buildDateTimeString,
    getWorkDir,
    assertBootstrapCapacity,
    ensureDir,
    ensureDirWritable,
    getBootstrapFilesList
} = require('./bootstrap_service/workspace')
const {
    configureDependencies: configureTrackerArchive,
    makeBootstrapUtxoTracker
} = require('./bootstrap_service/tracker_archive')
const {
    configureDependencies: configureMariadbArchive,
    makeBootstrapMariaDb
} = require('./bootstrap_service/mariadb_archive')
const {
    configureDependencies: configureRestoreArchive,
    restoreBootstrap
} = require('./bootstrap_service/restore_archive')
const {
    configureDependencies: configureFreshness,
    FRESHNESS_EMPTY,
    FRESHNESS_POPULATED,
    FRESHNESS_UNKNOWN,
    UTXO_TRACKER_LISTING_COMMAND,
    utxoTrackerVolumeFreshness,
    mariaDbModuleFreshness
} = require('./bootstrap_service/freshness')
const {
    configureDependencies: configureDownload,
    downloadBootstrap,
    bootstrapArchiveAgeDays
} = require('./bootstrap_service/download')
const {
    configureDependencies: configureEnsureRestored,
    ensureBootstrapUtxoTracker,
    ensureBootstrapMariaDb,
    forceBootstrapRequested,
    reportBootstrapOutcomes,
    resetBootstrapOutcomes
} = require('./bootstrap_service/ensure_restored')

const archiveSigning = {
    checkBootstrapSignature, computeSha256, ensureVerifiedInnerArchive, maybeSignBootstrap
}
const workspace = {
    assertBootstrapCapacity, buildDateTimeString, ensureDir, ensureDirWritable,
    getWorkDir, startProgress
}
const restoreArchive = { restoreBootstrap }
const download = { downloadBootstrap }

configureArchiveSigning({ fs, childProcess, config, logger })
configureWorkspace({ fs, childProcess, config, configService, directoryMode: '755' })
configureTrackerArchive({
    fs, zlib, childProcess, config, state, configService, dockerService,
    bootstrapHealthGate, archiveMeta, encoderMaintenance, archiveSigning, workspace, logger
})
configureMariadbArchive({
    fs, zlib, childProcess, config, configService, databaseService,
    bootstrapHealthGate, archiveMeta, archiveSigning, workspace, logger
})
configureRestoreArchive({
    fs, zlib, childProcess, config, state, configService, dockerService,
    databaseService, archiveSigning, workspace, logger
})
configureFreshness({ childProcess, config, configService, databaseService, logger })
configureDownload({ fs, axios, config, workspace, logger, staleAfterDays: BOOTSTRAP_STALE_AFTER_DAYS })
configureEnsureRestored({
    fs, config, configService, nodeTipGuard, restoreArchive, download, logger
})

const { XChainService } = config
const { db } = state
const { assertBootstrapSourceHealthy } = bootstrapHealthGate
const { recordBootstrapPublished } = republishLedger
async function makeBootstrap(coin, network, module) {
    switch (module) {
        case XChainService.XCHAIN_UTXO_TRACKER:
        case XChainService.XCHAIN_DECODER:
        case XChainService.XCHAIN_INDEXER:
            break
        default:
            throw new Error(`Unsupported module for bootstrap create: ${module}`)
    }

    // Refuse to snapshot a source that is not known-good, BEFORE any work
    // (and, for the utxo-tracker, before the container is stopped, so a refusal
    // costs no downtime). A published archive becomes the newest file in the served
    // directory and so the default choice for every restore path, including
    // `bootstrap restore --latest`; publishing an unverified snapshot silently
    // replaces the last good archive. The unsupported-module throw above stays
    // first so an unknown module still fails on its own message.
    // Keep the reading. It carries the marker-table watermark the post-dump gate
    // needs in order to see a halt that was raised and then cleared while the dump
    // was streaming, which no live reading taken afterwards can report.
    const preflight = await assertBootstrapSourceHealthy(coin, network, module)

    const result = module === XChainService.XCHAIN_UTXO_TRACKER
        ? await makeBootstrapUtxoTracker(coin, network)
        : await makeBootstrapMariaDb(coin, network, module, preflight && preflight.watermark)

    // A fresh archive is a fresh LINEAGE, so it clears any republish this
    // combo was owed after a reset (see BootstrapRepublishLedger). Recorded on
    // CREATE rather than after the upload: the create is what re-derives the
    // archive from the post-reindex store, and an upload that then fails is
    // already reported as PUBLISH-FAIL and retried by the next scheduled run.
    // Never fatal - the archive exists either way.
    try {
        recordBootstrapPublished(module, coin, network)
    } catch (err) {
        logger.info(`Warning: could not clear the bootstrap republish marker for ${module} ${coin}/${network} (${err.message}).`)
    }

    return result
}

// The services a bootstrap archive can be built from, in the order the
// publisher lists them.
const BOOTSTRAPPABLE_SERVICES = [
    XChainService.XCHAIN_DECODER,
    XChainService.XCHAIN_INDEXER,
    XChainService.XCHAIN_UTXO_TRACKER
]

// Every served <service>:<coin>:<network> combo, read from the module REGISTRY
// rather than from live containers. A plan built from `docker ps` drops a
// stopped or crash-looping combo before the source-health gate can report it,
// allowing its consumer archive to go stale. The registry keeps a
// row for a stopped container (DiscoveryService prunes against `docker ps -a`,
// not `docker ps`), so reading it puts every installed combo into the plan and
// lets the health gate refuse the unhealthy ones loudly.
//
// regtest is skipped: it is a throwaway local chain with no consumer archive.
async function listServedBootstrapCombos() {
    const rows = await db.getAllModuleContainers(null, null)
    const combos = new Set()
    for (const row of rows || []) {
        if (!BOOTSTRAPPABLE_SERVICES.includes(row.module)) continue
        if (!row.coin || !row.network) continue
        if (row.network === 'regtest') continue
        combos.add(`${row.module}:${row.coin}:${row.network}`)
    }
    return Array.from(combos).sort()
}

module.exports = {
    BootstrapIntegrityError,
    listServedBootstrapCombos,
    getBootstrapFilesList,
    makeBootstrap,
    restoreBootstrap,
    downloadBootstrap,
    utxoTrackerVolumeFreshness,
    UTXO_TRACKER_LISTING_COMMAND,
    ensureBootstrapUtxoTracker,
    mariaDbModuleFreshness,
    ensureBootstrapMariaDb,
    FRESHNESS_EMPTY,
    FRESHNESS_POPULATED,
    FRESHNESS_UNKNOWN,
    forceBootstrapRequested,
    reportBootstrapOutcomes,
    resetBootstrapOutcomes,
    bootstrapArchiveAgeDays,
    BOOTSTRAP_STALE_AFTER_DAYS,
    // Bootstrap signing (supply-chain integrity)
    signBootstrapArchive,
    verifyBootstrapSignature,
    checkBootstrapSignature,
    loadBootstrapPublicKey,
    ensureVerifiedInnerArchive
}
