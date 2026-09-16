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

let key
const manifestBytes = Buffer.from('{"platform_version":"0.9.0","components":{}}')
const silent = { log() {}, warn() {} }

function assets({ sums, sig }) {
    return name => Promise.resolve(name === 'SHA256SUMS' ? sums : name === 'SHA256SUMS.asc' ? sig : null)
}

function signedSet(bytes, signer = key) {
    const sums = Buffer.from(`${digestOf(bytes)}  release-manifest.json\n`)
    return { sums, sig: signer.sign(sums) }
}

// The scratch key stands in for the platform key. Everything else about
// the gate is the real path: real gpg, real status parsing, real digest
// comparison. No install passes these, which is why they default.
function verify(fetchAsset, bytes = manifestBytes) {
    return svc.verifyManifestForTag({
        tag: 'v0.9.0', manifestBytes: bytes, fetchAsset, logger: silent,
        keyPath: key.keyPath, fingerprint: key.fingerprint
    })
}

function prepareKey() {
    key = makeKeyring('xchain-test-train')
}

function cleanupKey() {
    if (key) key.cleanup()
    key = null
}

describe('ReleaseSignatureService', () => {
    afterEach(() => { delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_RELEASE })

    describe('verifyManifestForTag()', () => {
        before(function () {
            if (!gpgAvailable()) return this.skip()
            this.timeout(30000)
            prepareKey()
        })
        after(cleanupKey)

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
    })
})

describe('ReleaseSignatureService', () => {
    afterEach(() => { delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_RELEASE })

    describe('verifyManifestForTag()', () => {
        before(function () {
            if (!gpgAvailable()) return this.skip()
            this.timeout(30000)
            prepareKey()
        })
        after(cleanupKey)

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
