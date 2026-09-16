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

downloaderSuite("downloadReleaseAsset()", function () {
    it('handles single extracted directory by flattening contents', async function () {
        const { Readable, Writable } = require('stream')
        const responseStream = new Readable({ read() {} })
        setImmediate(() => responseStream.push(null))

        const axiosFn = sinon.stub().resolves({ data: responseStream })
        axiosFn.get = sinon.stub()
        const spawnSyncStub = sinon.stub().returns({ status: 0 })
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

        const ws = new Writable({ write(chunk, enc, cb) { cb() } })
        const renameSync = sinon.stub()
        const rmdirSync = sinon.stub()

        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                return Buffer.from('data')
            }),
            writeFileSync: sinon.stub(),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub().returns(ws),
            statSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return { isFile: () => true, isDirectory: () => false }
                if (p.includes('extracted-dir')) return { isFile: () => false, isDirectory: () => true }
                return { isFile: () => true, isDirectory: () => false }
            }),
            readdirSync: sinon.stub().callsFake((p) => {
                if (p === '/output') return ['extracted-dir'] // one extracted dir
                return ['file1.txt', 'bin'] // files inside the extracted dir
            }),
            renameSync,
            rmdirSync,
            unlinkSync: sinon.stub()
        }

        const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        dl.verifyRepositoryHash = sinon.stub().resolves()

        const release = {
            tag_name: 'v1.0.0',
            assets: [
                { name: `bitcoin-linux-${arch}.tar.gz`, browser_download_url: 'http://example.com/bitcoin.tar.gz' }
            ]
        }

        await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
        // Single extracted dir → rename + rmdirSync
        expect(renameSync.called).to.be.true
        expect(rmdirSync.calledOnce).to.be.true
    })

})

downloaderSuite("downloadReleaseAsset()", function () {
    it('warns on unrecognized file extension (no extraction)', async function () {
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
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub().returns(ws),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
            readdirSync: sinon.stub().returns([]),
            unlinkSync: sinon.stub()
        }

        const { GitHubDownloader } = loadDownloader({ fs: fsStub, axios: axiosFn, spawnSync: spawnSyncStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        dl.verifyRepositoryHash = sinon.stub().resolves()

        const release = {
            tag_name: 'v1.0.0',
            assets: [
                // .bin extension → unrecognized → warn, no extract
                { name: `bitcoin-linux-${arch}.bin`, browser_download_url: 'http://example.com/bitcoin.bin' }
            ]
        }

        await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
        // No spawnSync called (no extraction)
        expect(spawnSyncStub.called).to.be.false
    })

})

downloaderSuite("downloadReleaseAsset()", function () {
    it('throws when unzip fails with non-zero exit code', async function () {
        const { Readable, Writable } = require('stream')
        const responseStream = new Readable({ read() {} })
        setImmediate(() => responseStream.push(null))

        const axiosFn = sinon.stub().resolves({ data: responseStream })
        axiosFn.get = sinon.stub()
        // The safe-member listing pass (`-Z1`) succeeds; the extraction pass
        // (`unzip <file> -d <out>`) is what fails with a non-zero exit.
        const spawnSyncStub = sinon.stub().callsFake((cmd, args) => {
            if (args[0] === '-Z1') return { status: 0, stdout: 'ok.txt\n' }
            return { status: 2 } // unzip extraction fails
        })
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
        dl.verifyRepositoryHash = sinon.stub().resolves()

        const release = {
            tag_name: 'v1.0.0',
            assets: [
                { name: `bitcoin-linux-${arch}.zip`, browser_download_url: 'http://example.com/bitcoin.zip' }
            ]
        }

        try {
            await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
            expect.fail()
        } catch (e) {
            expect(e.message).to.include('Error downloading asset')
            expect(e.message).to.include('unzip exited with code')
        }
    })

})

downloaderSuite("downloadReleaseAsset()", function () {
    it('throws when tar fails with non-zero exit code', async function () {
        const { Readable, Writable } = require('stream')
        const responseStream = new Readable({ read() {} })
        setImmediate(() => responseStream.push(null))

        const axiosFn = sinon.stub().resolves({ data: responseStream })
        axiosFn.get = sinon.stub()
        const spawnSyncStub = sinon.stub().returns({ status: 1 }) // tar fails
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
        dl.verifyRepositoryHash = sinon.stub().resolves()

        const release = {
            tag_name: 'v1.0.0',
            assets: [
                { name: `bitcoin-linux-${arch}.tar.gz`, browser_download_url: 'http://example.com/bitcoin.tar.gz' }
            ]
        }

        try {
            await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
            expect.fail()
        } catch (e) {
            expect(e.message).to.include('Error downloading asset')
            expect(e.message).to.include('tar exited with code')
        }
    })
})
