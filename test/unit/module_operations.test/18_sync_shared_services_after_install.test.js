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



// A coin installed by THIS run is unknown to the hub and explorer until something
// tells them, and the thing that does (preCheck) fires BEFORE the action. Left
// unsynced, the explorer sits on no network from which the hub is reachable,
// populates no DB pool, and answers 503 to everything: measured on a clean host it
// stayed degraded through a full 150-second readiness wait, which is what ruled out
// the poll-interval race this was first mistaken for.
//
// It lives beside installModules rather than inside it because it reconciles
// against LIVE docker, and installModules is driven directly by suites whose
// container registry is fixture data that such a reconcile purges.


    const coinInstalled = { installed: [{ module: 'xchain-indexer', coin: 'bitcoin', network: 'regtest' }], skipped: [] }
    const sharedOnly    = { installed: [{ module: 'xchain-explorer', coin: '', network: '' }], skipped: [] }

describe('moduleOperations: syncSharedServicesAfterInstall()', function () {

    it('pushes hub config, attaches the explorer, then waits for it to serve', async function () {
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        await ops.syncSharedServicesAfterInstall(coinInstalled)
        expect(stubs.updateHub.calledOnce).to.be.true
        expect(stubs.updateExplorer.calledOnce).to.be.true
        expect(stubs.updateExplorer.calledBefore(stubs.waitForExplorerReady)).to.be.true
    })

    it('does nothing when the run installed no coin stack', async function () {
        // A shared-only install has no new network to join and nothing to serve.
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        await ops.syncSharedServicesAfterInstall(sharedOnly)
        expect(stubs.updateHub.called).to.be.false
        expect(stubs.waitForExplorerReady.called).to.be.false
    })

    it('tolerates a missing outcome rather than throwing at the end of an install', async function () {
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        await ops.syncSharedServicesAfterInstall(undefined)
        expect(stubs.updateHub.called).to.be.false
    })

    it('still waits when the hub push fails, and never fails the command', async function () {
        const stubs = makeStubs()
        stubs.updateHub = sinon.stub().rejects(new Error('hub unreachable'))
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')
        try {
            await ops.syncSharedServicesAfterInstall(coinInstalled)
        } finally {
            warn.restore()
        }
        expect(stubs.waitForExplorerReady.calledOnce).to.be.true
    })

    it('warns, without throwing, when the explorer never converges', async function () {
        const stubs = makeStubs()
        stubs.waitForExplorerReady = sinon.stub().resolves(false)
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')
        try {
            await ops.syncSharedServicesAfterInstall(coinInstalled)
        } finally {
            warn.restore()
        }
        expect(warn.args.some(a => /not serving coin data/.test(String(a[0])))).to.be.true
    })
})


describe('moduleOperations: syncSharedServicesAfterInstall()', function () {

    it('reports the stack usable when the explorer converges', async function () {
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        expect(await ops.syncSharedServicesAfterInstall(coinInstalled)).to.be.true
    })

    it('reports the stack UNUSABLE when the explorer never converges', async function () {
        // The caller exits non-zero on this, so a gate stops at the boot step
        // instead of at its first read of a 503 explorer.
        const stubs = makeStubs()
        stubs.waitForExplorerReady = sinon.stub().resolves(false)
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')
        try {
            expect(await ops.syncSharedServicesAfterInstall(coinInstalled)).to.be.false
        } finally {
            warn.restore()
        }
    })

    it('honours XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER for install-then-fix flows', async function () {
        const stubs = makeStubs()
        stubs.waitForExplorerReady = sinon.stub().resolves(false)
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')
        const prior = process.env.XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER
        process.env.XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER = '1'
        try {
            expect(await ops.syncSharedServicesAfterInstall(coinInstalled)).to.be.true
        } finally {
            warn.restore()
            if (prior === undefined) delete process.env.XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER
            else process.env.XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER = prior
        }
    })

    it('reports usable when the run installed no coin stack', async function () {
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        expect(await ops.syncSharedServicesAfterInstall(sharedOnly)).to.be.true
    })
})
