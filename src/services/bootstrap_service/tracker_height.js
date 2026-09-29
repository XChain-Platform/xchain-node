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
 * The end height a utxo-tracker bootstrap archive records. The store is
 * LevelDB, so the tracker's own status surface is the only thing that can
 * tell; the restore-time node tip guard trusts the recorded height as a
 * bound the archived data never exceeds.
 ********************************************************************/

let { execFile }          = require('child_process')
const { promisify }       = require('util')
let execFileAsync         = promisify(execFile)

let { XChainService } = require('../../config')
let { getDefaultConfig } = require('../config_service')
let bootstrapHealthGate = require('../bootstrap_health_gate')
const { redactSecrets } = require('../../utils/helpers')
const { getLogger } = require('../../observability/logger')
let logger = getLogger()

// Takes the same dependency bag tracker_archive.js is configured with.
function configureDependencies(dependencies) {
    ;({ execFile } = dependencies.childProcess)
    execFileAsync = promisify(execFile)
    ;({ XChainService } = dependencies.config)
    ;({ getDefaultConfig } = dependencies.configService)
    bootstrapHealthGate = dependencies.bootstrapHealthGate
    logger = dependencies.logger
}

// How long a just-restarted tracker gets to answer its status surface before the pre-stop floor is used instead.
const POST_RESTART_PROBE_ATTEMPTS = 12
const POST_RESTART_PROBE_DELAY_MS = 5000

// The tracker's committed height from its status surface, or null. Asked
// before the stop (a floor) and again after the restart (the recorded height).
async function readTrackerCommittedHeight(coin, network, containerId, { quiet = false } = {}) {
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
        if (!quiet) logger.info(`Could not read the tracker height for the archive metadata (${redactSecrets(err.message)}); the archive will carry no height.`)
        return null
    }
}

// The restarted tracker's committed height, retried while its API comes up, or null.
async function readTrackerHeightAfterRestart(coin, network, containerId, { attempts = POST_RESTART_PROBE_ATTEMPTS, delayMs = POST_RESTART_PROBE_DELAY_MS } = {}) {
    // No status probe wired in: nothing a retry could change.
    if (typeof bootstrapHealthGate.probeServiceStatus !== 'function') return null
    for (let i = 0; i < attempts; i++) {
        const height = await readTrackerCommittedHeight(coin, network, containerId, { quiet: true })
        if (height !== null) return height
        if (i + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs))
    }
    return null
}

// Pick the height the archive records: never below the data it holds, since the restore guard treats nodeHeight >= archiveHeight as safe.
// max() keeps a rollback during the restart from lowering it. With no post-restart reading, the pre-stop floor is kept (a height off by
// the stop window still guards more than none, which the guard reads as "unknown" and restores unchecked).
function chooseArchiveHeight(preStopHeight, postRestartHeight) {
    const pre  = Number.isInteger(preStopHeight) ? preStopHeight : null
    const post = Number.isInteger(postRestartHeight) ? postRestartHeight : null
    const chosen = post === null ? pre : pre === null ? post : Math.max(pre, post)
    if (post === null && pre !== null) {
        logger.info(`WARNING: could not read the tracker height after the restart; the archive records the pre-stop height ${pre}, ` +
            'which may understate the archived data by the blocks committed while the tracker was stopping.')
    } else {
        logger.info(`Archive height: ${chosen === null ? 'unknown' : chosen} (pre-stop ${pre === null ? 'unknown' : pre}, after restart ${post === null ? 'unknown' : post}).`)
    }
    return chosen
}

module.exports = {
    configureDependencies,
    readTrackerCommittedHeight,
    readTrackerHeightAfterRestart,
    chooseArchiveHeight
}
