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
 * XChain Node - Reset wipe safety
 * The wipe-image pre-flight and the report for a wipe that started and failed
 ********************************************************************/

'use strict'

// The image every reset wipe runs `find /data -mindepth 1 -delete` in.
const WIPE_IMAGE = 'alpine'

// Make sure the wipe image is on this host BEFORE anything is stopped. A missing image (an offline host that cannot pull) is the one wipe failure that provably deletes nothing, so it is refused
// here, while the stack is whole and "No data was touched" is still true. Every failure after this point is a wipe that STARTED, which reportPartialWipe handles. Never throws.
async function ensureWipeImage(execFileAsync, failureReason) {
    try {
        await execFileAsync('docker', ['image', 'inspect', WIPE_IMAGE])
        return true
    } catch { /* not cached on this host; try to pull it */ }
    try {
        console.log(`Pulling the ${WIPE_IMAGE} image used to clear the data...`)
        await execFileAsync('docker', ['pull', WIPE_IMAGE])
        return true
    } catch (err) {
        console.log(`Aborted: cannot obtain the ${WIPE_IMAGE} image used to clear the data (${failureReason(err)}). No data was touched.`)
        return false
    }
}

// Report a wipe that started and failed, then end the reset with every stopped service LEFT DOWN. A non-zero exit does not prove nothing was deleted: `find -delete` removes every entry it can
// before it exits non-zero on a per-entry error, and a daemon can die mid-run, so the target may be partly cleared. Restarting a service over it, or dropping the decoder/indexer databases around
// it, would run a store that no longer describes the chain, so nothing restarts and nothing else is wiped until the operator re-runs the same reset. Returns false for the caller to return.
function reportPartialWipe(context, { target, err, failureReason, nodeCleared = [], trackerUntouched = false }) {
    const { resetDecoder, resetIndexer, stoppedModules = [], utxoVolumeName } = context
    console.log(`Aborted: clearing ${target} failed (${failureReason(err)}).`)
    console.log(`  ${target} may be PARTLY cleared.`)
    if (nodeCleared.length > 0) {
        console.log(`  The node data for this stack WAS already cleared: ${nodeCleared.join(', ')}.`)
    }
    // Name only the stores this reset was going to wipe and never reached, so the operator knows what still holds its old data.
    const untouched = []
    if (trackerUntouched) untouched.push(`the Docker volume ${utxoVolumeName}`)
    if (resetDecoder || resetIndexer) untouched.push('the decoder/indexer databases')
    if (untouched.length > 0) console.log(`  NOT touched: ${untouched.join(', ')}.`)
    console.log(`  The stopped services are left down: ${stoppedModules.length > 0 ? stoppedModules.join(', ') : 'none'}.`)
    console.log('  Fix the problem and re-run the same reset command.')
    return false
}

module.exports = { WIPE_IMAGE, ensureWipeImage, reportPartialWipe }
