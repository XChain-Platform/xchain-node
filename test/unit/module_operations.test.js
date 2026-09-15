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

const { sinon, expect, makeStubs, loadOperations, registerLifecycleHooks, requireFromUnit } = require('./module_operations.test/helpers/harness')



    // -------------------------------------------------------------------
    // installModules
    // -------------------------------------------------------------------


describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('installModules()', function () {

        it('creates Docker network for each coin/network pair', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { bitcoin: { mainnet: ['xchain-encoder'] } }
            await ops.installModules(servicesList)
            expect(stubs.createDockerNetwork.calledOnce).to.be.true
        })

        it('builds database before installing modules', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { bitcoin: { mainnet: ['xchain-encoder'] } }
            await ops.installModules(servicesList)
            expect(stubs.buildDatabaseModule.calledBefore(stubs.installModule)).to.be.true
        })

        it('calls installModule for each module in the list', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } }
            await ops.installModules(servicesList)
            expect(stubs.installModule.callCount).to.equal(2)
        })

        it('handles multiple coins and networks', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = {
                bitcoin: { mainnet: ['xchain-encoder'], testnet: ['xchain-encoder'] },
                dogecoin: { mainnet: ['xchain-encoder'] }
            }
            await ops.installModules(servicesList)
            expect(stubs.installModule.callCount).to.equal(3)
            expect(stubs.createDockerNetwork.callCount).to.equal(3)
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('installModules()', function () {

        it('skips network creation and database for shared services (empty coin/network)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { '': { '': ['xchain-explorer'] } }
            await ops.installModules(servicesList)
            expect(stubs.createDockerNetwork.called).to.be.false
            expect(stubs.buildDatabaseModule.called).to.be.false
            expect(stubs.installModule.calledOnce).to.be.true
        })

        it('reports what it installed on success', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.installModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result.installed).to.deep.equal([{ module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet' }])
            expect(result.skipped).to.deep.equal([])
        })

        // installModule returns false for a module it declined to touch. Counting
        // that as installed is how "built nothing" and "built the stack" printed
        // the same. A no-op install is still not a failure (install is idempotent).
        it('reports a module installModule declined as skipped, not installed', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves(false)
            const ops = loadOperations(stubs)
            const result = await ops.installModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result.installed).to.deep.equal([])
            expect(result.skipped).to.deep.equal([
                { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', reason: 'already-installed' }
            ])
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('installModules()', function () {

        // A failed install is exactly where the summary earns its place: it
        // leaves some services restored and some facing days of resync, and
        // the error alone does not say which.
        it('reports the bootstrap outcomes even when the install throws', async function () {
            const stubs = makeStubs()
            stubs.installModule.rejects(new Error("Couldn't download the bitcoin node"))
            const ops = loadOperations(stubs)

            let threw = null
            try {
                await ops.installModules({ bitcoin: { mainnet: ['node'] } })
            } catch (err) { threw = err }

            expect(threw).to.be.an('error')
            expect(stubs.bootstrapService.reportBootstrapOutcomes.calledOnce).to.be.true
            // The failure still surfaces: the summary is added to it, not
            // substituted for it.
            expect(threw.message).to.contain("Couldn't download the bitcoin node")
        })

        it('still reports the bootstrap outcomes on a clean install', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.installModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.bootstrapService.resetBootstrapOutcomes.calledOnce).to.be.true
            expect(stubs.bootstrapService.reportBootstrapOutcomes.calledOnce).to.be.true
        })
    })
})
