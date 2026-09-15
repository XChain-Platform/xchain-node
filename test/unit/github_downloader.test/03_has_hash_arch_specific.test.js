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
    sinon
} = require('./support/helpers')

function downloaderSuite(title, tests) {
    describe('GitHubDownloader', function () {
        describe(title, tests)
    })
}

downloaderSuite('hasHash(): arch-specific', function () {

    it('returns true for object entry with matching arch', function () {
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
        expect(dl.hasHash('owner/repo', 'v2.0.0', 'x86_64')).to.be.true
        expect(dl.hasHash('owner/repo', 'v2.0.0', 'aarch64')).to.be.false
    })

    it('returns true for object entry with no arch requirement when keys exist', function () {
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
        expect(dl.hasHash('owner/repo', 'v2.0.0')).to.be.true // no arch → any hash counts
    })
})
