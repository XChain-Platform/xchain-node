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

const svc = require('../../src/services/ReleaseSignatureService')

const digestOf = buf => crypto.createHash('sha256').update(buf).digest('hex')

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

    describe('verifyManifestForTag()', () => {
        let key
        const manifestBytes = Buffer.from('{"platform_version":"0.9.0","components":{}}')

        before(function () {
            if (!gpgAvailable()) return this.skip()
            this.timeout(30000)
            key = makeKeyring('xchain-test-train')
        })

        after(() => { if (key) key.cleanup() })

        function assets({ sums, sig }) {
            return name => Promise.resolve(name === 'SHA256SUMS' ? sums : name === 'SHA256SUMS.asc' ? sig : null)
        }

        function signedSet(bytes, signer = key) {
            const sums = Buffer.from(`${digestOf(bytes)}  release-manifest.json\n`)
            return { sums, sig: signer.sign(sums) }
        }

        const silent = { log() {}, warn() {} }

        // The scratch key stands in for the platform key. Everything else about
        // the gate is the real path: real gpg, real status parsing, real digest
        // comparison. No install passes these, which is why they default.
        function verify(fetchAsset, bytes = manifestBytes) {
            return svc.verifyManifestForTag({
                tag: 'v0.9.0', manifestBytes: bytes, fetchAsset, logger: silent,
                keyPath: key.keyPath, fingerprint: key.fingerprint
            })
        }

        it('verifies signature THEN digest, and reports the key', async () => {
            const set = signedSet(manifestBytes)
            const result = await verify(assets(set))
            expect(result.verified).to.equal(true)
            expect(result.fingerprint).to.equal(key.fingerprint)
        }).timeout(10000)

        it('REFUSES a release that publishes no signature', async () => {
            await verify(name => Promise.resolve(name === 'SHA256SUMS' ? Buffer.from('x') : null))
                .then(() => { throw new Error('should have refused') },
                      err => expect(err.message).to.match(/publishes no SHA256SUMS\.asc/))
        })

        it('REFUSES a release that publishes no digest file', async () => {
            await verify(() => Promise.resolve(null))
                .then(() => { throw new Error('should have refused') },
                      err => expect(err.message).to.match(/publishes no SHA256SUMS and SHA256SUMS\.asc/))
        })

        it('REFUSES when the asset fetch itself fails', async () => {
            await verify(() => Promise.reject(new Error('network down')))
                .then(() => { throw new Error('should have refused') },
                      err => expect(err.message).to.match(/Could not fetch the signed digest files.*network down/))
        })

        it('names the opt-out in every refusal, so the airgapped path is discoverable', async () => {
            await verify(() => Promise.resolve(null))
                .then(() => { throw new Error('should have refused') },
                      err => expect(err.message).to.match(/XCHAIN_NODE_REQUIRE_SIGNED_RELEASE=0/))
        })

        it('the opt-out downgrades a refusal to a LOUD warning', async () => {
            process.env.XCHAIN_NODE_REQUIRE_SIGNED_RELEASE = '0'
            const warnings = []
            const result = await svc.verifyManifestForTag({
                tag: 'v0.9.0',
                manifestBytes,
                fetchAsset: () => Promise.resolve(null),
                logger: { log() {}, warn: msg => warnings.push(msg) }
            })
            expect(result.verified).to.equal(false)
            expect(warnings).to.have.length(1)
            expect(warnings[0]).to.match(/WITHOUT release signature verification/)
            expect(warnings[0]).to.match(/provenance is unproven/)
        })

        it('the opt-out is only the explicit falsy values, never any set value', async () => {
            // `XCHAIN_NODE_REQUIRE_SIGNED_RELEASE=1` must not read as "an
            // override is present, so skip the check".
            process.env.XCHAIN_NODE_REQUIRE_SIGNED_RELEASE = '1'
            expect(svc.signatureCheckDisabled()).to.equal(false)
            await verify(() => Promise.resolve(null))
                .then(() => { throw new Error('should have refused') },
                      err => expect(err).to.be.instanceOf(svc.ReleaseIntegrityError))
        })

        it('REFUSES a manifest whose digest is not the signed one', async function () {
            this.timeout(10000)
            // Correctly signed digest file, swapped manifest: exactly the shape
            // of an attack that reuses a real release's signature.
            const set = signedSet(Buffer.from('{"platform_version":"0.9.0","components":{"evil":1}}'))
            await verify(assets(set))
                .then(() => { throw new Error('should have refused') },
                      err => expect(err.message).to.match(/does not match the signed digest/))
        })

        it('REFUSES a digest file signed by an impostor key', async function () {
            this.timeout(30000)
            const impostor = makeKeyring('xchain-test-impostor2')
            try {
                await verify(assets(signedSet(manifestBytes, impostor)))
                    .then(() => { throw new Error('should have refused') },
                          err => expect(err).to.be.instanceOf(svc.ReleaseIntegrityError))
            } finally {
                impostor.cleanup()
            }
        })
    })
})
