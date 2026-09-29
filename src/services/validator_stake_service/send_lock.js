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
 * XChain Node - Validator Stake Send Lock
 * Holds the command lock across a broadcast's send phase only
 ********************************************************************/

// Stand in for the lock when the caller passed none, or the run is a dry run.
const NO_LOCK = Object.freeze({ hold() {}, release() {} })

// Pick the lock a run serializes its sends on. Only --broadcast sends anything,
// so a dry run never takes it and can inspect the plan during a deploy.
function sendLockFor(opts, deps) {
    return (opts && opts.broadcast && deps && deps.sendLock) ? deps.sendLock : NO_LOCK
}

// Hand the lock back when the SDK starts its indexer wait, which follows every
// broadcast of the action. A wait of up to --timeout must not block other commands.
function releaseOnIndexWait(lock) {
    return (step) => { if (step === 'waiting') lock.release() }
}

// Take the lock before the next send, naming what already went out when refused.
// A refusal mid-run leaves the earlier transactions broadcast, and the operator re-runs.
function holdForSend(lock, sent, kind) {
    try {
        lock.hold()
    } catch (err) {
        if (!sent.length) throw err
        const stopped = new Error(err.message + ' Stopped before the ' + kind + '; already broadcast: ' +
            sent.map(s => s.step + ' ' + s.txid).join(', ') + '. Re-run this command once that one finishes.')
        stopped.code = err.code
        throw stopped
    }
}

module.exports = { NO_LOCK, sendLockFor, releaseOnIndexWait, holdForSend }
