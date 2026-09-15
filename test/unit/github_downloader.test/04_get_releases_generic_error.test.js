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
    makeAxiosStub
} = require('./support/helpers')

function downloaderSuite(title, tests) {
    describe('GitHubDownloader', function () {
        describe(title, tests)
    })
}

downloaderSuite('getReleases(): generic error', function () {

    it('throws with generic error message on non-404 errors', async function () {
        const axiosStub = makeAxiosStub()
        const err = new Error('Network Error')
        axiosStub.get.rejects(err)
        const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        try {
            await dl.getReleases('owner', 'repo')
            expect.fail()
        } catch (e) {
            expect(e.message).to.include('GitHub API Error')
        }
    })
})
