'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs')
const path = require('path')
const { expect } = require('chai')

const {
    PLATFORM_KEY_FINGERPRINT,
    KEY_PATH,
    SUMS_ASSET,
    SIG_ASSET,
    MANIFEST_ASSET,
    ReleaseIntegrityError
} = require('../../../../src/services/release_signature_service/release_assets')

describe('release_assets', function () {
    it('pins a forty-character upper-case hexadecimal fingerprint', function () {
        expect(PLATFORM_KEY_FINGERPRINT).to.match(/^[0-9A-F]{40}$/)
    })

    it('points to the shipped release signing key', function () {
        expect(path.isAbsolute(KEY_PATH)).to.equal(true)
        expect(KEY_PATH).to.match(/release-signing-key\.asc$/)
        expect(fs.existsSync(KEY_PATH)).to.equal(true)
    })

    it('names the release integrity assets', function () {
        expect([SUMS_ASSET, SIG_ASSET, MANIFEST_ASSET]).to.deep.equal([
            'SHA256SUMS',
            'SHA256SUMS.asc',
            'release-manifest.json'
        ])
    })

    it('provides an Error subclass that preserves its name and message', function () {
        const error = new ReleaseIntegrityError('integrity check failed')

        expect(error).to.be.instanceOf(ReleaseIntegrityError)
        expect(error).to.be.instanceOf(Error)
        expect(error.name).to.equal('ReleaseIntegrityError')
        expect(error.message).to.equal('integrity check failed')
    })
})
