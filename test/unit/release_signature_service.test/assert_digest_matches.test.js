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

const crypto = require('crypto')
const { expect } = require('chai')

const svc = require('../../../src/services/release_signature_service')

const digestOf = buf => crypto.createHash('sha256').update(buf).digest('hex')

describe('ReleaseSignatureService', () => {
    describe('assertDigestMatches()', () => {
        const bytes = Buffer.from('{"platform_version":"0.9.0"}')

        it('passes when the artifact matches its signed digest', () => {
            const sums = `${digestOf(bytes)}  release-manifest.json\n`
            expect(() => svc.assertDigestMatches({ sumsText: sums, bytes, name: 'release-manifest.json' }))
                .to.not.throw()
        })

        it('REFUSES an artifact the digest file does not list', () => {
            const sums = `${digestOf(bytes)}  something-else\n`
            expect(() => svc.assertDigestMatches({ sumsText: sums, bytes, name: 'release-manifest.json' }))
                .to.throw(svc.ReleaseIntegrityError, /does not list 'release-manifest.json'/)
        })

        it('REFUSES a tampered artifact', () => {
            const sums = `${digestOf(bytes)}  release-manifest.json\n`
            const tampered = Buffer.from('{"platform_version":"0.9.0"} ')
            expect(() => svc.assertDigestMatches({ sumsText: sums, bytes: tampered, name: 'release-manifest.json' }))
                .to.throw(svc.ReleaseIntegrityError, /does not match the signed digest/)
        })
    })
})
