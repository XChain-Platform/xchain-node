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
 * XChain Node - encoder scheduled-maintenance window
 *
 * Tells the encoder serving a coin/network that the outage it is about to
 * observe is PLANNED, so the public board (encoder.xchain.io) can paint
 * "Maintenance" instead of "Degraded".
 *
 * Why it exists: a bootstrap publish stops the UTXO tracker. The encoder
 * probes the tracker, correctly reports tracker_reachable:false, answers
 * 503, and the board has no way to tell that outage apart from a broken
 * encoder. On 2026-08-01 the monthly cron therefore showed the mainnet
 * BTC encoder Degraded for 3h36m. The probe is right and must not be
 * silenced (see xchain-encoder src/maintenanceWindow.js, which folds this
 * window in as CONTEXT and never lets it move a readiness field or the
 * 503). What was missing was the operator's own declaration.
 *
 * The sentinel is written INTO the encoder container with `docker exec
 * tee`, the same mechanism ExplorerService's config push already uses. No
 * bind mount, so an already-running encoder starts reporting maintenance
 * with no container recreate; and an encoder restart drops the file,
 * which fails in the honest direction (back to the raw fault).
 *
 * Every call here is best-effort. A publish must never fail, and a
 * tracker must never stay down, because a cosmetic status label could not
 * be written.
 ********************************************************************/

const { XChainService } = require('../config/constants')
const { db } = require('../state')
const { stringToDockerContainerFile, execContainer } = require('./DockerService')

// Must match xchain-encoder's DEFAULT_SENTINEL. The encoder side can be
// repointed with ENCODER_MAINTENANCE_FILE; repoint this with the same value.
const SENTINEL_PATH = process.env.XCHAIN_NODE_ENCODER_MAINTENANCE_FILE
    || '/tmp/xchain-encoder-maintenance.json'

// How long a declared window stays credible without being renewed. Deliberately
// generous against the slowest publish on record (3h36m) and still well under
// the encoder's own 24h ceiling, so a run that overshoots expires into an
// honest Degraded rather than excusing an outage nobody is working on.
const DEFAULT_WINDOW_MINUTES = 6 * 60

async function encoderContainerId(coin, network) {
    try {
        return await db.getModuleContainer(XChainService.XCHAIN_ENCODER, coin, network)
    } catch {
        return null
    }
}

// Declare a window on the encoder for this coin/network. Resolves true when the
// sentinel landed, false otherwise (no encoder here, or the write failed): a
// caller can log the difference but must not treat false as fatal.
async function declareEncoderMaintenance(coin, network, { reason, minutes = DEFAULT_WINDOW_MINUTES } = {}) {
    const containerId = await encoderContainerId(coin, network)
    if (!containerId) return false   // no encoder on this host; nothing to tell

    const now = Date.now()
    const sentinel = JSON.stringify({
        reason: String(reason || 'scheduled maintenance'),
        since: new Date(now).toISOString(),
        until: new Date(now + minutes * 60 * 1000).toISOString()
    })
    try {
        await stringToDockerContainerFile(containerId, sentinel + '\n', SENTINEL_PATH)
        return true
    } catch (err) {
        console.log(`Warning: could not declare the encoder maintenance window for ${coin}/${network} (${err.message}); the status board will show Degraded for the outage.`)
        return false
    }
}

// End the window early. The sentinel expires on its own, so this only shortens
// it; failing to remove it leaves the board excusing an encoder that has
// recovered, which is why the caller logs but never throws.
async function clearEncoderMaintenance(coin, network) {
    const containerId = await encoderContainerId(coin, network)
    if (!containerId) return false
    try {
        await execContainer(containerId, ['rm', '-f', SENTINEL_PATH])
        return true
    } catch (err) {
        console.log(`Warning: could not clear the encoder maintenance window for ${coin}/${network} (${err.message}); it expires on its own.`)
        return false
    }
}

module.exports = {
    declareEncoderMaintenance,
    clearEncoderMaintenance,
    SENTINEL_PATH,
    DEFAULT_WINDOW_MINUTES
}
