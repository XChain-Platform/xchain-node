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

const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const { execFileSync } = require('child_process')
const { expect } = require('chai')

const svc = require('../../src/services/release_signature_service')

function gpgAvailable() {
    try {
        execFileSync('gpg', ['--version'], { stdio: 'ignore' })
        return true
    } catch {
        return false
    }
}

describe('ReleaseSignatureService', () => {
    describe('the pinned trust anchor', () => {
        it('ships the release key inside this repo', () => {
            // Fetching the key at verification time would prove nothing: the
            // anchor has to travel with the code.
            expect(fs.existsSync(svc.KEY_PATH)).to.equal(true)
            expect(fs.readFileSync(svc.KEY_PATH, 'utf8')).to.match(/^-----BEGIN PGP PUBLIC KEY BLOCK-----/)
        })

        it('pins the PLATFORM key, and it is the key the shipped file contains', function () {
            if (!gpgAvailable()) return this.skip()

            // Two channels compared by a test rather than one generated from the
            // other: the constant is written out by hand from the published
            // fingerprint, the file is the key itself.
            const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-anchor-'))
            fs.chmodSync(home, 0o700)
            try {
                execFileSync('gpg', ['--batch', '--no-tty', '--quiet', '--homedir', home, '--import', svc.KEY_PATH],
                    { stdio: ['ignore', 'pipe', 'pipe'] })
                const colons = execFileSync('gpg', [
                    '--batch', '--no-tty', '--homedir', home, '--with-colons', '--fingerprint', '--list-keys'
                ], { encoding: 'utf8' })
                const fingerprints = colons.split('\n').filter(l => l.startsWith('fpr:')).map(l => l.split(':')[9])
                expect(fingerprints).to.include(svc.PLATFORM_KEY_FINGERPRINT)
            } finally {
                fs.rmSync(home, { recursive: true, force: true })
            }
        })

        it('is NOT the wallet key (the named confusion hazard)', () => {
            // wallet-release-rails.md names three keys and requires anything
            // saying "the release key" to say which one. K1 and K14 sign the
            // wallet; this constant must never drift onto either.
            expect(svc.PLATFORM_KEY_FINGERPRINT).to.equal('1DA7C4896F56EA22CF491EDF4361611A82F90B70')
        })
    })
})

require('./release_signature_service.test/parse_sha256sums.test')
require('./release_signature_service.test/assert_digest_matches.test')
require('./release_signature_service.test/verify_detached_signature.test')
require('./release_signature_service.test/verify_git_tag_signature.test')
require('./release_signature_service.test/verify_manifest_for_tag.test')
