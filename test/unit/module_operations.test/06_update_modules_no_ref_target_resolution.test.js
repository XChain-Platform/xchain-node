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
    // updateModules: what a no-ref update means (release node vs branch node)
    // -------------------------------------------------------------------


describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules(): no-ref target resolution', function () {

        // The documented upgrade is `xchain-node update all`. A release-installed
        // node is a detached checkout, so the old "same branch, newer commits"
        // reading answered HEAD and failed. Measured on the v0.15.2 fleet roll.
        it('moves a RELEASE node to the latest release, pinned, refusing any branch fallback', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(resolveInstallTargetStub.calledOnce).to.be.true
            const [ref, opts] = resolveInstallTargetStub.firstCall.args
            expect(ref).to.equal(null)
            expect(opts.fallbackToBranch).to.equal(false)
            expect(stubs.installModule.calledWith('xchain-encoder', 'bitcoin', 'mainnet', true)).to.be.true
        })

        it('records what the node is on, so the next no-ref update converges on it', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'v0.11.0')
            // Under a release update the record is written by withInstallTarget
            // from the resolved target.
            expect(recordInstallTargetStub.calledOnce).to.be.true
            expect(recordInstallTargetStub.firstCall.args[0].kind).to.equal('release')
        })

        it('keeps a BRANCH node on its branch and takes newer commits', async function () {
            const stubs = makeStubs()
            resolveUpdateTargetStub.resolves({ kind: 'branch', ref: 'develop', tag: null, inferred: false })
            const ops = loadOperations(stubs)
            const log = sinon.stub(console, 'log')
            try {
                await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            } finally { log.restore() }
            expect(resolveInstallTargetStub.called, 'a branch node must not resolve a release').to.be.false
            expect(stubs.installModule.calledWith(
                'xchain-encoder', 'bitcoin', 'mainnet', true, 'container-id-123', false, 'develop'
            )).to.be.true
            expect(recordInstallTargetStub.calledWith(sinon.match({ kind: 'branch', ref: 'develop' }))).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules(): no-ref target resolution', function () {

        it('treats an explicitly named branch as a decision and records it', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'feature/x')
            expect(resolveInstallTargetStub.called).to.be.false
            expect(recordInstallTargetStub.calledWith(sinon.match({ kind: 'branch', ref: 'feature/x' }))).to.be.true
        })

        it('stops with nothing changed when the latest release cannot be resolved', async function () {
            const stubs = makeStubs()
            resolveInstallTargetStub.rejects(new Error('Could not resolve the latest xchain-node release (ENOTFOUND). Nothing was changed.'))
            const ops = loadOperations(stubs)
            let err = null
            try { await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }) } catch (e) { err = e }
            expect(err).to.not.equal(null)
            expect(err.message).to.match(/Nothing was changed/)
            expect(stubs.installModule.called).to.be.false
        })

        // The re-executed child of a CLI self-update is handed the tag its parent
        // resolved and verified; resolving it again would be a second API call
        // and a second chance to disagree.
        it('uses the tag a self-update already resolved instead of looking it up again', async function () {
            const stubs = makeStubs()
            process.env.XCHAIN_NODE_UPDATE_TARGET = 'v0.11.0'
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(resolveUpdateTargetStub.called, 'the record is not consulted when the target is known').to.be.false
            expect(resolveInstallTargetStub.firstCall.args[0]).to.equal('v0.11.0')
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('updateModules(): no-ref target resolution', function () {

        it('clones the default branch, never "HEAD", for a detached module the manifest does not carry', async function () {
            const stubs = makeStubs()
            stubs.getModuleBranch.resolves('HEAD')
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.installModule.calledWith(
                'xchain-encoder', 'bitcoin', 'mainnet', true, 'container-id-123', false, null
            )).to.be.true
        })
    })
})
