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
    pingExternalDatabase, getModuleBranch, installModule, uninstallModule,
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
    installModules: sharedServices.installModules,
    syncSharedServicesAfterInstall: sharedServices.syncSharedServicesAfterInstall,
    updateModules: updateOperations.updateModules,
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
