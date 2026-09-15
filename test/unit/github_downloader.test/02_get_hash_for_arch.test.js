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
    validHash
} = require('./support/helpers')

function downloaderSuite(title, tests) {
    describe('GitHubDownloader', function () {
        describe(title, tests)
    })
}

downloaderSuite('getHashForArch()', function () {

    it('returns string hash for legacy string entry (any arch)', function () {
        const { GitHubDownloader } = loadDownloader()
        const dl = new GitHubDownloader('/test/hashes.json')
        // validHashesData has 'owner/repo': { 'v1.0.0': validHash } (string)
        const result = dl.getHashForArch('owner/repo', 'v1.0.0', 'x86_64')
        expect(result).to.equal(validHash)
    })

    it('returns arch-specific hash for object entry', function () {
        const xHash = 'b'.repeat(64)
        const armHash = 'c'.repeat(64)
        const customData = { 'owner/repo': { 'v2.0.0': { x86_64: xHash, aarch64: armHash } } }
        const fsStub = {
            existsSync: sinon.stub().returns(true),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(customData)
                return Buffer.from('data')
            }),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        expect(dl.getHashForArch('owner/repo', 'v2.0.0', 'x86_64')).to.equal(xHash)
        expect(dl.getHashForArch('owner/repo', 'v2.0.0', 'aarch64')).to.equal(armHash)
    })

    it('returns null for unknown arch in object entry', function () {
        const xHash = 'b'.repeat(64)
        const customData = { 'owner/repo': { 'v2.0.0': { x86_64: xHash } } }
        const fsStub = {
            existsSync: sinon.stub().returns(true),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(customData)
                return Buffer.from('data')
            }),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        expect(dl.getHashForArch('owner/repo', 'v2.0.0', 'unknown_arch')).to.be.null
    })

    it('returns null for missing repo/version', function () {
        const { GitHubDownloader } = loadDownloader()
        const dl = new GitHubDownloader('/test/hashes.json')
        expect(dl.getHashForArch('nobody/norepo', 'v0.0.0', 'x86_64')).to.be.null
    })
})
