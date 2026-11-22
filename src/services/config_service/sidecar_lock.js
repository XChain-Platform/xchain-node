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
 * Config Service Sidecar Lock
 ********************************************************************/

'use strict'

let crypto, fs, path

function configure(dependencies) {
    ({ crypto, fs, path } = dependencies)
}

// Every sidecar write is a read-modify-write, and config loaders run in separate processes
// (a read-only command probing services alongside a mutating one deploying them). Without
// one writer at a time, two loaders that both saw no NODE_PASSWORD each mint their own and
// keep it, while only the last write lands: a container then runs with a password no later
// load reads back. A lock whose recorded pid no longer exists was left by a crashed
// process; one with no readable pid is judged by age, since the critical section is a
// small file read and write that never takes LOCK_STALE_MS. A reused pid keeps a dead
// holder's lock looking live until the wait times out with an error naming the file.
const LOCK_WAIT_MS = 15000
const LOCK_STALE_MS = 10000
const LOCK_POLL_MS = 10
let lockSleeper = null

function sidecarLockPath(filePath) {
    let target = filePath
    try { target = fs.realpathSync(filePath) } catch { /* not created yet */ }
    return target + ".lock"
}

function tryCreateLock(lockPath) {
    // Exclusive create ("wx"): exactly one process wins the name; it records its pid.
    try { fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600, flag: "wx" }) } catch (err) {
        if (err.code === "EEXIST") return false
        throw err
    }
    return true
}

// The lock's stat when its holder is gone, else null (held, or already released).
function staleLockStat(lockPath) {
    let st
    try { st = fs.statSync(lockPath) } catch { return null }
    let pid = NaN
    try { pid = parseInt(String(fs.readFileSync(lockPath, "utf8")), 10) } catch { return null }
    if (Number.isInteger(pid) && pid > 0) {
        // A recorded holder counts as gone only when the kernel says no such process
        // (EPERM is another user's live process); age never overrides a live pid.
        if (pid === process.pid) return null
        try { process.kill(pid, 0) } catch (err) { if (err.code === "ESRCH") return st }
        return null
    }
    // No readable pid: the holder died between create and write, or wrote garbage.
    return Date.now() - st.mtimeMs > LOCK_STALE_MS ? st : null
}

// Move the stale lock aside rather than unlinking by name, so a waiter that lost the
// race to break it cannot delete the fresh lock the winner has just created. If the
// inode moved aside is not the one judged stale, it belongs to a live holder: restore it.
function breakStaleLock(lockPath, staleStat) {
    const aside = lockPath + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".stale"
    try { fs.renameSync(lockPath, aside) } catch { return }
    try {
        const moved = fs.statSync(aside)
        if (moved.ino !== staleStat.ino || moved.dev !== staleStat.dev) fs.linkSync(aside, lockPath)
    } catch { /* a newer lock already took the name */ }
    try { fs.unlinkSync(aside) } catch { /* already gone */ }
}

function acquireSidecarLock(lockPath) {
    const dir = path.dirname(lockPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const deadline = Date.now() + LOCK_WAIT_MS
    while (!tryCreateLock(lockPath)) {
        const stale = staleLockStat(lockPath)
        if (stale) { breakStaleLock(lockPath, stale); continue }
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for the sidecar lock ${lockPath}; ` +
                "if no xchain-node command is running, remove that file and retry")
        }
        if (!lockSleeper) lockSleeper = new Int32Array(new SharedArrayBuffer(4))
        Atomics.wait(lockSleeper, 0, 0, LOCK_POLL_MS)
    }
}

function withSidecarLock(filePath, fn) {
    const lockPath = sidecarLockPath(filePath)
    acquireSidecarLock(lockPath)
    try { return fn() } finally { releaseSidecarLock(lockPath) }
}

// Remove the lock only while it still records this process, so a holder whose lock was
// wrongly broken never deletes the next holder's.
function releaseSidecarLock(lockPath) {
    try {
        if (String(fs.readFileSync(lockPath, "utf8")) === String(process.pid)) fs.unlinkSync(lockPath)
    } catch { /* already released */ }
}

module.exports = { configure, withSidecarLock, sidecarLockPath }
