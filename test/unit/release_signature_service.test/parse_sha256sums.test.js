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

const svc = require('../../../src/services/release_signature_service')

describe('ReleaseSignatureService', () => {
    describe('parseSha256sums()', () => {
        it('reads coreutils text and binary mode lines', () => {
            const entries = svc.parseSha256sums(
                `${'a'.repeat(64)}  release-manifest.json\n${'b'.repeat(64)} *xchain-vm-0.9.0.tar.gz\n`
            )
            expect(entries.get('release-manifest.json')).to.equal('a'.repeat(64))
            expect(entries.get('xchain-vm-0.9.0.tar.gz')).to.equal('b'.repeat(64))
        })

        it('lowercases digests so comparison never depends on case', () => {
            const entries = svc.parseSha256sums(`${'A'.repeat(64)}  file\n`)
            expect(entries.get('file')).to.equal('a'.repeat(64))
        })

        it('REFUSES a malformed line instead of skipping it', () => {
            // A skipped line is an artifact that silently stops being checked.
            expect(() => svc.parseSha256sums(`${'a'.repeat(64)}  ok\nnot a digest line\n`))
                .to.throw(svc.ReleaseIntegrityError, /line 2 is malformed/)
        })

        it('REFUSES a duplicated filename rather than letting the last win', () => {
            expect(() => svc.parseSha256sums(`${'a'.repeat(64)}  f\n${'b'.repeat(64)}  f\n`))
                .to.throw(svc.ReleaseIntegrityError, /more than once/)
        })

        it('REFUSES an empty digest file', () => {
            expect(() => svc.parseSha256sums('\n\n')).to.throw(svc.ReleaseIntegrityError, /empty/)
        })

        it('tolerates CRLF, which a digest file round-tripped through Windows carries', () => {
            const entries = svc.parseSha256sums(`${'a'.repeat(64)}  file\r\n`)
            expect(entries.get('file')).to.equal('a'.repeat(64))
        })
    })
})
