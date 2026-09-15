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

    // Experiment: downloadRepoVersion cleanup on failure
    describe('Experiment: Download cleanup on failure', function () {

        it('throws when hash is required but not found for version', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.get.resolves({
                data: { tag_name: 'v2.0.0', assets: [] }
            })

            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')

            try {
                await dl.downloadRepoVersion('owner', 'repo', 'v2.0.0', { verifyHash: true })
                expect.fail('should have thrown')
            } catch (e) {
                expect(e.message).to.include('SHA-256 hash not found')
            }
        })
    })
})
