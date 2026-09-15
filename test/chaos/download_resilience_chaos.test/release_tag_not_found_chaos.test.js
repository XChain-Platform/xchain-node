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

    // Experiment 8e: getReleaseByTag failure
    describe('Experiment 8e: Release tag not found', function () {

        it('throws when specific tag does not exist', async function () {
            const axiosStub = makeAxiosStub()
            const err = new Error('Request failed with status code 404')
            err.response = { status: 404 }
            axiosStub.get.rejects(err)

            const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
            const dl = new GitHubDownloader('/test/hashes.json')

            try {
                await dl.getReleaseByTag('owner', 'repo', 'v99.99.99')
                expect.fail('should have thrown')
            } catch (e) {
                expect(e.message).to.include('Error getting the release')
            }
        })
    })
})
