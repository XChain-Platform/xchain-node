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
//
// maybeSelfUpdateBeforeUpdate decides, from the same argument classification
// the action uses, whether an `update` targets a release, and if so which one,
// before handing off to SelfUpdateService. These cases pin the decision, not
// the move (SelfUpdateService.test.js covers that).

const sinon      = require('sinon')
const { expect } = require('chai')
const { maybeSelfUpdateBeforeUpdate } = require('../../src/cli')
const { TARGET_ENV, NO_SELF_UPDATE_ENV, explicitUpdateArgs } = require('../../src/services/SelfUpdateService')

describe('cli maybeSelfUpdateBeforeUpdate()', function () {
    let deps, selfUpdate

    beforeEach(function () {
        delete process.env[TARGET_ENV]
        delete process.env[NO_SELF_UPDATE_ENV]
        selfUpdate = {
            TARGET_ENV,
            selfUpdateDisabled: () => /^(1|true|yes)$/i.test(process.env[NO_SELF_UPDATE_ENV] || ''),
            explicitUpdateArgs,
            selfUpdateAndReexec: sinon.stub().resolves({ moved: false, reason: 'current' })
        }
        deps = {
            manifest: {
                isReleaseRef: ref => /^v\d+\.\d+\.\d+$/.test(String(ref || '')),
                resolveLatestReleaseTag: sinon.stub().resolves('v0.15.2')
            },
            installTarget: { resolveUpdateTarget: sinon.stub().resolves({ kind: 'release', ref: null, inferred: false }) },
            selfUpdate,
            acquireCommandLock: sinon.stub().returns(sinon.stub())
        }
    })

    afterEach(function () {
        delete process.env[TARGET_ENV]
        delete process.env[NO_SELF_UPDATE_ENV]
    })

    it('targets the latest release for a no-ref update on a release node', async function () {
        await maybeSelfUpdateBeforeUpdate(['all'], deps)
        expect(deps.manifest.resolveLatestReleaseTag.calledOnce).to.equal(true)
        const call = selfUpdate.selfUpdateAndReexec.firstCall.args[0]
        expect(call.tag).to.equal('v0.15.2')
        expect(call.childArgs).to.deep.equal(['update', 'all', 'all', 'all', 'v0.15.2'])
    })

    it('hands the resolved tag on when the CLI is already there, so the action does not look it up again', async function () {
        await maybeSelfUpdateBeforeUpdate([], deps)
        expect(process.env[TARGET_ENV]).to.equal('v0.15.2')
    })

    it('targets the named release and keeps the operator\'s scope in the child command', async function () {
        await maybeSelfUpdateBeforeUpdate(['xchain-hub', 'v0.15.1'], deps)
        expect(deps.manifest.resolveLatestReleaseTag.called).to.equal(false)
        const call = selfUpdate.selfUpdateAndReexec.firstCall.args[0]
        expect(call.tag).to.equal('v0.15.1')
        expect(call.childArgs).to.deep.equal(['update', 'xchain-hub', 'all', 'all', 'v0.15.1'])
    })

    it('does not move the CLI for a branch update', async function () {
        const out = await maybeSelfUpdateBeforeUpdate(['all', 'develop'], deps)
        expect(out.reason).to.equal('branch-update')
        expect(selfUpdate.selfUpdateAndReexec.called).to.equal(false)
    })

    it('does not move the CLI on a branch node', async function () {
        deps.installTarget.resolveUpdateTarget.resolves({ kind: 'branch', ref: 'develop' })
        const out = await maybeSelfUpdateBeforeUpdate(['all'], deps)
        expect(out.reason).to.equal('branch-node')
        expect(deps.manifest.resolveLatestReleaseTag.called).to.equal(false)
    })

    it('does nothing inside the re-executed child', async function () {
        process.env[TARGET_ENV] = 'v0.15.2'
        const out = await maybeSelfUpdateBeforeUpdate(['all'], deps)
        expect(out.reason).to.equal('already-reexecuted')
        expect(deps.acquireCommandLock.called).to.equal(false)
    })

    it('does nothing when self-update is switched off', async function () {
        process.env[NO_SELF_UPDATE_ENV] = '1'
        const out = await maybeSelfUpdateBeforeUpdate(['all'], deps)
        expect(out.reason).to.equal('disabled')
        expect(selfUpdate.selfUpdateAndReexec.called).to.equal(false)
    })

    it('leaves an unparseable invocation for the action to report', async function () {
        const out = await maybeSelfUpdateBeforeUpdate(['xchain-node'], deps)
        expect(out.reason).to.equal('unparsed-args')
        expect(selfUpdate.selfUpdateAndReexec.called).to.equal(false)
    })

    it('serializes on the command lock and hands it to the move as the pre-spawn release', async function () {
        const release = sinon.stub()
        deps.acquireCommandLock.returns(release)
        await maybeSelfUpdateBeforeUpdate(['all'], deps)
        expect(deps.acquireCommandLock.calledOnce).to.equal(true)
        expect(selfUpdate.selfUpdateAndReexec.firstCall.args[0].deps.beforeSpawn).to.equal(release)
        expect(release.called, 'released after a no-move outcome too').to.equal(true)
    })

    it('lets a lookup failure propagate as the update failure', async function () {
        deps.manifest.resolveLatestReleaseTag.rejects(new Error('rate limited'))
        let err = null
        try { await maybeSelfUpdateBeforeUpdate(['all'], deps) } catch (e) { err = e }
        expect(err.message).to.match(/rate limited/)
    })
})
