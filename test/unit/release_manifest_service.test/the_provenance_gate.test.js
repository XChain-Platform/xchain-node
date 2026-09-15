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

const PIN_SHA = 'a'.repeat(40)

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

serviceSuite('the provenance gate', () => {
    // Verify fetched manifest bytes before parsing so clone integrity is backed
    // by signed provenance rather than source consistency alone.
    it('verifies the fetched manifest BEFORE parsing it', async () => {
        const body = manifest({ 'xchain-vm': { tag: 'v0.9.0', commit: PIN_SHA } })
        stubs.axiosGet.resolves(contentsResponse(body))
        await svc.resolveInstallTarget('v0.9.0')

        expect(stubs.verifyManifestForTag.calledOnce).to.equal(true)
        const args = stubs.verifyManifestForTag.firstCall.args[0]
        expect(args.tag).to.equal('v0.9.0')
        // The EXACT bytes that were fetched, not a re-serialization of them:
        // a digest is a statement about bytes.
        expect(args.manifestBytes.toString('utf8')).to.equal(JSON.stringify(body))
        expect(args.fetchAsset).to.be.a('function')
    })

    it('a refusal from the gate aborts the install', async () => {
        stubs.axiosGet.resolves(contentsResponse(manifest()))
        stubs.verifyManifestForTag.rejects(new Error('Release v0.9.0 publishes no SHA256SUMS.asc.'))
        await svc.resolveInstallTarget('v0.9.0').then(
            () => { throw new Error('should have rejected') },
            e => expect(e.message).to.match(/publishes no SHA256SUMS\.asc/))
    })
})

serviceSuite('the provenance gate', () => {
    it('fetchReleaseAsset returns null when the release carries no such asset', async () => {
        stubs.axiosGet.resolves({ data: { assets: [{ name: 'SHA256SUMS', url: 'https://api/asset/1' }] } })
        expect(await svc.fetchReleaseAsset('v0.9.0', 'SHA256SUMS.asc')).to.equal(null)
    })

    it('fetchReleaseAsset returns null when the release itself is absent', async () => {
        const err = new Error('Not Found'); err.response = { status: 404 }
        stubs.axiosGet.rejects(err)
        expect(await svc.fetchReleaseAsset('v9.9.9', 'SHA256SUMS')).to.equal(null)
    })

    it('fetchReleaseAsset downloads the asset bytes', async () => {
        stubs.axiosGet.onFirstCall().resolves({ data: { assets: [{ name: 'SHA256SUMS', url: 'https://api/asset/1' }] } })
        stubs.axiosGet.onSecondCall().resolves({ status: 200, data: Buffer.from('digests\n') })
        const bytes = await svc.fetchReleaseAsset('v0.9.0', 'SHA256SUMS')
        expect(bytes.toString('utf8')).to.equal('digests\n')
        expect(stubs.axiosGet.secondCall.args[1].headers.Accept).to.equal('application/octet-stream')
    })

    it('fetchReleaseAsset follows the storage redirect WITHOUT the credentials', async () => {
        // Signed object storage rejects a request that still carries our
        // Authorization header, which is why the redirect is followed by
        // hand rather than by axios.
        stubs.axiosGet.onCall(0).resolves({ data: { assets: [{ name: 'SHA256SUMS', url: 'https://api/asset/1' }] } })
        stubs.axiosGet.onCall(1).resolves({ status: 302, headers: { location: 'https://objects/blob' }, data: null })
        stubs.axiosGet.onCall(2).resolves({ status: 200, data: Buffer.from('digests\n') })

        const bytes = await svc.fetchReleaseAsset('v0.9.0', 'SHA256SUMS')
        expect(bytes.toString('utf8')).to.equal('digests\n')
        expect(stubs.axiosGet.thirdCall.args[0]).to.equal('https://objects/blob')
        expect(stubs.axiosGet.thirdCall.args[1].headers).to.not.have.property('Authorization')
        expect(stubs.axiosGet.thirdCall.args[1].headers).to.not.have.property('Accept')
    })
})
