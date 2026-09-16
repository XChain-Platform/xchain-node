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
 * XChain Node - command lockfile
 *
 * Two concurrent xchain-node invocations that mutate state (install,
 * update, uninstall, reset, ...) can interleave Docker builds, DB
 * provisioning, and hub/explorer config pushes, corrupting the stack.
 * This module serializes them with a pidfile-style lock in
 * ~/.xchain-node/command.lock (same per-user dir as credentials.json).
 *
 * The lock is acquired with an atomic O_EXCL create. If the file
 * already exists, the recorded pid is probed with signal 0: a live pid
 * refuses the new invocation; a dead pid marks the lock stale, removes
 * it, and retries.
 *
 * Removing a stale lock is itself serialized, behind a second O_EXCL
 * marker at command.lock.reclaim. Exclusive create alone does NOT make
 * reclamation mutually exclusive: two invocations can read the same dead
 * holder, and the second then deletes the LIVE lock the first just
 * created and acquires on top of it, so both run (uuid:b5127aa1). Only
 * the marker's owner may unlink, and inside the marker it re-reads the
 * holder and re-checks the file's dev/ino identity first, so a
 * successor's lock is never the file removed. A crash inside the marker
 * leaves it behind; the next contender breaks it only when the pid it
 * records is gone, and then loops rather than reclaiming in that pass.
 *
 * Each acquisition also stamps a random nonce into the payload. Release
 * removes the file only when both the pid and the nonce still match, so
 * neither a stale-lock takeover nor a recycled pid is clobbered on exit.
 *
 * Ops note: clearing a wedged lock by hand may mean deleting both
 * command.lock and command.lock.reclaim.
 ********************************************************************/

const crypto = require('crypto')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const config = require('../config');

const LOCK_DIR_NAME  = '.xchain-node'
const LOCK_FILE_NAME = 'command.lock'
// The reclaim marker sits beside the lock, so both are on one filesystem and an
// ops wipe of the lock dir clears the pair.
const RECLAIM_FILE_SUFFIX = '.reclaim'
// Bounded so acquire can never spin: every pass either takes the lock, refuses a
// live holder, or concedes one reclaim attempt to a contender.
const MAX_ACQUIRE_ATTEMPTS = 8
const RECLAIM_POLL_MS      = 5

function getLockFilePath() {
    // XCHAIN_NODE_LOCK_DIR is a test/ops override; default matches the
    // CredentialsService per-user directory.
    const dir = config.XCHAIN_NODE_LOCK_DIR || path.join(os.homedir(), LOCK_DIR_NAME)
    return path.join(dir, LOCK_FILE_NAME)
}

// Returns true when a process with this pid is alive (or exists but is
// owned by another user, which EPERM implies); false when it is gone.
function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (err) {
        return err.code === 'EPERM'
    }
}

// Blocking sleep that keeps acquireCommandLock synchronous (its callers use it
// synchronously). Atomics.wait on a private SharedArrayBuffer parks the thread
// for ms without a busy-loop and without pulling in a dependency.
function sleepSync(ms) {
    if (ms <= 0) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Identify the FILE rather than the path. A reclaim that compares dev+ino cannot
// unlink a successor's lock that merely took the same name.
function statLock(lockFile) {
    try {
        const st = fs.statSync(lockFile)
        return { dev: st.dev, ino: st.ino }
    } catch {
        return null
    }
}

function sameFile(a, b) {
    return !!a && !!b && a.dev === b.dev && a.ino === b.ino
}

// Break a reclaim marker left behind by a crash, and ONLY that: a marker whose
// recorded pid is still alive belongs to a contender currently inside the reclaim
// section, and removing it would restore the very race the marker prevents.
function breakAbandonedReclaimMarker(reclaimFile) {
    const owner = readLockHolder(reclaimFile)
    if (owner && isPidAlive(owner.pid)) return
    try { fs.unlinkSync(reclaimFile) } catch { /* already gone */ }
}

// Serialize one stale-lock reclamation behind the O_EXCL marker. Returns nothing:
// the caller simply retries its exclusive create, whether this pass removed the
// stale lock, conceded the marker to a contender, or found a live successor.
function reclaimStaleLock(lockFile, reclaimFile, observed, pid, nonce) {
    const marker = JSON.stringify({ pid, nonce, startedAt: new Date().toISOString() }) + '\n'
    try {
        fs.writeFileSync(reclaimFile, marker, { flag: 'wx', mode: 0o600 })
    } catch (err) {
        if (err.code !== 'EEXIST') throw err
        // Break-then-loop, never break-and-reclaim in the same pass: reclaiming on
        // the strength of a marker we just removed is the unguarded unlink again.
        breakAbandonedReclaimMarker(reclaimFile)
        sleepSync(RECLAIM_POLL_MS)
        return
    }
    try {
        // Re-read INSIDE the marker. The observation that sent us here predates the
        // marker, so it may already describe a file another contender replaced.
        const current = statLock(lockFile)
        if (!current) return
        const holder = readLockHolder(lockFile)
        if (holder && isPidAlive(holder.pid)) return
        if (!sameFile(observed, current)) return
        try { fs.unlinkSync(lockFile) } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') throw unlinkErr
        }
    } finally {
        try { fs.unlinkSync(reclaimFile) } catch { /* already gone */ }
    }
}

// One acquire pass with serialized stale-lock removal and bounded retries.
// Returns a release() on success; throws a tagged ELOCKHELD error when a LIVE
// holder owns the lock (the caller may then choose to wait and retry); throws any
// other error (fs failure, or lost post-stale race) as fatal.
function tryAcquireOnce(lockFile, payload, pid, nonce) {
    const reclaimFile = lockFile + RECLAIM_FILE_SUFFIX
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
        try {
            fs.writeFileSync(lockFile, payload, { flag: 'wx', mode: 0o600 })
            return function release() { releaseCommandLock(lockFile, pid, nonce) }
        } catch (err) {
            if (err.code !== 'EEXIST') throw err
            const holder   = readLockHolder(lockFile)
            const observed = statLock(lockFile)
            if (holder && isPidAlive(holder.pid)) {
                const what = holder.command ? ` (running "${holder.command}")` : ''
                const held = new Error(
                    `Another xchain-node instance${what} holds the command lock ` +
                    `(pid ${holder.pid}, ${lockFile}). Wait for it to finish, ` +
                    `or delete the lock file if that pid is not xchain-node.`
                )
                held.code = 'ELOCKHELD'
                throw held
            }
            // Holder pid is dead (or the file is unreadable garbage): the lock is
            // stale, likely from a crashed/killed run. The file may also have gone
            // between the read and the stat, in which case the retry just creates it.
            if (observed) reclaimStaleLock(lockFile, reclaimFile, observed, pid, nonce)
        }
    }
    // Every attempt hit EEXIST: another invocation won the post-stale race.
    throw new Error(`Could not acquire the xchain-node command lock at ${lockFile} (lost the race to another invocation).`)
}

// Acquire the command lock or throw. On success returns a release()
// function; call it when the command finishes (also wired to process
// exit by the caller).
//
// waitMs > 0 makes a LIVE-held lock block-and-poll (every pollMs) up to waitMs
// before giving up, so a short/read-only command pauses for a lock-holding
// mutator instead of failing outright. The default waitMs=0 preserves the
// original refuse-immediately behavior for mutating commands.
function acquireCommandLock({ pid = process.pid, command = '', waitMs = 0, pollMs = 200 } = {}) {
    const lockFile = getLockFilePath()
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })

    // One nonce per acquisition, stable across the retry loop: it is what makes
    // "this lock is ours" provable at release time, where a pid can be recycled.
    const nonce = crypto.randomBytes(16).toString('hex')

    const deadline = Date.now() + Math.max(0, waitMs)
    for (;;) {
        const payload = JSON.stringify({ pid, nonce, command, startedAt: new Date().toISOString() }) + '\n'
        try {
            return tryAcquireOnce(lockFile, payload, pid, nonce)
        } catch (err) {
            // Only a live-held lock is retryable; anything else is fatal.
            if (err.code === 'ELOCKHELD' && Date.now() < deadline) {
                sleepSync(Math.min(pollMs, Math.max(0, deadline - Date.now())))
                continue
            }
            throw err
        }
    }
}

function readLockHolder(lockFile) {
    try {
        const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
        return (parsed && Number.isInteger(parsed.pid)) ? parsed : null
    } catch {
        return null
    }
}

function releaseCommandLock(lockFile, pid, nonce) {
    // Only delete a lock we still own; never clobber a successor's lock. The nonce
    // is what makes ownership provable: a successor that happens to run under a
    // RECYCLED pid matches on pid alone, and would be clobbered on our exit.
    const holder = readLockHolder(lockFile)
    if (!holder || holder.pid !== pid) return
    if (holder.nonce !== nonce) return
    try { fs.unlinkSync(lockFile) } catch { /* already gone */ }
}

module.exports = { acquireCommandLock, getLockFilePath, isPidAlive }
