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
const proxyquire = require('proxyquire').noCallThru()

function makeStubs() {
    return {
        axiosGet: sinon.stub(),
        readFileSync: sinon.stub().throws(new Error('ENOENT')),
        // Stub cryptographic verification so these cases isolate manifest
        // resolution while still asserting the verification call.
        verifyManifestForTag: sinon.stub().resolves({ verified: true, fingerprint: 'F'.repeat(40) })
    }
}

function load(stubs) {
    return proxyquire('../../../src/services/release_manifest_service', {
        'fs':    { readFileSync: stubs.readFileSync },
        'axios': { get: stubs.axiosGet },
        './github_downloader': {
            githubApiHeaders:     () => ({}),
            githubRateLimitError: () => null
        },
        './release_signature_service': {
            verifyManifestForTag: stubs.verifyManifestForTag
        }
    })
}

let stubs, svc

function serviceSuite(title, tests) {
    describe('ReleaseManifestService', () => {
        beforeEach(() => {
            stubs = makeStubs()
            svc   = load(stubs)
        })
        afterEach(() => {
            svc.clearActiveTarget()
            sinon.restore()
        })
        describe(title, tests)
    })
}

// Require every shipped component pin to resolve to a usable tag and commit.
const shipped = require('../../../src/release-manifest.json')
const real    = proxyquire('../../../src/services/release_manifest_service', {
    './github_downloader': { githubApiHeaders: () => ({}), githubRateLimitError: () => null }
})

serviceSuite('the shipped manifest', () => {
    it('declares a platform version and a release date', () => {
        expect(shipped.platform_version).to.match(/^\d+\.\d+\.\d+$/)
        expect(shipped.released).to.match(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('pins every component to a tag and a full 40-hex commit', () => {
        expect(real.manifestHasPins(shipped)).to.equal(true)
        for (const name of Object.keys(shipped.components)) {
            const pin = real.getComponentPin(shipped, name)
            expect(pin, `${name} must resolve`).to.not.equal(null)
            expect(pin.commit, `${name} commit`).to.match(/^[0-9a-f]{40}$/)
            expect(pin.tag, `${name} tag`).to.match(/^v\d+\.\d+\.\d+$/)
        }
    })
})

serviceSuite('the shipped manifest', () => {
    it('pins no component above the platform version it ships in', () => {
        // Permit tags below the platform version because unchanged components
        // retain their latest release tag; reject only tags above the train.
        const rank = (v) => v.replace(/^v/, '').split('.').map(Number)
        const above = (a, b) => {
            const [x, y, z] = rank(a), [p, q, r] = rank(b)
            return x !== p ? x > p : y !== q ? y > q : z > r
        }
        for (const [name, pin] of Object.entries(shipped.components)) {
            expect(above(pin.tag, shipped.platform_version),
                `${name} pinned at ${pin.tag}, above the ${shipped.platform_version} train`
            ).to.equal(false)
        }
    })

    it('does not pin xchain-node itself', () => {
        // node is the carrier: checking out its tag IS this manifest, so listing
        // it would be a self-reference that can never be written before the fact.
        expect(shipped.components['xchain-node']).to.equal(undefined)
    })
})
