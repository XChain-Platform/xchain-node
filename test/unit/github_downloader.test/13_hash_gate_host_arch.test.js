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

const {
    expect,
    loadDownloader,
    makeAxiosStub,
    sinon
} = require('./support/helpers')

// The newest release pins only an x86_64 hash; the older one pins both arches.
const PARTIAL_HASHES = {
    'owner/repo': {
        'v2.0.0': { x86_64: 'a'.repeat(64) },
        'v1.0.0': { x86_64: 'b'.repeat(64), aarch64: 'c'.repeat(64) }
    }
}

const RELEASES = [
    { tag_name: 'v1.0.0', published_at: '2026-01-01T00:00:00Z', assets: [] },
    { tag_name: 'v2.0.0', published_at: '2026-06-01T00:00:00Z', assets: [] }
]

// Builds a downloader over the given hashes file and an axios stub.
function downloaderWith(hashes, axiosStub) {
    const fsStub = {
        existsSync: sinon.stub().returns(true),
        readFileSync: sinon.stub().callsFake((p) => {
            if (p.endsWith('hashes.json')) return JSON.stringify(hashes)
            return Buffer.from('data')
        }),
        statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
    }
    const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosStub })
    return new GitHubDownloader('/test/hashes.json')
}

function hostArchSuite(title, tests) {
    describe('GitHubDownloader', function () {
        describe(title, function () {
            const originalArch = process.arch
            afterEach(function () {
                Object.defineProperty(process, 'arch', { value: originalArch, configurable: true })
            })
            tests()
        })
    })
}

// Pretends the tests run on the named Node arch (x64 or arm64).
function onArch(nodeArch) {
    Object.defineProperty(process, 'arch', { value: nodeArch, configurable: true })
}

hostArchSuite('getLatestCompatibleVersion(): host-arch hash gate', function () {
    it('skips a newer release with no hash for an aarch64 host', async function () {
        onArch('arm64')
        const axiosStub = makeAxiosStub()
        axiosStub.get.resolves({ data: RELEASES.map(r => ({ ...r })) })
        const release = await downloaderWith(PARTIAL_HASHES, axiosStub).getLatestCompatibleVersion('owner', 'repo', true)
        expect(release.tag_name).to.equal('v1.0.0')
    })

    it('still picks the newest release on an x86_64 host', async function () {
        onArch('x64')
        const axiosStub = makeAxiosStub()
        axiosStub.get.resolves({ data: RELEASES.map(r => ({ ...r })) })
        const release = await downloaderWith(PARTIAL_HASHES, axiosStub).getLatestCompatibleVersion('owner', 'repo', true)
        expect(release.tag_name).to.equal('v2.0.0')
    })

    it('throws when no release has a hash for the host arch', async function () {
        onArch('arm64')
        const onlyX86 = { 'owner/repo': { 'v2.0.0': { x86_64: 'a'.repeat(64) } } }
        const axiosStub = makeAxiosStub()
        axiosStub.get.resolves({ data: RELEASES.map(r => ({ ...r })) })
        try {
            await downloaderWith(onlyX86, axiosStub).getLatestCompatibleVersion('owner', 'repo', true)
            expect.fail('should have thrown')
        } catch (e) {
            expect(e.message).to.include('hashes file')
            expect(e.message).to.include('aarch64')
        }
    })
})

hostArchSuite('downloadRepoVersion(): host-arch hash gate', function () {
    it('refuses before any asset download when the host arch has no hash', async function () {
        onArch('arm64')
        const axiosStub = makeAxiosStub()
        axiosStub.get.resolves({ data: { tag_name: 'v2.0.0', assets: [] } })
        const dl = downloaderWith(PARTIAL_HASHES, axiosStub)
        const assetDownload = sinon.stub(dl, 'downloadReleaseAsset').resolves()
        try {
            await dl.downloadRepoVersion('owner', 'repo', 'v2.0.0', { verifyHash: true })
            expect.fail('should have thrown')
        } catch (e) {
            expect(e.message).to.include('Required SHA-256 hash not found')
            expect(e.message).to.include('aarch64')
        }
        expect(assetDownload.called).to.equal(false)
    })
})
