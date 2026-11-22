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

const assert       = require('assert')
const childProcess = require('child_process')
const crypto       = require('crypto')
const fs           = require('fs')
const os           = require('os')
const path         = require('path')

const { acquireCommandLock, isPidAlive } = require('../../src/utils/command_lock')

let tmpDir

// A pid that certainly belonged to a process and is certainly gone: spawnSync
// waits for the child and reaps it before returning.
function reapedChildPid() {
    const { pid } = childProcess.spawnSync(process.execPath, ['-e', '0'])
    assert.ok(Number.isInteger(pid) && !isPidAlive(pid), 'reaped child pid must be dead')
    return pid
}

function seedTemp(name, ageSeconds = 3600) {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, JSON.stringify({ pid: 1, nonce: 'x' }) + '\n', { mode: 0o600 })
    const then = new Date(Date.now() - ageSeconds * 1000)
    fs.utimesSync(file, then, then)
    return name
}

function nonce() {
    return crypto.randomBytes(16).toString('hex')
}

function registerLockDirectoryHooks() {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-lock-sweep-'))
        process.env.XCHAIN_NODE_LOCK_DIR = tmpDir
    })

    afterEach(() => {
        delete process.env.XCHAIN_NODE_LOCK_DIR
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })
}

describe('commandLock sweeps publish temp files orphaned by a crash', () => {
    registerLockDirectoryHooks()

    // A process killed between writing its temp file and unlinking it leaves the
    // file for good; such files must not pile up across acquires.
    it('removes lock and reclaim-marker temp files whose pid is dead', () => {
        const deadA = reapedChildPid()
        const deadB = reapedChildPid()
        seedTemp(`command.lock.${deadA}.${nonce()}.tmp`)
        seedTemp(`command.lock.${deadB}.${nonce()}.tmp`)
        seedTemp(`command.lock.reclaim.${deadA}.${nonce()}.tmp`)

        const release = acquireCommandLock({ command: 'install' })
        assert.deepStrictEqual(fs.readdirSync(tmpDir), ['command.lock'],
            'only the held lock remains after acquire')
        release()
        assert.deepStrictEqual(fs.readdirSync(tmpDir), [], 'directory is empty after release')
    })

    it('keeps temp files that belong to a live pid, so an in-flight publisher is not broken', () => {
        const ownFresh = seedTemp(`command.lock.${process.pid}.${nonce()}.tmp`, 0)
        const parentLive = seedTemp(`command.lock.${process.ppid}.${nonce()}.tmp`, 0)
        const reclaimLive = seedTemp(`command.lock.reclaim.${process.ppid}.${nonce()}.tmp`)
        const dead = seedTemp(`command.lock.${reapedChildPid()}.${nonce()}.tmp`)

        const release = acquireCommandLock({ command: 'install' })
        const left = fs.readdirSync(tmpDir).sort()
        assert.deepStrictEqual(left, ['command.lock', ownFresh, parentLive, reclaimLive].sort())
        assert.ok(!left.includes(dead))
        release()
    })
})

describe('commandLock temp sweep stays inside its own name pattern', () => {
    registerLockDirectoryHooks()

    it('touches only names matching the publish temp pattern', () => {
        const deadPid = reapedChildPid()
        const unrelated = [
            'command.lock.reclaim',
            `command.lock.${deadPid}.tmp`,
            `command.lock.${deadPid}.${nonce()}.tmp.bak`,
            `other.lock.${deadPid}.${nonce()}.tmp`,
            `command.lockx.${deadPid}.${nonce()}.tmp`,
            'credentials.json',
        ]
        for (const name of unrelated) seedTemp(name)
        // A live contender's reclaim marker is never the sweep's to remove.
        fs.writeFileSync(path.join(tmpDir, 'command.lock.reclaim'),
            JSON.stringify({ pid: process.ppid, nonce: 'live' }) + '\n')
        seedTemp(`command.lock.${deadPid}.${nonce()}.tmp`)

        const release = acquireCommandLock({ command: 'install' })
        assert.deepStrictEqual(fs.readdirSync(tmpDir).sort(), ['command.lock', ...unrelated].sort())
        release()
        assert.deepStrictEqual(fs.readdirSync(tmpDir).sort(), [...unrelated].sort())
    })
})
