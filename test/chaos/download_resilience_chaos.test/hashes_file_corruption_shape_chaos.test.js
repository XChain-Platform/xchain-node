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
const { validHash, validHashesData, makeAxiosStub, loadDownloader } = require('./helpers')

describe('Chaos: Download Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

describe('Experiment 8f: Hashes file corruption', function () {

        it('throws on invalid hash format (non-hex characters)', function () {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                readFileSync: sinon.stub().returns(JSON.stringify({
                    'owner/repo': { 'v1.0.0': 'g'.repeat(64) }
                })),
                statSync: sinon.stub().returns({ isFile: () => true, isDirectory: () => false })
            }
            const { GitHubDownloader } = loadDownloader({ fs: fsStub })

            expect(() => new GitHubDownloader('/test/hashes.json')).to.throw('Invalid SHA-256 hash')
        })

        it('throws on non-object version entry', function () {
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
})
