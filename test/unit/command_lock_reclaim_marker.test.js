'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const fs     = require('fs')
const os     = require('os')
const path   = require('path')

const { acquireCommandLock, getLockFilePath, isPidAlive } = require('../../src/utils/command_lock')

let tmpDir

function findDeadPid() {
    let deadPid = 999999
    while (isPidAlive(deadPid)) deadPid--
    return deadPid
}

function registerLockDirectoryHooks() {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-lock-'))
        process.env.XCHAIN_NODE_LOCK_DIR = tmpDir
    })

    afterEach(() => {
        delete process.env.XCHAIN_NODE_LOCK_DIR
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })
}

describe('commandLock publishes the reclaim marker atomically', () => {
    registerLockDirectoryHooks()

    // An empty marker reads as abandoned, so a contender could break a live reclaimer's marker.
    it('never creates the reclaim marker with a separate open-then-write', () => {
        const lockFile = getLockFilePath()
        const reclaimFile = lockFile + '.reclaim'
        fs.writeFileSync(lockFile, JSON.stringify({ pid: findDeadPid(), command: 'install' }) + '\n')
        const realWrite = fs.writeFileSync
        const realLink  = fs.linkSync
        const directWrites = []
        let markerAtAppearance = null
        fs.writeFileSync = function (file, ...args) {
            if (file === reclaimFile) directWrites.push(file)
            return realWrite.call(fs, file, ...args)
        }
        fs.linkSync = function (from, to) {
            const r = realLink.call(fs, from, to)
            if (to === reclaimFile) markerAtAppearance = fs.readFileSync(reclaimFile, 'utf8')
            return r
        }
        let release
        try {
            release = acquireCommandLock({ command: 'update' })
        } finally {
            fs.writeFileSync = realWrite
            fs.linkSync = realLink
        }
        assert.deepStrictEqual(directWrites, [], 'reclaim marker must not be created by a two-step open+write')
        assert.ok(markerAtAppearance && JSON.parse(markerAtAppearance).pid === process.pid,
            'reclaim marker must be complete the moment it appears')
        assert.strictEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid)
        assert.deepStrictEqual(fs.readdirSync(tmpDir), ['command.lock'], 'no marker or temp file left behind')
        release()
    })
})

describe('commandLock publishes the reclaim marker atomically', () => {
    registerLockDirectoryHooks()

    it('does not remove a reclaim marker it no longer owns', () => {
        const lockFile = getLockFilePath()
        const reclaimFile = lockFile + '.reclaim'
        const deadPid = findDeadPid()
        fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, command: 'install' }) + '\n')
        const realKill = process.kill
        let replaced = false
        process.kill = function (pid, signal) {
            if (!replaced && pid === deadPid && signal === 0 && fs.existsSync(reclaimFile)) {
                replaced = true
                fs.writeFileSync(reclaimFile,
                    JSON.stringify({ pid: process.pid, nonce: 'the-successor' }) + '\n')
            }
            return realKill.call(process, pid, signal)
        }
        let release
        try {
            release = acquireCommandLock({ command: 'update' })
        } finally {
            process.kill = realKill
        }
        assert.ok(replaced, 'the marker ownership change must occur inside reclamation')
        assert.strictEqual(JSON.parse(fs.readFileSync(reclaimFile, 'utf8')).nonce, 'the-successor')
        release()
        fs.unlinkSync(reclaimFile)
    })
})

// Replace `file` with a live owner's file on a NEW inode: the new file is created
// while the old one still exists, so the inode numbers cannot be reused.
function replaceWithLiveOwner(file, nonce) {
    const staged = file + '.test-staged'
    fs.writeFileSync(staged, JSON.stringify({ pid: process.pid, nonce, command: 'install' }) + '\n')
    fs.renameSync(staged, file)
}

// Runs fn with a hook that fires once, just before the first removal of `target`
// (an unlink by path or a rename away), the point where a preempted contender's
// earlier check has gone stale.
function withHookBeforeRemoval(target, hook, fn) {
    const realUnlink = fs.unlinkSync
    const realRename = fs.renameSync
    let fired = false
    const fire = () => {
        if (fired) return
        fired = true
        hook()
    }
    fs.unlinkSync = function (file, ...rest) {
        if (file === target) fire()
        return realUnlink.call(fs, file, ...rest)
    }
    fs.renameSync = function (from, ...rest) {
        if (from === target) fire()
        return realRename.call(fs, from, ...rest)
    }
    try {
        fn()
    } finally {
        fs.unlinkSync = realUnlink
        fs.renameSync = realRename
    }
    return fired
}

describe('commandLock reclaim removals are bound to the file they checked', () => {
    registerLockDirectoryHooks()

    it('breaking an abandoned marker never removes a live contender marker that replaced it', () => {
        const lockFile = getLockFilePath()
        const reclaimFile = lockFile + '.reclaim'
        const deadPid = findDeadPid()
        fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, nonce: 'stale-lock' }) + '\n')
        fs.writeFileSync(reclaimFile, JSON.stringify({ pid: deadPid, nonce: 'stale-marker' }) + '\n')

        let acquired = null
        const fired = withHookBeforeRemoval(reclaimFile,
            () => replaceWithLiveOwner(reclaimFile, 'live-marker'),
            () => {
                try { acquired = acquireCommandLock({ command: 'update' }) } catch (err) { acquired = err }
            })

        assert.ok(fired, 'the stale marker removal must be attempted')
        assert.ok(acquired instanceof Error, 'no acquirer may take the lock while a live marker guards reclamation')
        assert.strictEqual(JSON.parse(fs.readFileSync(reclaimFile, 'utf8')).nonce, 'live-marker')
        assert.strictEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce, 'stale-lock',
            'the stale lock stays until the live marker owner finishes')
    })

    it('reclaiming a stale lock never deletes a live lock created after the observation', () => {
        const lockFile = getLockFilePath()
        const reclaimFile = lockFile + '.reclaim'
        fs.writeFileSync(lockFile, JSON.stringify({ pid: findDeadPid(), nonce: 'stale-lock' }) + '\n')

        let acquired = null
        const fired = withHookBeforeRemoval(lockFile,
            () => replaceWithLiveOwner(lockFile, 'live-lock'),
            () => {
                try { acquired = acquireCommandLock({ command: 'update' }) } catch (err) { acquired = err }
            })

        assert.ok(fired, 'the stale lock removal must be attempted')
        assert.ok(acquired instanceof Error && acquired.code === 'ELOCKHELD',
            'the acquirer must refuse the live holder, not take the lock on top of it')
        assert.strictEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce, 'live-lock')
        assert.strictEqual(fs.existsSync(reclaimFile), false, 'the reclaim marker is released')
        assert.deepStrictEqual(fs.readdirSync(tmpDir), ['command.lock'], 'no claimed or temp file left behind')
    })
})
