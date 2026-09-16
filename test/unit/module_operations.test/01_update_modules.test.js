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
    // updateModules
    // -------------------------------------------------------------------


describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules()', function () {

        // A gated migration the target DB never applied is a startup
        // crash-loop. The refusal is worth nothing unless it lands BEFORE
        // the working container is torn down.
        it('checks the migration precondition BEFORE the container is rebuilt', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-indexer'] } })
            expect(stubs.assertRequiredMigrationsApplied.calledBefore(stubs.installModule)).to.be.true
            expect(stubs.assertRequiredMigrationsApplied.calledWith('xchain-indexer', 'bitcoin', 'mainnet')).to.be.true
        })

        it('aborts the update, leaving the running container untouched, when the guard refuses', async function () {
            const stubs = makeStubs()
            stubs.assertRequiredMigrationsApplied.rejects(
                new Error('update refused: 2026-07-24-pubkeys-widen-uncompressed.sql has not been applied'))
            const ops = loadOperations(stubs)
            let err = null
            try {
                await ops.updateModules({ bitcoin: { mainnet: ['xchain-indexer'] } })
            } catch (e) { err = e }
            expect(err, 'the refusal must propagate out of updateModules').to.not.equal(null)
            expect(err.message).to.contain('2026-07-24-pubkeys-widen-uncompressed.sql')
            expect(stubs.installModule.called, 'nothing may be rebuilt after a refusal').to.be.false
        })

        it('fetches existing container ID before updating', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.db.getModuleContainer.calledWith('xchain-encoder', 'bitcoin', 'mainnet')).to.be.true
        })

        it('rebuilds non-node modules via installModule (which re-clones internally)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.installModule.calledWith('xchain-encoder', 'bitcoin', 'mainnet', true)).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules()', function () {

        it('handles the node module via installModule (built from releases, not git-cloned)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.be.true
        })

        // installModule returns false when it decided not to rebuild. The loop must
        // not push every module onto `updated` regardless of that return value: a run
        // that rebuilds nothing must not report a landed deploy while the CLI exits 0.
        it('records a module installModule declined as a no-op, not as updated', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves(false)
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            let result
            try {
                result = await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            } finally { warn.restore() }
            expect(result.updated).to.deep.equal([])
            expect(result.skipped).to.deep.equal([
                { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', reason: 'no-op' }
            ])
        })

        it('records a declined NODE rebuild as a no-op too', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves(false)
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            let result
            try {
                result = await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            } finally { warn.restore() }
            expect(result.updated).to.deep.equal([])
            expect(result.skipped.map(s => s.reason)).to.deep.equal(['no-op'])
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules()', function () {

        it('passes container ID to installModule for replacement', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            const installCall = stubs.installModule.firstCall
            expect(installCall.args[4]).to.equal('container-id-123') // overwriteContainerId
        })

        it('rebuilds the image, unlike recreate', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.buildAndUp.called).to.be.false
        })

        it('leaves the running node container to buildCryptoNode instead of force-removing it up front', async function () {
            // Regression: an up-front `docker rm -f` is SIGKILL, so the daemon
            // restarted at its last flushed block index (16 regtest blocks lost,
            // 2026-09-03). buildCryptoNode stops it gracefully and removes the
            // stopped carcass itself, right before its `docker run`.
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            expect(stubs.forceRemoveContainerByName.called).to.be.false
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true, null)).to.be.true
        })

        it('recreates the node even when its container is missing (no silent no-op)', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null) // node container crashed/removed
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true, null)).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules()', function () {

        it('still skips a NON-node module whose container is missing', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            try {
                await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            } finally { warn.restore() }
            expect(stubs.installModule.called).to.be.false
        })

        // A run that changed nothing must be distinguishable from a run that
        // rebuilt containers: the caller turns an empty `updated` list into a
        // non-zero exit, which is the whole defence against a silent no-op
        // redeploy reading as success.
        it('reports what it updated so a no-op run is not indistinguishable from success', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const outcome = await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(outcome.updated).to.deep.equal([{ module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet' }])
            expect(outcome.skipped).to.deep.equal([])
        })

        it('reports an uninstalled module as SKIPPED (empty updated list), and warns about it', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            let outcome
            try {
                outcome = await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            } finally { warn.restore() }
            expect(outcome.updated).to.deep.equal([])
            expect(outcome.skipped).to.deep.equal([
                { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', reason: 'not-installed' }
            ])
            expect(warn.calledWithMatch(/no registered container/)).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules()', function () {

        it('counts a rebuilt node as updated', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const outcome = await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            expect(outcome.updated).to.deep.equal([{ module: 'node', coin: 'bitcoin', network: 'mainnet' }])
        })

        // The database container is built from a pinned image, not from module
        // source, and its existing-container path changes nothing. Counting it as
        // updated is how `update database` exited 0 over an untouched container.
        it('refuses the database instead of reporting an untouched container as updated', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            let outcome
            try {
                outcome = await ops.updateModules({ '': { '': ['database'] } })
            } finally { warn.restore() }
            expect(outcome.updated).to.deep.equal([])
            expect(outcome.skipped).to.deep.equal([
                { module: 'database', coin: '', network: '', reason: 'not-updatable' }
            ])
            // Refused BEFORE any rebuild machinery runs, so nothing is torn down.
            expect(stubs.installModule.called).to.be.false
            expect(stubs.db.getModuleContainer.called).to.be.false
            expect(warn.calledWithMatch(/removed manually and reinstalled/)).to.be.true
        })

        it('still updates the other requested modules when the request also names the database', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            let outcome
            try {
                outcome = await ops.updateModules({ bitcoin: { mainnet: ['database', 'xchain-encoder'] } })
            } finally { warn.restore() }
            expect(outcome.updated).to.deep.equal([{ module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet' }])
            expect(outcome.skipped.map(s => s.module)).to.deep.equal(['database'])
        })
    })
})
