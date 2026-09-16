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
    path,
    sinon,
    validHashesData
} = require('./support/helpers')

function downloaderSuite(title, tests) {
    describe('GitHubDownloader', function () {
        describe(title, tests)
    })
}

downloaderSuite("downloadRepoVersion()", function () {
    it('throws when hash not found for repo/version', async function () {
        const axiosStub = makeAxiosStub()
        axiosStub.get.resolves({ data: { tag_name: 'v99.0.0', assets: [] } })
        const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        try {
            await dl.downloadRepoVersion('owner', 'repo', 'v99.0.0', { verifyHash: true })
            expect.fail()
        } catch (e) {
            expect(e.message).to.include('Required SHA-256 hash not found')
        }
    })

    it('cleans up the staging directory when download fails and leaves the previous tree alone', async function () {
        const axiosStub = makeAxiosStub()
        // getReleaseByTag returns a release, but downloadReleaseAsset will fail (no matching asset)
        axiosStub.get.resolves({
            data: {
                tag_name: 'v1.0.0',
                assets: [] // no assets → downloadReleaseAsset throws
            }
        })
        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => {
                // hashes file exists
                if (p.endsWith('hashes.json')) return true
                // staging and output paths exist (to trigger cleanup)
                return true
            }),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                return Buffer.from('data')
            }),
            writeFileSync: sinon.stub(),
            rmSync: sinon.stub(),
            renameSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub(),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
            readdirSync: sinon.stub().returns([])
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        try {
            await dl.downloadRepoVersion('owner', 'repo', 'v1.0.0', { verifyHash: false })
            expect.fail()
        } catch (e) {
            const removed = fsStub.rmSync.getCalls().map(c => c.args[0])
            expect(removed).to.include(path.join('./downloads', 'repo') + '.staging')
            // The daemon tree a running container was built from survives a failed update.
            expect(removed).to.not.include(path.join('./downloads', 'repo'))
            expect(fsStub.renameSync.called).to.be.false
        }
    })

})

downloaderSuite("downloadRepoVersion()", function () {
    it('extracts into a staging directory and swaps it over the previous version tree', async function () {
        // Regression: extracting straight into the live tree left the new
        // release nested beside the previous bin/ and share/, so the image
        // was built from the OLD binaries under a NEW version file.
        const axiosStub = makeAxiosStub()
        axiosStub.get.resolves({ data: { tag_name: 'v1.0.0', assets: [] } })
        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return true
                return !p.endsWith('.staging') // previous tree present, no stale staging dir
            }),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                return Buffer.from('data')
            }),
            writeFileSync: sinon.stub(),
            rmSync: sinon.stub(),
            renameSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub(),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
            readdirSync: sinon.stub().returns([])
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        dl.downloadReleaseAsset = sinon.stub().resolves()
        const live    = path.join('./downloads', 'repo')
        const staging = live + '.staging'
        const result = await dl.downloadRepoVersion('owner', 'repo', 'v1.0.0', { verifyHash: false })

        expect(dl.downloadReleaseAsset.firstCall.args[1]).to.equal(staging)
        expect(fsStub.writeFileSync.firstCall.args[0]).to.equal(path.join(staging, '__VERSION__.txt'))
        expect(fsStub.rmSync.calledWith(live)).to.be.true
        expect(fsStub.renameSync.calledOnceWith(staging, live)).to.be.true
        // Order: the old tree goes only after the new one is fully staged.
        expect(dl.downloadReleaseAsset.calledBefore(fsStub.rmSync)).to.be.true
        expect(result).to.equal(live)
    })

})

downloaderSuite("downloadRepoVersion()", function () {
    it('writes version file on successful download', async function () {
        // Use a custom downloader where downloadReleaseAsset is stubbed
        const axiosStub = makeAxiosStub()
        const releaseData = { tag_name: 'v1.0.0', assets: [] }
        axiosStub.get.resolves({ data: releaseData })

        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return true
                return true // output path exists → triggers version file write
            }),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                return Buffer.from('data')
            }),
            writeFileSync: sinon.stub(),
            rmSync: sinon.stub(),
            renameSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub(),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
            readdirSync: sinon.stub().returns([])
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        // Stub downloadReleaseAsset to succeed without real download
        dl.downloadReleaseAsset = sinon.stub().resolves()
        const result = await dl.downloadRepoVersion('owner', 'repo', 'v1.0.0', { verifyHash: false })
        // Should have written version file
        expect(fsStub.writeFileSync.called).to.be.true
        expect(result).to.include('repo')
    })
})
