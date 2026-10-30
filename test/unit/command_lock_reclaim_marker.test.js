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

describe('commandLock publishes the reclaim marker atomically', () => {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-node-lock-'))
        process.env.XCHAIN_NODE_LOCK_DIR = tmpDir
    })

    afterEach(() => {
        delete process.env.XCHAIN_NODE_LOCK_DIR
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

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
