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

const { expect, makeStubs, loadModuleService, moduleSuite } = require('../support/helpers')

moduleSuite('cloneGit() branch handling', function () {
    it('rejects on invalid branch name', async function () {
        const stubs = makeStubs()
        const ms = loadModuleService(stubs)
        try {
            await ms.cloneGit('xchain-encoder', false, false, 'bad branch!')
            expect.fail()
        } catch (err) {
            expect(err).to.include('Invalid branch name')
        }
    })

    it('clones with -b flag when a valid branch is specified', async function () {
        const stubs = makeStubs()
        let cloneArgs = null
        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            // Track the clone call before the identity reads that follow it.
            if (args[0] === 'clone') cloneArgs = args
            cb(null)
        })
        const ms = loadModuleService(stubs)
        await ms.cloneGit('xchain-encoder', false, false, 'feature/test')
        expect(cloneArgs).to.include('-b')
        expect(cloneArgs).to.include('feature/test')
    })

    it('rejects (no silent fallback) when the requested branch is not found', async function () {
        const stubs = makeStubs()
        let callCount = 0
        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            callCount++
            cb(new Error('git error'), '', 'remote: branch not found on server')
        })
        const ms = loadModuleService(stubs)
        try {
            await ms.cloneGit('xchain-encoder', false, false, 'missing-branch')
            expect.fail()
        } catch (err) {
            expect(err).to.include("branch 'missing-branch' not found")
            expect(callCount).to.equal(1)
        }
    })
})
