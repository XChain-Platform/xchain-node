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
 * XChain Node - Module Operations
 * Public facade for bulk operations over lists of modules.
 ********************************************************************/

'use strict'

const path      = require('path')
const fs        = require('fs')
const readline  = require('readline')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { AsyncLocalStorage } = require('async_hooks')
const execFileAsync = promisify(execFile)
const { NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, XChainService, SEP, dataDir, EXTERNAL_DB, Coin, CoinTickerSymbol, Network, DEFAULT_MODULE_BRANCH } = require('../config')
const { db }                 = require('../state')
const { sleep }              = require('../utils/helpers')
const { getDockerContainerImageName, getUtxoTrackerVolumeName, getDockerNetwork } = require('../services/config_service')
const { createDockerNetwork, probeContainerPresenceByName, stopContainer, stopContainerByName, startContainer, restartContainer, execContainer, shellContainer, logContainer, startDockerMonitor, waitContainer, saveContainerLogs, getContainerBindMounts, removeContainer } = require('../services/docker_service')
const { stopModuleContainer } = require('../services/stop_budget_service')
const { buildDatabaseModule, resetDatabases, clearHubPriceIngestWatermark, purgeHubCrossChainRows, manualHubCrossChainPurgeStatements, getDatabaseContainerId, pingExternalDatabase } = require('../services/database_service')
const { getModuleBranch, installModule, uninstallModule } = require('../services/module_service')
const { assertHubNotBehind } = require('../services/skew_guard_service')
const { assertRequiredMigrationsApplied } = require('../services/migration_precondition_service')
const { statusChanged } = require('../services/status_service')
const { reindexAffectedModules, recordReindex } = require('../services/bootstrap_republish_ledger')
const config = require('../config')

// These service objects stay intact so tests and callers that replace an export
// after this facade loads are observed at the original call sites.
const bootstrapService       = require('../services/bootstrap_service')
const databaseService        = require('../services/database_service')
const explorerService        = require('../services/explorer_service')
const hubService             = require('../services/hub_service')
const installTargetService   = require('../services/install_target_service')
const moduleService          = require('../services/module_service')
const nodeService            = require('../services/node_service')
const releaseManifestService = require('../services/release_manifest_service')
const stateModule            = require('../state')
const validatorService       = require('../services/validator_service')
const versionService         = require('../services/version_service')

const repoRefs            = require('./module_operations/repo_refs')
const sharedServices      = require('./module_operations/shared_services')
const updateOperations    = require('./module_operations/update_modules')
const recreateOperations  = require('./module_operations/recreate_modules')
const uninstallOperations = require('./module_operations/uninstall_modules')
const moduleControls      = require('./module_operations/module_controls')
const resetOperations     = require('./module_operations/reset_modules')

const updateAllProgress = new AsyncLocalStorage()

function moduleKey(module, coin, network) {
    return JSON.stringify([module, coin, network])
}

function moduleLabel(module, coin, network) {
    return coin && network ? `${module} (${coin} ${network})` : module
}

function updateAllEntries(servicesList) {
    const shared = (servicesList[''] && servicesList['']['']) || []
    const orderedShared = [
        HUB_MODULE_NAME,
        SYNC_MODULE_NAME,
        ...shared.filter(module => module !== HUB_MODULE_NAME && module !== SYNC_MODULE_NAME)
    ]
    const entries = orderedShared.map(module => ({ module, coin: '', network: '' }))
    for (const coin of Object.keys(servicesList)) {
        if (coin === '') continue
        for (const network of Object.keys(servicesList[coin])) {
            for (const module of servicesList[coin][network]) {
                entries.push({ module, coin, network })
            }
        }
    }
    return entries
}

function moveUnmoveSummary(entries, progress) {
    const moved = entries.filter(entry => progress.moved.has(moduleKey(entry.module, entry.coin, entry.network)))
    const unmoved = entries.filter(entry => !progress.moved.has(moduleKey(entry.module, entry.coin, entry.network)))
    return '\nupdate all moved: ' + (moved.length ? moved.map(entry => moduleLabel(entry.module, entry.coin, entry.network)).join(', ') : 'none')
        + '\nupdate all unmoved: ' + (unmoved.length ? unmoved.map(entry => moduleLabel(entry.module, entry.coin, entry.network)).join(', ') : 'none')
}

function updateAllRefused(result) {
    if (result == null || result === false) return true
    if (result.refused === true || result.ok === false || result.success === false) return true
    return !Array.isArray(result.updated) || result.updated.length === 0
}

function installMoved(result) {
    return result === true || (typeof result === 'string' && result.length > 0)
}

async function installModuleWithProgress(...args) {
    const result = await installModule(...args)
    const progress = updateAllProgress.getStore()
    if (progress && args[3] === true) {
        if (installMoved(result)) {
            progress.moved.add(moduleKey(args[0], args[1], args[2]))
        } else {
            progress.refused = true
        }
    }
    return result
}

async function installModules(servicesList, ref = null) {
    let installRef = ref
    if (!installRef) {
        const target = await installTargetService.resolveUpdateTarget()
        if (target.kind === 'branch') installRef = target.ref
    }
    return sharedServices.installModules(servicesList, installRef)
}

async function updateModules(servicesList, ref = null, opts = {}) {
    if (!opts.all) return updateOperations.updateModules(servicesList, ref, opts)

    const entries = updateAllEntries(servicesList)
    const progress = { moved: new Set(), refused: false }
    let result
    try {
        result = await updateAllProgress.run(progress, () => updateOperations.updateModules(servicesList, ref, opts))
    } catch (err) {
        const summary = moveUnmoveSummary(entries, progress)
        if (err && typeof err === 'object' && typeof err.message === 'string') {
            err.message += summary
            throw err
        }
        throw new Error(String(err) + summary)
    }

    if (entries.length > 0 && (progress.refused || updateAllRefused(result))) {
        console.log(moveUnmoveSummary(entries, progress))
    }
    return result
}

const dependencies = {
    path, fs, readline, execFileAsync,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME,
    SYNC_MODULE_NAME, XChainService, SEP, dataDir, EXTERNAL_DB, Coin,
    CoinTickerSymbol, Network, DEFAULT_MODULE_BRANCH, db, sleep,
    getDockerContainerImageName, getUtxoTrackerVolumeName, getDockerNetwork,
    createDockerNetwork, probeContainerPresenceByName, stopContainer,
    stopContainerByName, startContainer, restartContainer, execContainer,
    shellContainer, logContainer, startDockerMonitor, waitContainer,
    saveContainerLogs, getContainerBindMounts, removeContainer,
    stopModuleContainer, buildDatabaseModule, resetDatabases,
    clearHubPriceIngestWatermark, purgeHubCrossChainRows,
    manualHubCrossChainPurgeStatements, getDatabaseContainerId,
    pingExternalDatabase, getModuleBranch, installModule: installModuleWithProgress, uninstallModule,
    assertHubNotBehind, assertRequiredMigrationsApplied, statusChanged,
    reindexAffectedModules, recordReindex, config, bootstrapService,
    databaseService, explorerService, hubService, installTargetService,
    moduleService, nodeService, releaseManifestService, stateModule,
    validatorService, versionService
}

repoRefs.configure(dependencies)
dependencies.withInstallTarget = repoRefs.withInstallTarget
dependencies.confirmDestructiveReset = repoRefs.confirmDestructiveReset
dependencies.isNoSuchContainerError = repoRefs.isNoSuchContainerError
dependencies.isNoSuchVolumeError = repoRefs.isNoSuchVolumeError
dependencies.failureReason = repoRefs.failureReason
dependencies.restartStoppedModules = repoRefs.restartStoppedModules
dependencies.resolveNodeDataPath = repoRefs.resolveNodeDataPath
sharedServices.configure(dependencies)
updateOperations.configure(dependencies)
recreateOperations.configure(dependencies)
uninstallOperations.configure(dependencies)
moduleControls.configure(dependencies)
dependencies.restartResetModules = moduleControls.restartResetModules
resetOperations.configure(dependencies)

module.exports = {
    installModules,
    syncSharedServicesAfterInstall: sharedServices.syncSharedServicesAfterInstall,
    updateModules,
    recreateModules: recreateOperations.recreateModules,
    uninstallModules: uninstallOperations.uninstallModules,
    logModules: moduleControls.logModules,
    monitorModules: moduleControls.monitorModules,
    restartModules: moduleControls.restartModules,
    stopModules: moduleControls.stopModules,
    startModules: moduleControls.startModules,
    execModules: moduleControls.execModules,
    clearDecoderReorgHalt: moduleControls.clearDecoderReorgHalt,
    shellModule: moduleControls.shellModule,
    runE2ETest: repoRefs.runE2ETest,
    resetModules: resetOperations.resetModules
}
