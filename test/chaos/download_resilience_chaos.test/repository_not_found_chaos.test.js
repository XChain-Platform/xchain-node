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

    // Experiment: Repository not found (404)
    describe('Experiment: Repository not found', function () {

        it('throws descriptive 404 error for non-existent repository', async function () {
            const axiosStub = makeAxiosStub()
            const err = new Error('Not Found')
            err.response = { status: 404 }
            axiosStub.get.rejects(err)

            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')

            try {
                await dl.getReleases('nonexistent', 'repo')
                expect.fail('should have thrown')
            } catch (e) {
                expect(e.message).to.include("Can't find")
                expect(e.message).to.include('nonexistent/repo')
            }
        })
    })
})
