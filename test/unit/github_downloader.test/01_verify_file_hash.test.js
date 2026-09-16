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

downloaderSuite('verifyFileHash()', function () {

    const contentHash = crypto.createHash('sha256').update(Buffer.from('tarball-bytes')).digest('hex')

    function makeFsWith(hashesData) {
        return {
            existsSync: sinon.stub().returns(true),
            readFileSync: sinon.stub().callsFake((p) => {
                if (typeof p === 'string' && p.endsWith('hashes.json')) return JSON.stringify(hashesData)
                return Buffer.from('tarball-bytes')
            }),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
        }
    }

    it('computes the SHA-256 of the file bytes', async function () {
        const { GitHubDownloader } = loadDownloader({ fs: makeFsWith(validHashesData) })
        const dl = new GitHubDownloader('/test/hashes.json')
        const hash = await dl.calculateFileHash('/tmp/bitcoin.tar.gz')
        expect(hash).to.equal(contentHash)
    })

    it('passes when the tarball hash matches the registered per-arch hash', async function () {
        const data = { 'bitcoin/bitcoin': { 'v28.1': { x86_64: contentHash, aarch64: 'd'.repeat(64) } } }
        const { GitHubDownloader } = loadDownloader({ fs: makeFsWith(data) })
        const dl = new GitHubDownloader('/test/hashes.json')
        // Resolves without throwing.
        await dl.verifyFileHash('/tmp/bitcoin.tar.gz', 'bitcoin/bitcoin', 'v28.1', 'x86_64')
    })

    it('throws when the tarball hash does not match', async function () {
        const data = { 'bitcoin/bitcoin': { 'v28.1': { x86_64: 'e'.repeat(64) } } }
        const { GitHubDownloader } = loadDownloader({ fs: makeFsWith(data) })
        const dl = new GitHubDownloader('/test/hashes.json')
        let threw = false
        try {
            await dl.verifyFileHash('/tmp/bitcoin.tar.gz', 'bitcoin/bitcoin', 'v28.1', 'x86_64')
        } catch (err) {
            threw = true
            expect(err.message).to.match(/Hash verification failed/)
        }
        expect(threw, 'verifyFileHash should reject on mismatch').to.be.true
    })

    it('fails closed when no hash is registered for the version/arch', async function () {
        const { GitHubDownloader } = loadDownloader({ fs: makeFsWith({}) })
        const dl = new GitHubDownloader('/test/hashes.json')
        let threw = false
        try {
            await dl.verifyFileHash('/tmp/bitcoin.tar.gz', 'bitcoin/bitcoin', 'v99.9', 'x86_64')
        } catch (err) {
            threw = true
            expect(err.message).to.match(/No SHA-256 hash registered/)
        }
        expect(threw, 'verifyFileHash should reject when unregistered').to.be.true
    })
})
