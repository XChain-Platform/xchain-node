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
    sinon,
    validHashesData
} = require('./support/helpers')

function downloaderSuite(title, tests) {
    describe('GitHubDownloader', function () {
        describe(title, tests)
    })
}

downloaderSuite('downloadReleaseAsset(): verifyHash=true', function () {

    it('calls verifyRepositoryHash when verifyHash=true', async function () {
        const { Readable, Writable } = require('stream')
        const responseStream = new Readable({ read() {} })
        setImmediate(() => responseStream.push(null))

        const axiosFn = sinon.stub().resolves({ data: responseStream })
        axiosFn.get = sinon.stub()
        const spawnSyncStub = sinon.stub().returns({ status: 0 })
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

        const ws = new Writable({ write(chunk, enc, cb) { cb() } })

        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                return Buffer.from('data')
            }),
            writeFileSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub().returns(ws),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
            readdirSync: sinon.stub().returns([]),
            unlinkSync: sinon.stub()
        }

        const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        const verifyStub = sinon.stub().resolves()
        dl.verifyRepositoryHash = verifyStub

        const release = {
            tag_name: 'v1.0.0',
            assets: [
                { name: `bitcoin-linux-${arch}.tar.gz`, browser_download_url: 'http://example.com/bitcoin.tar.gz' }
            ]
        }

        await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', true) // verifyHash=true
        expect(verifyStub.calledOnce).to.be.true
    })
})
