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
 * XChain Node - Autoheal indexer recovery
 *
 * The indexer's /status stays 200 after a restart until a block commits, so a
 * passing probe alone is not proof a wedge cleared. Once a restarted indexer
 * passes beyond probation, its status body decides: a post-restart commit or a
 * ready status clears the restart count, an explicit not-ready status escalates
 * without another restart, and an unreadable body keeps the count for the next
 * pass. Every other module keeps the probe-only rule.
 ********************************************************************/

'use strict'

const childProcess = require('child_process')
const nodeUtil = require('util')
const configService = require('../config_service')
const bootstrapHealthGate = require('../bootstrap_health_gate')
const { getLastHealthyProbeMs, isRecoveryEstablished } = require('./restart_state.js')
const { getLogger } = require('../../observability/logger')
const logger = getLogger()
const execFileAsync = nodeUtil.promisify(childProcess.execFile)

function commitTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'string') return null
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
}

function classifyIndexerRecovery(payload, lastRestartMs) {
    if (!payload || typeof payload !== 'object') return 'unknown'
    const committedAt = commitTime(payload.lastBlockCommittedAt)
    if (committedAt !== null && committedAt > lastRestartMs) return 'recovered'
    if (typeof payload.ready !== 'boolean') return 'fallback'
    if (payload.ready === false) return 'stuck'
    return payload.stallReason ? 'unknown' : 'recovered'
}

async function defaultReadIndexerStatus(candidate) {
    const { probeReadinessSurface, MODULE_API_PORT_KEY } = bootstrapHealthGate
    const config = await configService.getDefaultConfig(candidate.module, candidate.coin, candidate.network)
    const port = config && config[MODULE_API_PORT_KEY[candidate.module]]
    if (!port) return null
    const runner = (cmd, args) => execFileAsync(cmd, args, { timeout: 15000 })
    return probeReadinessSurface(candidate.containerId, port, '/status', runner)
}

async function indexerRecoveryVerdict(candidate, state, readIndexerStatus) {
    if (candidate.module !== 'xchain-indexer') return { recovery: 'recovered', payload: null }
    const payload = await readIndexerStatus(candidate)
    const recovery = classifyIndexerRecovery(payload, state.restarts[candidate.containerId])
    return { recovery, payload }
}

async function skipNonUnhealthy(candidate, health, state, probationMs, result, readIndexerStatus) {
    const { module, coin, network, containerId, label } = candidate
    if (health && health.Status === 'unhealthy') return null
    let changed = false
    if (state.unhealthySince[containerId] !== undefined) {
        delete state.unhealthySince[containerId]
        changed = true
    }
    if (!health || health.Status !== 'healthy' || state.restartCount[containerId] === undefined ||
        !isRecoveryEstablished(getLastHealthyProbeMs(health), state.restarts[containerId], probationMs)) return changed
    const { recovery, payload } = await indexerRecoveryVerdict(candidate, state, readIndexerStatus)
    if (recovery === 'recovered' || recovery === 'fallback') {
        delete state.restartCount[containerId]
        return true
    }
    if (recovery === 'stuck') {
        const attempts = state.restartCount[containerId]
        result.escalated.push({ module, coin, network, containerId, attempts })
        const reasons = Array.isArray(payload.notReadyReasons) ? payload.notReadyReasons.join(', ') : ''
        logger.warn(`autoheal: ${label} committed no block after ${attempts} autoheal restart(s); investigate`
            + (payload.stallReason ? `; stall: ${payload.stallReason}` : '')
            + (reasons ? `; not ready: ${reasons}` : ''))
    } else {
        logger.info(`autoheal: ${label} passed its healthcheck after restart, but its progress status is unreadable or contradictory; keeping restart history`)
    }
    return changed
}

module.exports = { classifyIndexerRecovery, defaultReadIndexerStatus, indexerRecoveryVerdict, skipNonUnhealthy }
