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

downloaderSuite('getAllFiles(): directory traversal', function () {

    it('returns all files recursively from a directory', function () {
        const fsStub = {
            existsSync: sinon.stub().returns(true),
            readFileSync: sinon.stub().callsFake((p) => {
                if (p.endsWith('hashes.json')) return JSON.stringify(validHashesData)
                return Buffer.from('content')
            }),
            statSync: sinon.stub().callsFake((p) => {
                if (p === '/test/hashes.json') return { isFile: () => true, isDirectory: () => false }
                if (p === '/dir' || p === '/dir/subdir') return { isFile: () => false, isDirectory: () => true }
                return { isFile: () => true, isDirectory: () => false }
            }),
            readdirSync: sinon.stub().callsFake((p, opts) => {
                if (p === '/dir') {
                    return [
                        { name: 'file.txt', isDirectory: () => false, isFile: () => true },
                        { name: 'subdir', isDirectory: () => true, isFile: () => false }
                    ]
                }
                if (p === '/dir/subdir') {
                    return [
                        { name: 'nested.txt', isDirectory: () => false, isFile: () => true }
                    ]
                }
                return []
            })
        }
        const { GitHubDownloader } = loadDownloader({ fs: fsStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        const files = dl.getAllFiles('/dir')
        expect(files).to.include('/dir/file.txt')
        expect(files).to.include('/dir/subdir/nested.txt')
    })
})
