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
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { expect } = require('chai')

const svc = require('../../../src/services/release_signature_service')

// A real gpg key, generated once per run into a scratch homedir. The gate is
// "does a signature by the pinned key pass and a signature by any other key
// fail", and that question cannot be answered with a stubbed verifier: every
// bug this file is here to catch (accepting any key in the keyring, reading the
// prose instead of the status protocol, treating exit 0 as the verdict) lives
// inside the gpg call itself.
function makeKeyring(name) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-testkey-'))
    fs.chmodSync(home, 0o700)
    // Unprotected key, generated non-interactively: loopback pinentry with an
    // empty passphrase is what stops gpg reaching for a tty it does not have.
    execFileSync('gpg', [
        '--batch', '--no-tty', '--quiet', '--homedir', home,
        '--pinentry-mode', 'loopback', '--passphrase', '',
        '--quick-generate-key', `${name} <${name}@example.invalid>`, 'ed25519', 'sign', 'never'
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    const colons = execFileSync('gpg', [
        '--batch', '--no-tty', '--homedir', home, '--with-colons', '--fingerprint', '--list-keys'
    ], { encoding: 'utf8' })
    const fingerprint = colons.split('\n').find(line => line.startsWith('fpr:')).split(':')[9]

    const keyPath = path.join(home, 'public.asc')
    fs.writeFileSync(keyPath, execFileSync('gpg', [
        '--batch', '--no-tty', '--homedir', home, '--armor', '--export', fingerprint
    ], { encoding: 'utf8' }))

    return {
        home,
        fingerprint,
        keyPath,
        sign(data) {
            const dataPath = path.join(home, `data-${crypto.randomBytes(4).toString('hex')}`)
            fs.writeFileSync(dataPath, data)
            return execFileSync('gpg', [
                '--batch', '--yes', '--no-tty', '--homedir', home,
                '--local-user', fingerprint, '--armor', '--detach-sign', '--output', '-', dataPath
            ])
        },
        cleanup() { fs.rmSync(home, { recursive: true, force: true }) }
    }
}

function gpgAvailable() {
    try {
        execFileSync('gpg', ['--version'], { stdio: 'ignore' })
        return true
    } catch {
        return false
    }
}

describe('ReleaseSignatureService', () => {
    afterEach(() => {
        delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_RELEASE
    })

    describe('verifyDetachedSignature()', () => {
        let key, other

        before(function () {
            if (!gpgAvailable()) return this.skip()
            this.timeout(30000)
            key   = makeKeyring('xchain-test-release')
            other = makeKeyring('xchain-test-impostor')
        })

        after(() => {
            if (key)   key.cleanup()
            if (other) other.cleanup()
        })

        it('accepts a signature by the pinned key', () => {
            const data = Buffer.from('digest file\n')
            const result = svc.verifyDetachedSignature({
                data, signature: key.sign(data), keyPath: key.keyPath, fingerprint: key.fingerprint
            })
            expect(result.fingerprint).to.equal(key.fingerprint)
        })

        it('accepts a fingerprint written with the spaced grouping people copy from docs', () => {
            const data    = Buffer.from('digest file\n')
            const spaced  = key.fingerprint.replace(/(.{4})/g, '$1 ').trim()
            expect(svc.verifyDetachedSignature({
                data, signature: key.sign(data), keyPath: key.keyPath, fingerprint: spaced
            }).fingerprint).to.equal(key.fingerprint)
        })

        it('REFUSES a valid signature made by a DIFFERENT key', () => {
            // The bug this exists for: `gpg --verify` succeeding only says some
            // key in the keyring signed it. Here the impostor's key is the one
            // imported, so gpg is perfectly happy and the pin is the only thing
            // that refuses.
            const data = Buffer.from('digest file\n')
            expect(() => svc.verifyDetachedSignature({
                data, signature: other.sign(data), keyPath: other.keyPath, fingerprint: key.fingerprint
            })).to.throw(svc.ReleaseIntegrityError, /not by the pinned release key/)
        })

        it('REFUSES a signature over different bytes', () => {
            const signature = key.sign(Buffer.from('the real digest file\n'))
            expect(() => svc.verifyDetachedSignature({
                data: Buffer.from('a swapped digest file\n'),
                signature, keyPath: key.keyPath, fingerprint: key.fingerprint
            })).to.throw(svc.ReleaseIntegrityError, /does not verify against the pinned release key/)
        })
    })
})

describe('ReleaseSignatureService', () => {
    afterEach(() => {
        delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_RELEASE
    })

    describe('verifyDetachedSignature()', () => {
        let key, other

        before(function () {
            if (!gpgAvailable()) return this.skip()
            this.timeout(30000)
            key   = makeKeyring('xchain-test-release')
            other = makeKeyring('xchain-test-impostor')
        })

        after(() => {
            if (key)   key.cleanup()
            if (other) other.cleanup()
        })

        it('REFUSES a signature whose key is not in the shipped anchor at all', () => {
            const data = Buffer.from('digest file\n')
            expect(() => svc.verifyDetachedSignature({
                data, signature: other.sign(data), keyPath: key.keyPath, fingerprint: key.fingerprint
            })).to.throw(svc.ReleaseIntegrityError, /does not verify against the pinned release key/)
        })

        it('REFUSES when the trust anchor is missing', () => {
            expect(() => svc.verifyDetachedSignature({
                data: Buffer.from('x'), signature: Buffer.from('x'),
                keyPath: path.join(os.tmpdir(), 'no-such-key.asc'), fingerprint: key.fingerprint
            })).to.throw(svc.ReleaseIntegrityError, /No release signing key is shipped/)
        })

        it('REFUSES a fingerprint pin that is not 40 hex', () => {
            // Guards against a placeholder ("UNPINNED", an empty file) reading
            // as configured. Checked before anything is executed.
            expect(() => svc.verifyDetachedSignature({
                data: Buffer.from('x'), signature: Buffer.from('x'), fingerprint: 'UNPINNED'
            })).to.throw(svc.ReleaseIntegrityError, /not pinned to a 40-hex fingerprint/)
        })

        it('REFUSES when gpg itself is unavailable rather than passing', () => {
            const data = Buffer.from('digest file\n')
            process.env.XCHAIN_NODE_GPG_BIN = path.join(os.tmpdir(), 'definitely-not-gpg')
            try {
                expect(() => svc.verifyDetachedSignature({
                    data, signature: Buffer.from('x'), keyPath: key.keyPath, fingerprint: key.fingerprint
                })).to.throw(svc.ReleaseIntegrityError, /gpg is not installed/)
            } finally {
                delete process.env.XCHAIN_NODE_GPG_BIN
            }
        })
    })
})
