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

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const PIN_SHA   = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)

function makeStubs() {
    return {
        axiosGet: sinon.stub(),
        readFileSync: sinon.stub().throws(new Error('ENOENT')),
        // Stub cryptographic verification so these cases isolate manifest
        // resolution while still asserting the verification call.
        verifyManifestForTag: sinon.stub().resolves({ verified: true, fingerprint: 'F'.repeat(40) })
    }
}

function load(stubs) {
    return proxyquire('../../../src/services/release_manifest_service', {
        'fs':    { readFileSync: stubs.readFileSync },
        'axios': { get: stubs.axiosGet },
        './github_downloader': {
            githubApiHeaders:     () => ({}),
            githubRateLimitError: () => null
        },
        './release_signature_service': {
            verifyManifestForTag: stubs.verifyManifestForTag
        }
    })
}

function manifest(components = {}) {
    return { platform_version: '0.9.0', released: '2026-08-20', components }
}

function contentsResponse(obj) {
    return { data: { encoding: 'base64', content: Buffer.from(JSON.stringify(obj)).toString('base64') } }
}

let stubs, svc

function serviceSuite(title, tests) {
    describe('ReleaseManifestService', () => {
        beforeEach(() => {
            stubs = makeStubs()
            svc   = load(stubs)
        })
        afterEach(() => {
            svc.clearActiveTarget()
            sinon.restore()
        })
        describe(title, tests)
    })
}

serviceSuite('resolveInstallTarget()', () => {
    it('classifies a branch ref without touching the network', async () => {
        const t = await svc.resolveInstallTarget('develop')
        expect(t.kind).to.equal('branch')
        expect(t.ref).to.equal('develop')
        expect(t.manifest).to.equal(null)
        expect(stubs.axiosGet.called).to.equal(false)
    })

    it('loads the manifest for an explicit release ref', async () => {
        stubs.axiosGet.resolves(contentsResponse(manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: PIN_SHA } })))
        const t = await svc.resolveInstallTarget('v0.9.0')
        expect(t.kind).to.equal('release')
        expect(t.tag).to.equal('v0.9.0')
        expect(t.manifest.components['xchain-vm'].commit).to.equal(PIN_SHA)
        // Fetched AT THE TAG, not from the running checkout.
        expect(stubs.axiosGet.firstCall.args[1].params).to.deep.equal({ ref: 'v0.9.0' })
    })

    it('resolves the latest release when no ref is given', async () => {
        stubs.axiosGet.onFirstCall().resolves({ data: { tag_name: 'v0.9.0' } })
        stubs.axiosGet.onSecondCall().resolves(contentsResponse(manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: PIN_SHA } })))
        const t = await svc.resolveInstallTarget(null)
        expect(t.kind).to.equal('release')
        expect(t.tag).to.equal('v0.9.0')
        expect(t.resolvedFrom).to.equal('latest published release')
    })

    it('falls back to the default branch when NO release exists (pre-first-train)', async () => {
        const err = new Error('Not Found'); err.response = { status: 404 }
        stubs.axiosGet.rejects(err)
        const t = await svc.resolveInstallTarget(null, { defaultBranch: 'master' })
        expect(t.kind).to.equal('branch')
        expect(t.ref).to.equal('master')
        expect(t.resolvedFrom).to.equal('no published release')
    })
})

serviceSuite('resolveInstallTarget()', () => {
    it('falls back to the default branch when the lookup fails outright', async () => {
        // Offline / rate-limited operators must still be able to install.
        sinon.stub(console, 'warn')
        stubs.axiosGet.rejects(new Error('getaddrinfo ENOTFOUND'))
        const t = await svc.resolveInstallTarget(null, { defaultBranch: 'master' })
        expect(t.kind).to.equal('branch')
        expect(t.ref).to.equal('master')
        expect(t.resolvedFrom).to.equal('fallback after lookup failure')
    })

    // An UPDATE of a release node must never degrade to a branch: that
    // fallback would move every pinned module onto a branch tip because
    // GitHub was unreachable for a moment.
    it('refuses to fall back to a branch when told not to and the lookup fails', async () => {
        stubs.axiosGet.rejects(new Error('getaddrinfo ENOTFOUND'))
        await svc.resolveInstallTarget(null, { defaultBranch: 'master', fallbackToBranch: false }).then(
            () => { throw new Error('should have rejected') },
            e => {
                expect(e.message).to.match(/Could not resolve the latest xchain-node release/)
                expect(e.message).to.match(/Nothing was changed/)
            })
    })

    it('refuses to fall back to a branch when told not to and no release exists', async () => {
        const err = new Error('Not Found'); err.response = { status: 404 }
        stubs.axiosGet.rejects(err)
        await svc.resolveInstallTarget(null, { fallbackToBranch: false }).then(
            () => { throw new Error('should have rejected') },
            e => expect(e.message).to.match(/No published xchain-node release exists/))
    })
})

serviceSuite('resolveInstallTarget()', () => {
    it('reports a release ref that has no manifest, instead of installing tips', async () => {
        const err = new Error('Not Found'); err.response = { status: 404 }
        stubs.axiosGet.rejects(err)
        await svc.resolveInstallTarget('v0.1.0').then(
            () => { throw new Error('should have rejected') },
            e => expect(e.message).to.match(/No release manifest found for v0\.1\.0/))
    })

    it('rejects a manifest that is not valid JSON', async () => {
        stubs.axiosGet.resolves({ data: { encoding: 'base64', content: Buffer.from('{nope').toString('base64') } })
        await svc.resolveInstallTarget('v0.9.0').then(
            () => { throw new Error('should have rejected') },
            e => expect(e.message).to.match(/not valid JSON/))
    })

    it('prefers the LOCAL manifest when the running checkout is that release', async () => {
        stubs.readFileSync.returns(JSON.stringify(manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: OTHER_SHA } })))
        const local = load(stubs)
        const t = await local.resolveInstallTarget('v0.9.0')
        expect(t.manifest.components['xchain-vm'].commit).to.equal(OTHER_SHA)
        expect(stubs.axiosGet.called).to.equal(false)
        // Skip signature checks for bytes from the running checkout because
        // verifying them here would only prove the checkout agrees with itself.
        expect(stubs.verifyManifestForTag.called).to.equal(false)
    })
})
