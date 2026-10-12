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
            stubs.db.getModuleContainerStrict.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result.uninstalled).to.deep.equal([])
            expect(result.skipped).to.deep.equal([
                { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', reason: 'not-installed' }
            ])
            expect(stubs.uninstallModule.called).to.be.false
        })

        it('fails a module whose registry read throws instead of skipping it', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainerStrict.rejects(new Error('modules table gone'))
            const ops = loadOperations(stubs)
            const err = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder'] } }).then(() => null, e => e)
            expect(err && err.message).to.contain('modules table gone')
            expect(err.failures[0]).to.include({ module: 'xchain-encoder' })
            expect(err.failures[0].reason).to.contain('registry unreadable')
            expect(stubs.uninstallModule.called).to.be.false
        })

        it('still uninstalls the rest of the list after one registry read throws', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainerStrict.withArgs('xchain-decoder', 'bitcoin', 'mainnet').rejects(new Error('blip'))
            const ops = loadOperations(stubs)
            const err = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-decoder', 'xchain-encoder'] } })
                .then(() => null, e => e)
            expect(err).to.be.an('error')
            expect(err.uninstalled.map(u => u.module)).to.deep.equal(['xchain-encoder'])
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
            expect(dockerCmdArgs.slice(0, 2)).to.deep.equal(['sh', '-c'])
            expect(dockerCmdArgs[2]).to.include('exec npx mocha')
            expect(dockerCmdArgs[2]).to.include('initial_check.test.js')
            expect(dockerCmdArgs[2]).to.include('initialCheck.test.js')
            expect(dockerCmdArgs.slice(3)).to.deep.equal(['sh', 'test/actions/myTest.test.js'])
        })

        it('includes --grep when grep is provided with testName', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet', 'myTest', 'my grep pattern')
            const dockerCmdArgs = stubs.installModule.firstCall.args[7]
            expect(dockerCmdArgs.slice(-2)).to.deep.equal(['--grep', 'my grep pattern'])
            expect(dockerCmdArgs[2]).to.not.include('my grep pattern')
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

// filterCommandParameters leaves the hub and sync out of `all`, so a full
// teardown with --include-shared adds them itself, hub last, and never asks
// for the database, which uninstallModule refuses.
function registerFullTeardownTests() {
    const ALL_SHAPE = () => ({ '': { '': ['xchain-explorer'] }, bitcoin: { mainnet: ['xchain-encoder'] } })
    const called = (stubs) => stubs.uninstallModule.getCalls().map(c => c.args[2])

    it('removes the explorer, then sync, then the hub on an all teardown, and keeps the database', async function () {
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        const result = await ops.uninstallModules(ALL_SHAPE(), true, { all: true })
        expect(called(stubs)).to.deep.equal(['xchain-encoder', 'xchain-explorer', 'xchain-sync', 'xchain-hub'])
        const db = result.skipped.find(s => s.module === 'database')
        expect(db, 'the database must be reported as kept').to.exist
        expect(db.reason).to.contain('removed manually')
    })

    it('keeps the hub and sync on an all teardown while another chain is still installed', async function () {
        const stubs = makeStubs()
        stubs.db.getAllModuleContainers.resolves([
            { module: 'xchain-indexer', coin: 'dogecoin', network: 'mainnet', container_id: 'c1' }
        ])
        const ops = loadOperations(stubs)
        const result = await ops.uninstallModules(ALL_SHAPE(), true, { all: true })
        expect(called(stubs)).to.deep.equal(['xchain-encoder'])
        for (const m of ['xchain-hub', 'xchain-sync']) {
            const kept = result.skipped.find(s => s.module === m)
            expect(kept, `${m} must be reported as kept`).to.exist
            expect(kept.reason).to.contain('dogecoin mainnet')
        }
    })

    it('adds neither the hub nor sync without --include-shared or outside all', async function () {
        for (const [includeShared, opts] of [[false, { all: true }], [true, {}]]) {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules(ALL_SHAPE(), includeShared, opts)
            expect(called(stubs)).to.not.include('xchain-hub')
            expect(called(stubs)).to.not.include('xchain-sync')
        }
    })

    it('reaches the hub and sync from the real all expansion', async function () {
        const { filterCommandParameters } = requireFromUnit('../../src/services/config_service/filters.js')
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        await ops.uninstallModules(filterCommandParameters(null, 'all', 'bitcoin', 'mainnet'), true, { all: true })
        expect(called(stubs).slice(-3)).to.deep.equal(['xchain-explorer', 'xchain-sync', 'xchain-hub'])
        expect(called(stubs)).to.not.include('database')
    })
}

describe('moduleOperations', function () {
    registerLifecycleHooks(() => {})

    describe('uninstallModules(): all with --include-shared', function () {
        registerFullTeardownTests()
    })
})
