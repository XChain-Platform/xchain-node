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
 * it, and retries. Release removes the file only when it still holds
 * our own pid, so a stale-lock takeover by another process is never
 * clobbered on exit.
 ********************************************************************/

const fs   = require('fs')
const os   = require('os')
const path = require('path')

const LOCK_DIR_NAME  = '.xchain-node'
const LOCK_FILE_NAME = 'command.lock'

function getLockFilePath() {
    // XCHAIN_NODE_LOCK_DIR is a test/ops override; default matches the
    // CredentialsService per-user directory.
    const dir = process.env.XCHAIN_NODE_LOCK_DIR || path.join(os.homedir(), LOCK_DIR_NAME)
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

// One acquire pass with the stale-lock removal + single retry. Returns a
// release() on success; throws a tagged ELOCKHELD error when a LIVE holder owns
// the lock (the caller may then choose to wait and retry); throws any other
// error (fs failure, or lost post-stale race) as fatal.
function tryAcquireOnce(lockFile, payload, pid) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(lockFile, payload, { flag: 'wx', mode: 0o600 })
            return function release() { releaseCommandLock(lockFile, pid) }
        } catch (err) {
            if (err.code !== 'EEXIST') throw err
            const holder = readLockHolder(lockFile)
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
            // Holder pid is dead (or the file is unreadable garbage): the
            // lock is stale, likely from a crashed/killed run. Remove and
            // retry once; a racing remover makes unlink ENOENT, which is fine.
            try { fs.unlinkSync(lockFile) } catch (unlinkErr) {
                if (unlinkErr.code !== 'ENOENT') throw unlinkErr
            }
        }
    }
    // Both attempts hit EEXIST: another invocation won the post-stale race.
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

    const deadline = Date.now() + Math.max(0, waitMs)
    for (;;) {
        const payload = JSON.stringify({ pid, command, startedAt: new Date().toISOString() }) + '\n'
        try {
            return tryAcquireOnce(lockFile, payload, pid)
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

function releaseCommandLock(lockFile, pid) {
    // Only delete a lock we still own; never clobber a successor's lock.
    const holder = readLockHolder(lockFile)
    if (!holder || holder.pid !== pid) return
    try { fs.unlinkSync(lockFile) } catch { /* already gone */ }
}

module.exports = { acquireCommandLock, getLockFilePath, isPidAlive }
