'use strict'

// Copyright © 2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Axios waits forever by default, so a GitHub request with no timeout turns a
// stalled route into a hung status or precheck instead of the degraded warning
// the advisory callers are written to print. Every GitHub call names a bound.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { GITHUB_API_TIMEOUT_MS, GITHUB_DOWNLOAD_TIMEOUT_MS } = require('../../src/utils/github_api')

function expectBounded(options, bound) {
    expect(options, 'the request options').to.be.an('object')
    expect(options.timeout, 'the request timeout').to.equal(bound)
}

function loadManifestService(axiosGet) {
    return proxyquire('../../src/services/release_manifest_service', {
        'fs':    { readFileSync: sinon.stub().throws(new Error('ENOENT')) },
        'axios': { get: axiosGet },
        './release_signature_service': {
            verifyManifestForTag: sinon.stub().resolves({ verified: true, fingerprint: 'F'.repeat(40) })
        }
    })
}

function loadDownloader(axiosStub) {
    const fsStub = {
        existsSync:        sinon.stub().returns(true),
        readFileSync:      sinon.stub().returns(JSON.stringify({})),
        writeFileSync:     sinon.stub(),
        createWriteStream: sinon.stub(),
        mkdirSync:         sinon.stub()
    }
    const hashVerification = proxyquire('../../src/services/github_downloader/hash_verification.js', { 'fs': fsStub })
    const GitHubDownloader = proxyquire('../../src/services/github_downloader', {
        'fs':            fsStub,
        'axios':         axiosStub,
        'child_process': { spawnSync: sinon.stub().returns({ status: 0 }) },
        './github_downloader/hash_verification.js': hashVerification
    })
    return new GitHubDownloader('/test/hashes.json')
}

describe('GitHub request timeouts', function () {

    afterEach(() => sinon.restore())

    it('declares positive bounds, the download one no shorter than the API one', function () {
        expect(GITHUB_API_TIMEOUT_MS).to.be.a('number').and.to.be.above(0)
        expect(GITHUB_DOWNLOAD_TIMEOUT_MS).to.be.a('number').and.to.be.at.least(GITHUB_API_TIMEOUT_MS)
    })

    it('bounds the release manifest read', async function () {
        const axiosGet = sinon.stub().resolves({
            data: { encoding: 'base64', content: Buffer.from(JSON.stringify({ platform_version: '9.9.9' })).toString('base64') }
        })
        await loadManifestService(axiosGet).fetchManifestAtTag('v9.9.9')
        expectBounded(axiosGet.firstCall.args[1], GITHUB_API_TIMEOUT_MS)
    })

    it('bounds the latest-release lookup', async function () {
        const axiosGet = sinon.stub().resolves({ data: { tag_name: 'v9.9.9' } })
        await loadManifestService(axiosGet).resolveLatestReleaseTag()
        expectBounded(axiosGet.firstCall.args[1], GITHUB_API_TIMEOUT_MS)
    })

    it('bounds every hop of a release asset fetch', async function () {
        const axiosGet = sinon.stub()
        axiosGet.onFirstCall().resolves({ data: { assets: [{ name: 'sig.asc', url: 'https://api.github.com/asset/1' }] } })
        axiosGet.onSecondCall().resolves({ status: 302, headers: { location: 'https://objects.example/sig.asc' } })
        axiosGet.onThirdCall().resolves({ data: Buffer.from('sig') })
        await loadManifestService(axiosGet).fetchReleaseAsset('v9.9.9', 'sig.asc')
        expect(axiosGet.callCount).to.equal(3)
        expectBounded(axiosGet.firstCall.args[1], GITHUB_API_TIMEOUT_MS)
        expectBounded(axiosGet.secondCall.args[1], GITHUB_API_TIMEOUT_MS)
        expectBounded(axiosGet.thirdCall.args[1], GITHUB_DOWNLOAD_TIMEOUT_MS)
    })

})

describe('GitHub request timeouts for coin releases', function () {

    afterEach(() => sinon.restore())

    it('bounds the coin release list and tag lookups', async function () {
        const axiosStub = { get: sinon.stub().resolves({ data: [] }) }
        const dl = loadDownloader(axiosStub)
        await dl.getReleases('bitcoin', 'bitcoin')
        await dl.getReleaseByTag('bitcoin', 'bitcoin', 'v1.0.0')
        expectBounded(axiosStub.get.firstCall.args[1], GITHUB_API_TIMEOUT_MS)
        expectBounded(axiosStub.get.secondCall.args[1], GITHUB_API_TIMEOUT_MS)
    })

    it('bounds the coin release asset download', async function () {
        const axiosStub = sinon.stub().rejects(new Error('stop after the request is built'))
        axiosStub.get = sinon.stub()
        const dl = loadDownloader(axiosStub)
        const release = {
            tag_name: 'v1.0.0',
            assets: ['x86_64', 'aarch64'].map(arch => ({
                name: 'coin-' + arch + '-linux-gnu.tar.gz',
                browser_download_url: 'https://github.example/coin-' + arch + '.tar.gz'
            }))
        }
        await dl.downloadReleaseAsset(release, '/tmp/out', 'owner/repo', 'v1.0.0', false).then(
            () => expect.fail('the stubbed request rejects'),
            () => {}
        )
        expect(axiosStub.calledOnce).to.equal(true)
        expectBounded(axiosStub.firstCall.args[0], GITHUB_DOWNLOAD_TIMEOUT_MS)
    })
})
