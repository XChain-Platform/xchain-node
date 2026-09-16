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

    // Experiment 8d: No compatible version found
    describe('Experiment 8d: No compatible version available', function () {

        it('throws when no release has a matching hash entry', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.get.resolves({
                data: [
                    { tag_name: 'v3.0.0', published_at: '2025-06-01T00:00:00Z' },
                    { tag_name: 'v2.0.0', published_at: '2025-05-01T00:00:00Z' }
                ]
            })

            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')

            try {
                await dl.getLatestCompatibleVersion('owner', 'repo', true)
                expect.fail('should have thrown')
            } catch (e) {
                expect(e.message).to.include('hashes file')
            }
        })

        it('returns latest release when hash verification is disabled', async function () {
            const axiosStub = makeAxiosStub()
            axiosStub.get.resolves({
                data: [
                    { tag_name: 'v3.0.0', published_at: '2025-06-01T00:00:00Z' },
                    { tag_name: 'v2.0.0', published_at: '2025-05-01T00:00:00Z' }
                ]
            })

            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')

            const result = await dl.getLatestCompatibleVersion('owner', 'repo', false)
            expect(result.tag_name).to.equal('v3.0.0')
        })
    })
})
