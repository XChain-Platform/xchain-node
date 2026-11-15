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

const { expect } = require('chai')
const { githubRateLimitError } = require('../../../src/utils/github_api')

function failure(status, headers) {
    const err = new Error('Request failed with status code ' + status)
    err.response = { status, headers }
    return err
}

describe('githubRateLimitError', function () {

    it('maps a primary-limit 403 to the reset time and token advice', function () {
        const e = githubRateLimitError(failure(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1783529945' }))
        expect(e.message).to.include(new Date(1783529945 * 1000).toISOString())
        expect(e.message).to.include('GITHUB_TOKEN')
    })

    it('maps a 429 with no headers to a rate limit with an unknown reset', function () {
        const e = githubRateLimitError(failure(429, undefined))
        expect(e.message).to.include('rate limit exhausted')
        expect(e.message).to.include('resets unknown')
    })

    it('maps a 429 to the reset time named by x-ratelimit-reset', function () {
        const e = githubRateLimitError(failure(429, { 'x-ratelimit-reset': '1783529945' }))
        expect(e.message).to.include(new Date(1783529945 * 1000).toISOString())
    })

    it('takes the reset from retry-after seconds when x-ratelimit-reset is absent', function () {
        const before = Date.now()
        const e = githubRateLimitError(failure(429, { 'retry-after': '60' }))
        const stamp = Date.parse(/resets (\S+)\)/.exec(e.message)[1])
        expect(stamp).to.be.within(before + 60000, Date.now() + 60000)
    })

    it('takes the reset from a retry-after HTTP date', function () {
        const e = githubRateLimitError(failure(403, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))
        expect(e.message).to.include('2026-10-21T07:28:00.000Z')
    })

    it('treats a 403 carrying retry-after as a secondary limit', function () {
        const e = githubRateLimitError(failure(403, { 'retry-after': '30' }))
        expect(e).to.be.instanceOf(Error)
        expect(e.message).to.include('GITHUB_TOKEN')
    })

    it('reports an unparseable retry-after as an unknown reset', function () {
        const e = githubRateLimitError(failure(429, { 'retry-after': 'soon' }))
        expect(e.message).to.include('resets unknown')
    })

})

describe('githubRateLimitError', function () {

    it('prefers retry-after over a primary-window x-ratelimit-reset on a secondary limit', function () {
        const farReset = String(Math.floor(Date.now() / 1000) + 3000)
        const before = Date.now()
        const e = githubRateLimitError(failure(429, {
            'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': farReset, 'retry-after': '60'
        }))
        const stamp = Date.parse(/resets (\S+)\)/.exec(e.message)[1])
        expect(stamp).to.be.within(before + 60000, Date.now() + 60000)
    })

    it('prefers retry-after even when quota is exhausted and both headers are present', function () {
        const farReset = String(Math.floor(Date.now() / 1000) + 3000)
        const before = Date.now()
        const e = githubRateLimitError(failure(403, {
            'x-ratelimit-remaining': '0', 'x-ratelimit-reset': farReset, 'retry-after': '10'
        }))
        const stamp = Date.parse(/resets (\S+)\)/.exec(e.message)[1])
        expect(stamp).to.be.within(before + 10000, Date.now() + 10000)
    })

    it('does not use x-ratelimit-reset when quota remains and retry-after is absent', function () {
        const e = githubRateLimitError(failure(429, { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '1783529945' }))
        expect(e.message).to.include('resets unknown')
    })

    it('reports a zero x-ratelimit-reset as an unknown reset rather than 1970', function () {
        const e = githubRateLimitError(failure(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' }))
        expect(e.message).to.include('resets unknown')
    })

    it('leaves a 403 with quota remaining and no retry-after alone', function () {
        expect(githubRateLimitError(failure(403, { 'x-ratelimit-remaining': '42' }))).to.equal(null)
        expect(githubRateLimitError(failure(403, undefined))).to.equal(null)
    })

    it('leaves other statuses and response-less errors alone', function () {
        expect(githubRateLimitError(failure(500, { 'retry-after': '5' }))).to.equal(null)
        expect(githubRateLimitError(failure(404, { 'x-ratelimit-remaining': '0' }))).to.equal(null)
        expect(githubRateLimitError(new Error('socket hang up'))).to.equal(null)
    })
})
