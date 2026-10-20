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

downloaderSuite('getReleaseByTag(): error', function () {

    it('throws with descriptive message on error', async function () {
        const axiosStub = makeAxiosStub()
        axiosStub.get.rejects(new Error('Not Found'))
        const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        try {
            await dl.getReleaseByTag('owner', 'repo', 'v1.0.0')
            expect.fail()
        } catch (e) {
            expect(e.message).to.include('Error getting the release')
        }
    })
})

downloaderSuite('getReleaseByTag(): missing tag', function () {

    it('names a missing tag on a 404 and keeps a 5xx generic', async function () {
        const axiosStub = makeAxiosStub()
        const notFound = Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } })
        const outage = Object.assign(new Error('Request failed with status code 502'), { response: { status: 502 } })
        axiosStub.get.onFirstCall().rejects(notFound).onSecondCall().rejects(outage)
        const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
        const dl = new GitHubDownloader('/test/hashes.json')
        const missing = await dl.getReleaseByTag('dogecoin', 'dogecoin', '1.14.9').catch(e => e)
        expect(missing.message).to.include('Error getting the release 1.14.9')
        expect(missing.message).to.include('dogecoin/dogecoin has no release tagged 1.14.9')
        const failed = await dl.getReleaseByTag('dogecoin', 'dogecoin', 'v1.14.9').catch(e => e)
        expect(failed.message).to.equal('Error getting the release v1.14.9: Request failed with status code 502')
    })

    it('encodes the tag as one URL path segment', async function () {
        const axiosStub = makeAxiosStub()
        axiosStub.get.resolves({ data: {} })
        const { GitHubDownloader } = loadDownloader({ axios: axiosStub })
        await new GitHubDownloader('/test/hashes.json').getReleaseByTag('owner', 'repo', 'v1/../x?y')
        expect(axiosStub.get.firstCall.args[0]).to.equal('https://api.github.com/repos/owner/repo/releases/tags/v1%2F..%2Fx%3Fy')
    })
})
