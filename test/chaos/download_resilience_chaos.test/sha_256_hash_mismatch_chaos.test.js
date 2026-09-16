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

const sinon      = require('sinon')
const { expect } = require('chai')
const crypto     = require('crypto')
const { validHash, validHashesData, makeAxiosStub, loadDownloader } = require('./helpers')

describe('Chaos: Download Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // Experiment 8c: Hash mismatch (NET-03)
    describe('Experiment 8c: SHA-256 hash mismatch', function () {

        it('throws with expected vs actual hash on mismatch', async function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('github_hashes.json') || p === '/test/hashes.json') {
                        return JSON.stringify(validHashesData)
                    }
                    return Buffer.from('actual-content-that-wont-match')
                }),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([])
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')

            try {
                await dl.verifyRepositoryHash('owner/repo', 'v1.0.0', '/path/to/download')
                expect.fail('should have thrown')
            } catch (e) {
                expect(e.message).to.include('Hash verification failed')
                expect(e.message).to.include('Expected:')
                expect(e.message).to.include('Actual:')
                expect(e.message).to.include(validHash)
            }
        })

        it('succeeds when hash matches exactly', async function () {
            const content = Buffer.from('known-content')
            const expectedHash = crypto.createHash('sha256').update(content).digest('hex')
            const customHashes = { 'owner/repo': { 'v1.0.0': expectedHash } }

            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().callsFake((p) => {
                    if (p.endsWith('github_hashes.json') || p === '/test/hashes.json') {
                        return JSON.stringify(customHashes)
                    }
                    return content
                }),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false }),
                readdirSync: sinon.stub().returns([])
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })
            const dl = new GitHubDownloader('/test/hashes.json')

            // Should not throw
            await dl.verifyRepositoryHash('owner/repo', 'v1.0.0', '/path/to/download')
        })
    })
})
