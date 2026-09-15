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

const { sinon, expect, makeStubs, loadOperations, registerLifecycleHooks, requireFromUnit } = require('./helpers/harness')

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // shellModule
    // -------------------------------------------------------------------

        describe('shellModule()', function () {

        it('calls shellContainer for the first module only', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.shellModule({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(stubs.shellContainer.calledOnce).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // logModules
    // -------------------------------------------------------------------

        describe('logModules()', function () {

        it('calls logContainer with follow=true by default', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.logContainer.calledOnce).to.be.true
            expect(stubs.logContainer.firstCall.args[1]).to.be.true
        })

        it('passes follow=false when specified', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, false)
            expect(stubs.logContainer.firstCall.args[1]).to.be.false
        })

        it('non-follow: dumps every selected service, not just the first', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } }, false)
            expect(stubs.logContainer.calledTwice).to.be.true
        })

        it('follow: only attaches to the first service (single-TTY limit)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } }, true)
            expect(stubs.logContainer.calledOnce).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // monitorModules
    // -------------------------------------------------------------------

        describe('monitorModules()', function () {

        it('collects container IDs and passes to startDockerMonitor', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.monitorModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(stubs.startDockerMonitor.calledOnce).to.be.true
            const containerIds = stubs.startDockerMonitor.firstCall.args[0]
            expect(containerIds).to.have.length(2)
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // shellModule: error path
    // -------------------------------------------------------------------

        describe('shellModule(): error path', function () {

        it('continues after shellContainer error and returns true', async function () {
            const stubs = makeStubs()
            stubs.shellContainer.rejects(new Error('shell failed'))
            const ops = loadOperations(stubs)
            const result = await ops.shellModule({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })

        it('returns true when no container found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.shellModule({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.shellContainer.called).to.be.false
        })
    })
})
