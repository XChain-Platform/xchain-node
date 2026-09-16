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
 * XChain Node - Status Service
 * Tracks installed modules and container status
 ********************************************************************/

const {
    NODE_MODULE_NAME, SEP, Coin, Network, XChainService
} = require('../config')
const {
    db,
    getInstalledModules, setInstalledModules, resetInstalledModules,
    getRemoteModuleVersions,
    isStatusUpdated, setStatusUpdated,
    getLastStatus, setLastStatus,
    getLastPrintedStatus, setLastPrintedStatus, appendLastPrintedStatus
} = require('../state')
const { getStatusFromContainer }         = require('./docker_service')
const { checkRemoteNodeVersion, getLocalNodeVersion, getContainerNodeVersion, getLocalModuleVersion, getContainerModuleVersion } = require('./version_service')
const { redactSecrets }                  = require('../utils/helpers')
// Destructured where they are used, so each call reads the export at that moment.
const childProcess                       = require('child_process')
const nodeUtil                           = require('util')
const configService                      = require('./config_service')
const peers                              = require('./peer_services').bindPeerServices(require)
const { getLogger } = require('../observability/logger');
const logger = getLogger();

const {
    checkRemoteNodeVersionAdvisory,
    loadInstalledModules,
    configureDependencies: configureInstalledModules
} = require('./status_service/installed_modules.js')
const {
    isContainerGoneError, probeServiceHealthPayload,
    reduceNodeCatchingUp, describeNodeCatchingUpNote,
    reduceNodeUnreachable, describeNodeUnreachableNote, describeDuration,
    reduceDecoderReorgHalt, describeReorgHaltNote,
    reduceIndexerStall, describeIndexerStallNote,
    reduceTrackerHalt, describeTrackerHaltNote,
    configureDependencies: configureStatusReducers
} = require('./status_service/status_reducers.js')
const { getStatus, configureDependencies: configureGetStatus } = require('./status_service/get_status.js')

configureInstalledModules({ db, getInstalledModules, checkRemoteNodeVersion, redactSecrets, getLogger, logger })
configureStatusReducers({ XChainService, childProcess, nodeUtil, configService, peers })
configureGetStatus({
    NODE_MODULE_NAME, SEP, XChainService, db, getInstalledModules, resetInstalledModules,
    getRemoteModuleVersions, isStatusUpdated, setStatusUpdated, getLastStatus,
    setLastStatus, getLastPrintedStatus, setLastPrintedStatus, getStatusFromContainer,
    getLocalNodeVersion, getContainerNodeVersion, getLocalModuleVersion,
    getContainerModuleVersion, peers, getLogger, logger,
    checkRemoteNodeVersionAdvisory, loadInstalledModules, isContainerGoneError,
    probeServiceHealthPayload, reduceNodeCatchingUp, describeNodeCatchingUpNote,
    reduceNodeUnreachable, describeNodeUnreachableNote, reduceDecoderReorgHalt,
    describeReorgHaltNote, reduceIndexerStall, describeIndexerStallNote,
    reduceTrackerHalt, describeTrackerHaltNote
})

// The two config pushes are independent targets, so neither may cancel the
// other. An updateHub() rejection for an unattached shared container must not
// skip the explorer push and strand the explorer on stale config in addition
// to the unreachable network.
// Run both, then report: the first error still propagates, so every caller
// keeps failing loudly, but only the step that actually failed is lost.
async function statusChanged() {
    setStatusUpdated(false)
    const { updateHub }      = peers.hubService
    const { updateExplorer } = peers.explorerService

    let firstErr = null
    try { await updateHub() }      catch (err) { firstErr = err }
    try { await updateExplorer() } catch (err) { if (!firstErr) firstErr = err }
    if (firstErr) throw firstErr
}

async function getInstalledCoinsAndNetworks() {
    const modulesStatus = await getStatus(null, null, false)
    const result = {}

    for (const nextCoin in modulesStatus) {
        if (Object.values(Coin).includes(nextCoin)) {
            result[nextCoin] = []
            for (const nextNetwork in modulesStatus[nextCoin]) {
                if (Object.values(Network).includes(nextNetwork)) {
                    result[nextCoin].push(nextNetwork)
                }
            }
        }
    }

    return result
}

module.exports = {
    statusChanged,
    getStatus,
    loadInstalledModules,
    getInstalledCoinsAndNetworks,
    // Exported for tests
    reduceDecoderReorgHalt,
    describeReorgHaltNote,
    reduceNodeCatchingUp,
    describeNodeCatchingUpNote,
    reduceNodeUnreachable,
    describeNodeUnreachableNote,
    describeDuration,
    reduceIndexerStall,
    describeIndexerStallNote,
    reduceTrackerHalt,
    describeTrackerHaltNote
}
