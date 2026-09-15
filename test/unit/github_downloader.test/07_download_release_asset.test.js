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
    it('throws when no matching linux asset found for host arch', async function () {
        // Build a release with only a Windows asset so asset selection fails
        const { Readable } = require('stream')
        const axiosFn = sinon.stub().resolves({ data: new Readable({ read() {} }) })
        axiosFn.get = sinon.stub()
        const { GitHubDownloader } = loadDownloader({ axios: axiosFn })
        const dl = new GitHubDownloader('/test/hashes.json')

        const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
        const release = {
            tag_name: 'v1.0.0',
            assets: [
                // Windows-only asset; no linux match
                { name: `bitcoin-win64-${arch}.zip`, browser_download_url: 'http://example.com/win.zip' }
            ]
        }
        try {
            await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
            expect.fail()
        } catch (e) {
            // downloadReleaseAsset wraps in "Error downloading asset: <inner message>"
            expect(e.message).to.satisfy((m) =>
                m.includes('linux') || m.includes('Error downloading asset')
            )
        }
    })

})

downloaderSuite("downloadReleaseAsset()", function () {
    it('downloads gz asset using axios stream + pipeline, extracts with tar', async function () {
        // Use a proper Writable stream to satisfy pipeline's dst.end requirement
        const { Readable, Writable } = require('stream')
        const responseStream = new Readable({ read() {} })
        setImmediate(() => responseStream.push(null)) // end stream async

        const axiosFn = sinon.stub().resolves({ data: responseStream })
        axiosFn.get = sinon.stub()

        const spawnSyncStub = sinon.stub().returns({ status: 0 })
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

        // Create a proper Writable for createWriteStream
        const ws = new Writable({ write(chunk, enc, cb) { cb() } })

        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return true
                return false // output path doesn't exist → mkdirSync
            }),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                return Buffer.from('binary data')
            }),
            writeFileSync: sinon.stub(),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub().returns(ws),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
            readdirSync: sinon.stub().returns([]), // no extracted dirs
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
        expect(spawnSyncStub.calledWith('tar')).to.be.true
        expect(fsStub.unlinkSync.calledOnce).to.be.true
    })

})

downloaderSuite("downloadReleaseAsset()", function () {
    it('refuses to extract a gz asset with an unsafe member path', async function () {
        const { Readable, Writable } = require('stream')
        const responseStream = new Readable({ read() {} })
        setImmediate(() => responseStream.push(null))

        const axiosFn = sinon.stub().resolves({ data: responseStream })
        axiosFn.get = sinon.stub()

        // Member listing (tar -tzf) reports an absolute path; extraction must not run
        const spawnSyncStub = sinon.stub().callsFake((cmd, args) => {
            if (args[0] === '-tzf') return { status: 0, stdout: 'ok.txt\n/etc/cron.d/evil\n' }
            return { status: 0 }
        })
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

        const ws = new Writable({ write(chunk, enc, cb) { cb() } })

        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                return Buffer.from('binary data')
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
                { name: `bitcoin-linux-${arch}.tar.gz`, browser_download_url: 'http://example.com/bitcoin.tar.gz' }
            ]
        }

        try {
            await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
            expect.fail('should have thrown')
        } catch (e) {
            expect(e.message).to.include('unsafe member path')
        }
        expect(spawnSyncStub.calledWith('tar', sinon.match(args => args[0] === '-xzf'))).to.be.false
        expect(fsStub.unlinkSync.called).to.be.false
    })

})

downloaderSuite("downloadReleaseAsset()", function () {
    it('extracts zip asset and calls unzip', async function () {
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
                return Buffer.from('zip content')
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
                { name: `bitcoin-linux-${arch}.zip`, browser_download_url: 'http://example.com/bitcoin.zip' }
            ]
        }

        await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
        expect(spawnSyncStub.calledWith('unzip')).to.be.true
        expect(fsStub.unlinkSync.calledOnce).to.be.true
    })

})

downloaderSuite("downloadReleaseAsset()", function () {
    it('refuses to extract a zip asset with an unsafe member path', async function () {
        const { Readable, Writable } = require('stream')
        const responseStream = new Readable({ read() {} })
        setImmediate(() => responseStream.push(null))

        const axiosFn = sinon.stub().resolves({ data: responseStream })
        axiosFn.get = sinon.stub()

        // Member listing (unzip -Z1) reports a traversal path; the extraction
        // pass (bare `unzip -d`) must not run, mirroring the tar branch.
        const spawnSyncStub = sinon.stub().callsFake((cmd, args) => {
            if (args[0] === '-Z1') return { status: 0, stdout: 'ok.txt\n../../etc/evil\n' }
            return { status: 0 }
        })
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'

        const ws = new Writable({ write(chunk, enc, cb) { cb() } })

        const fsStub = {
            existsSync: sinon.stub().callsFake((p) => p.endsWith('hashes.json')),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                return Buffer.from('zip content')
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
                { name: `bitcoin-linux-${arch}.zip`, browser_download_url: 'http://example.com/bitcoin.zip' }
            ]
        }

        try {
            await dl.downloadReleaseAsset(release, '/output', 'owner/repo', 'v1.0.0', false)
            expect.fail('should have thrown')
        } catch (e) {
            expect(e.message).to.include('unsafe member path')
        }
        // The extraction pass is `unzip <file> -d <out>`; assert it never ran.
        expect(spawnSyncStub.calledWith('unzip', sinon.match(args => args[1] === '-d'))).to.be.false
        expect(fsStub.unlinkSync.called).to.be.false
    })

})
