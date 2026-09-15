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
    crypto,
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

downloaderSuite("verifyRepositoryHash()", function () {
    it('does not throw when hash matches', async function () {
        // We need a predictable hash
        const content = Buffer.from('test')
        const expectedHash = crypto.createHash('sha256').update(content).digest('hex')

        const customHashesData = { 'owner/repo': { 'v1.0.0': expectedHash } }
        const fsStub = {
            existsSync: sinon.stub().returns(true),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('github_hashes.json') || p === '/test/hashes.json') {
                    return JSON.stringify(customHashesData)
                }
                return content
            }),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
            readdirSync: sinon.stub().returns([])
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub })
        const dl = new GitHubDownloader('/test/hashes.json')

        // Should not throw
        await dl.verifyRepositoryHash('owner/repo', 'v1.0.0', '/path/to/file')
    })

    it('throws when hash does not match', async function () {
        const fsStub = {
            existsSync: sinon.stub().returns(true),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('github_hashes.json') || p === '/test/hashes.json') {
                    return JSON.stringify(validHashesData)
                }
                return Buffer.from('different-content')
            }),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
            readdirSync: sinon.stub().returns([])
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub })
        const dl = new GitHubDownloader('/test/hashes.json')

        try {
            await dl.verifyRepositoryHash('owner/repo', 'v1.0.0', '/path/to/file')
            expect.fail()
        } catch (e) {
            expect(e.message).to.include('Hash verification failed')
        }
    })

})

downloaderSuite("verifyRepositoryHash()", function () {
    it('throws when no hash registered for the repo/version/arch', async function () {
        const { GitHubDownloader } = loadDownloader()
        const dl = new GitHubDownloader('/test/hashes.json')
        // 'unknown/repo' has no entry in validHashesData
        try {
            await dl.verifyRepositoryHash('unknown/repo', 'v1.0.0', '/path/to/file')
            expect.fail()
        } catch (e) {
            expect(e.message).to.include('No SHA-256 hash registered')
        }
    })

    it('passes explicit arch parameter to getHashForArch', async function () {
        const content = Buffer.from('test')
        const expectedHash = crypto.createHash('sha256').update(content).digest('hex')

        const customHashesData = { 'owner/repo': { 'v1.0.0': { myarch: expectedHash } } }
        const fsStub = {
            existsSync: sinon.stub().returns(true),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(customHashesData)
                return content
            }),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
            readdirSync: sinon.stub().returns([])
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        // Should not throw when passing the right arch
        await dl.verifyRepositoryHash('owner/repo', 'v1.0.0', '/path/to/file', 'myarch')
    })
})
