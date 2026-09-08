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
// installHubModule runs from preCheck, ahead of the action that publishes the
// install target, so on a fresh box the hub was staged from the raw ref: a
// no-ref install cloned master unpinned, and `install v0.15.1 xchain-hub`
// failed outright because the hub repo has no v0.15.1 tag (that train pinned
// hub v0.15.0). Measured in a sandbox 2026-09-08. These cases pin the fix: the
// hub resolves its ref through the release manifest like every other module.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const PIN_SHA = 'c'.repeat(40)

function load(stubs) {
    const manifest = require('../../src/services/ReleaseManifestService')
    return proxyquire('../../src/services/HubService', {
        '../state': {
            db: { getModuleContainer: sinon.stub().resolves(null) },
            getLastStatus: () => ({}),
            isStatusUpdated: () => false,
            isVerbose: () => false
        },
        '../utils/helpers': { sleep: async () => {}, redactSecrets: e => e },
        './ConfigService': {
            getDefaultConfig: async () => ({ HUB_PORT: 10000, HUB_DB_NAME: 'h', HUB_DB_USER: 'u', HUB_DB_PASS: 'p' }),
            getDockerContainerImageName: () => 'xchain-node-xchain-hub',
            getDockerNetwork: () => 'xchain-node'
        },
        './StatusService': { statusChanged: async () => {}, getStatus: async () => {}, getInstalledCoinsAndNetworks: async () => ({}) },
        './DockerService': { addContainerToNetwork: async () => true },
        './ModuleService': { cloneGit: stubs.cloneGit, buildAndUp: async () => 'id' },
        './DatabaseService': { addUserPasswordToDatabase: async () => {}, getExternalDbConfig: async () => ({}) },
        './DbCredentialDrift': { readContainerEnv: async () => ({}), assertNoHubDbCredentialDrift: async () => {} },
        '../HubConnector.js': class { async ping() { return false } },
        // The real manifest service, so setActiveTarget/resolveComponentRef are
        // the code under test; only the network lookup is stubbed.
        './ReleaseManifestService': manifest
    })
}

describe('installHubModule() stages the hub from the release manifest', function () {
    let manifest, resolveInstallTarget, cloneGit

    beforeEach(function () {
        manifest = require('../../src/services/ReleaseManifestService')
        manifest.clearActiveTarget()
        resolveInstallTarget = sinon.stub(manifest, 'resolveInstallTarget').resolves({
            kind: 'release', ref: 'v0.15.1', tag: 'v0.15.1', resolvedFrom: 'operator-supplied release ref',
            manifest: { platform_version: '0.15.1', components: { 'xchain-hub': { tag: 'v0.15.0', commit: PIN_SHA } } }
        })
        // Stop the install right after the clone: everything after it is docker.
        cloneGit = sinon.stub().rejects(new Error('stop-after-clone'))
        sinon.stub(console, 'log')
    })

    afterEach(function () {
        manifest.clearActiveTarget()
        sinon.restore()
    })

    async function runInstall(svc, ref) {
        try { await svc.installHubModule(ref) } catch (err) { if (err.message !== 'stop-after-clone') throw err }
    }

    it('pins the hub to the manifest of a named release, not to a hub tag of that name', async function () {
        const svc = load({ cloneGit })
        await runInstall(svc, 'v0.15.1')
        expect(resolveInstallTarget.calledWith('v0.15.1')).to.equal(true)
        expect(cloneGit.calledOnce).to.equal(true)
        expect(cloneGit.firstCall.args.slice(3)).to.deep.equal(['v0.15.0', PIN_SHA])
    })

    it('resolves the latest release for a no-ref install, pinned, instead of cloning master', async function () {
        resolveInstallTarget.resolves({
            kind: 'release', ref: 'v0.15.2', tag: 'v0.15.2', resolvedFrom: 'latest published release',
            manifest: { platform_version: '0.15.2', components: { 'xchain-hub': { tag: 'v0.15.2', commit: PIN_SHA } } }
        })
        const svc = load({ cloneGit })
        await runInstall(svc, null)
        expect(resolveInstallTarget.calledWith(null)).to.equal(true)
        expect(cloneGit.firstCall.args.slice(3)).to.deep.equal(['v0.15.2', PIN_SHA])
    })

    it('clones a named branch as a branch, without a release lookup', async function () {
        const svc = load({ cloneGit })
        await runInstall(svc, 'develop')
        expect(resolveInstallTarget.called).to.equal(false)
        expect(cloneGit.firstCall.args.slice(3)).to.deep.equal(['develop', null])
    })

    it('falls back to the branch the lookup names when no release exists', async function () {
        resolveInstallTarget.resolves({ kind: 'branch', ref: 'master', tag: null, manifest: null, resolvedFrom: 'no published release' })
        const svc = load({ cloneGit })
        await runInstall(svc, null)
        expect(cloneGit.firstCall.args.slice(3)).to.deep.equal(['master', null])
    })

    it('clears the target it published, on the failure path too', async function () {
        const svc = load({ cloneGit })
        await runInstall(svc, 'v0.15.1')
        expect(manifest.getActiveTarget()).to.equal(null)
    })

    it('leaves an already-published target alone', async function () {
        manifest.setActiveTarget({
            kind: 'release', ref: 'v0.15.0', tag: 'v0.15.0',
            manifest: { platform_version: '0.15.0', components: { 'xchain-hub': { tag: 'v0.15.0', commit: 'd'.repeat(40) } } }
        })
        const svc = load({ cloneGit })
        await runInstall(svc, 'v0.15.1')
        expect(resolveInstallTarget.called).to.equal(false)
        expect(cloneGit.firstCall.args.slice(3)).to.deep.equal(['v0.15.0', 'd'.repeat(40)])
        expect(manifest.getActiveTarget().tag).to.equal('v0.15.0')
    })
})
