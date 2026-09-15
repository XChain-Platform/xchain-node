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

downloaderSuite('loadHashesFile(): invalid hash in object entry', function () {

    it('throws when arch hash is invalid in object entry', function () {
        const fsStub = {
            existsSync: sinon.stub().returns(true),
            readFileSync: sinon.stub().returns(JSON.stringify({
                'owner/repo': { 'v1.0.0': { x86_64: 'short' } }
            })),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub })
        expect(() => new GitHubDownloader('/test/hashes.json')).to.throw('Invalid SHA-256 hash')
    })

    it('throws when version entry is neither string nor object', function () {
        const fsStub = {
            existsSync: sinon.stub().returns(true),
            readFileSync: sinon.stub().returns(JSON.stringify({
                'owner/repo': { 'v1.0.0': null }
            })),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub })
        expect(() => new GitHubDownloader('/test/hashes.json')).to.throw('Invalid hash entry')
    })

    it('throws when top-level repo entry is not an object', function () {
        const fsStub = {
            existsSync: sinon.stub().returns(true),
            readFileSync: sinon.stub().returns(JSON.stringify({
                'owner/repo': 'not-an-object'
            })),
            statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub })
        expect(() => new GitHubDownloader('/test/hashes.json')).to.throw('Invalid hash format')
    })
})
