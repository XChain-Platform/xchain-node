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



    // -------------------------------------------------------------------
    // uninstallModules: includeShared=true
    // -------------------------------------------------------------------


describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('uninstallModules(): includeShared', function () {

        it('skips shared modules by default', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['database', 'xchain-encoder'] } })
            // database is in sharedModules → skipped
            // xchain-encoder is uninstalled
            expect(stubs.uninstallModule.callCount).to.equal(1)
            expect(stubs.uninstallModule.firstCall.args[2]).to.equal('xchain-encoder')
        })

        it('includes shared modules when includeShared=true', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['database', 'xchain-encoder'] } }, true)
            expect(stubs.uninstallModule.callCount).to.equal(2)
        })

        it('skips xchain-sync by default (shared singleton, same guard as database/hub/explorer)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-sync', 'xchain-encoder'] } })
            // xchain-sync is shared -> skipped; only xchain-encoder is uninstalled
            expect(stubs.uninstallModule.callCount).to.equal(1)
            expect(stubs.uninstallModule.firstCall.args[2]).to.equal('xchain-encoder')
        })

        it('includes xchain-sync when includeShared=true', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-sync', 'xchain-encoder'] } }, true)
            expect(stubs.uninstallModule.callCount).to.equal(2)
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('uninstallModules(): includeShared', function () {

        // A shared service (explorer/hub/database/sync) is installed once and serves
        // every coin/network on the box. `--include-shared` asked for it to come down
        // with the coin being removed, which took the explorer away from every OTHER
        // coin still installed.
        it('keeps a shared module when another coin/network is still installed', async function () {
            const stubs = makeStubs()
            stubs.db.getAllModuleContainers.resolves([
                { module: 'xchain-indexer', coin: 'dogecoin', network: 'mainnet', container_id: 'c1' },
                { module: 'xchain-explorer', coin: '', network: '', container_id: 'c2' }
            ])
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-explorer', 'xchain-encoder'] } }, true)

            expect(stubs.uninstallModule.callCount).to.equal(1)
            expect(stubs.uninstallModule.firstCall.args[2]).to.equal('xchain-encoder')
            const kept = result.skipped.find(s => s.module === 'xchain-explorer')
            expect(kept, 'the explorer must be reported as kept, not silently dropped').to.exist
            expect(kept.reason).to.contain('dogecoin mainnet')
        })

        it('still removes shared modules once the last coin/network is gone', async function () {
            const stubs = makeStubs()
            // Only the shared services themselves remain registered (coin '').
            stubs.db.getAllModuleContainers.resolves([
                { module: 'xchain-explorer', coin: '', network: '', container_id: 'c2' }
            ])
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-explorer', 'xchain-encoder'] } }, true)
            expect(stubs.uninstallModule.callCount).to.equal(2)
        })

        it('orders the shared pass LAST, so a full teardown still reaches it', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-explorer', 'xchain-encoder'] } }, true)
            expect(stubs.uninstallModule.callCount).to.equal(2)
            expect(stubs.uninstallModule.firstCall.args[2]).to.equal('xchain-encoder')
            expect(stubs.uninstallModule.secondCall.args[2]).to.equal('xchain-explorer')
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('uninstallModules(): includeShared', function () {

        it('refuses the shared removal rather than guessing when the registry is unreadable', async function () {
            const stubs = makeStubs()
            stubs.db.getAllModuleContainers.rejects(new Error('modules table gone'))
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-explorer'] } }, true)
            expect(stubs.uninstallModule.callCount).to.equal(0)
            expect(result.skipped[0].reason).to.contain('modules table gone')
        })

        it('skips module when container ID is null', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result.uninstalled).to.deep.equal([])
            expect(result.skipped).to.deep.equal([
                { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', reason: 'not-installed' }
            ])
            expect(stubs.uninstallModule.called).to.be.false
        })
    })
})



    // -------------------------------------------------------------------
    // runE2ETest
    // -------------------------------------------------------------------


describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('runE2ETest()', function () {

        it('installs e2e module, waits, saves logs, removes container', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            stubs.waitContainer.resolves(0)
            const ops = loadOperations(stubs)
            const result = await ops.runE2ETest('bitcoin', 'mainnet')
            expect(stubs.installModule.calledOnce).to.be.true
            expect(stubs.waitContainer.calledWith('e2e-container-id')).to.be.true
            expect(stubs.saveContainerLogs.calledWith('e2e-container-id')).to.be.true
            expect(stubs.removeContainer.calledWith('e2e-container-id')).to.be.true
            expect(result.exitCode).to.equal(0)
            expect(result.logFile).to.be.a('string')
        })

        it('builds mocha docker args when testName is provided', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet', 'myTest', null)
            const installArgs = stubs.installModule.firstCall.args
            const dockerCmdArgs = installArgs[7]
            expect(dockerCmdArgs).to.include('mocha')
            expect(dockerCmdArgs.some(a => a.includes('myTest'))).to.be.true
        })

        it('includes --grep when grep is provided with testName', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet', 'myTest', 'my grep pattern')
            const dockerCmdArgs = stubs.installModule.firstCall.args[7]
            expect(dockerCmdArgs).to.include('--grep')
            expect(dockerCmdArgs).to.include('my grep pattern')
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('runE2ETest()', function () {

        it('uses npm run script when script is provided', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet', null, null, 'test:sdk')
            const dockerCmdArgs = stubs.installModule.firstCall.args[7]
            expect(dockerCmdArgs).to.deep.equal(['npm', 'run', 'test:sdk'])
        })

        it('passes null dockerCmdArgs when no testName or script', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet')
            const dockerCmdArgs = stubs.installModule.firstCall.args[7]
            expect(dockerCmdArgs).to.be.null
        })

        // The suite is code and is cloned like any other module, so it took
        // xchain-e2e-test's default branch regardless of the ref the stack under
        // it was installed at. On the ceremony's freeze gate that is master's
        // suites grading a release stack: a suite corrected on the release branch
        // never runs, and one deleted there runs anyway.
        it('clones the suite at the ref it was given', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'regtest', null, null, 'test:security', 'release/v0.10.0')
            expect(stubs.installModule.firstCall.args[6]).to.equal('release/v0.10.0')
        })

        it('passes null when no ref was given, keeping the default-branch behaviour', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'regtest')
            expect(stubs.installModule.firstCall.args[6]).to.equal(null)
        })
    })
})
