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

// The CLI self-update checks itself out at a release tag; this is the gate
// that proves the release key cut that tag. A real repo and real signed
// tags, for the same reason as above: the failure modes live inside git
// and gpg (a tag by any trusted key passing, the human-readable verdict
// read instead of the status protocol, an unsigned tag exiting zero).
function createSignedRepo() {
    const key   = makeKeyring('xchain-test-tag-release')
    const other = makeKeyring('xchain-test-tag-impostor')
    const repo  = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-tagrepo-'))
    const gitIn = (args, env = {}) => execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }
    })
    const signedTag = (name, signer) => gitIn([
        '-c', `user.signingkey=${signer.fingerprint}`, '-c', 'gpg.program=gpg',
        '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
        'tag', '-s', '-m', name, name
    ], { GNUPGHOME: signer.home })

    gitIn(['init', '-q'])
    fs.writeFileSync(path.join(repo, 'f'), 'x')
    gitIn(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', 'f'])
    gitIn(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one'])
    signedTag('v9.9.9', key)
    signedTag('v9.9.8', other)
    // A developer's global git config may sign every tag; this one must
    // stay a plain lightweight tag to be the "unsigned" case.
    gitIn(['-c', 'tag.gpgSign=false', 'tag', 'v9.9.7'])
    return { key, other, repo }
}

function cleanup({ key, other, repo } = {}) {
    if (key)   key.cleanup()
    if (other) other.cleanup()
    if (repo)  fs.rmSync(repo, { recursive: true, force: true })
}

describe('ReleaseSignatureService', () => {
    describe('verifyGitTagSignature()', () => {
        let context

        before(function () {
            if (!gpgAvailable()) return this.skip()
            this.timeout(30000)
            context = createSignedRepo()
        })
        after(() => cleanup(context))

        it('accepts a tag signed by the pinned key', () => {
            const { key, repo } = context
            const result = svc.verifyGitTagSignature({ repoDir: repo, tag: 'v9.9.9', keyPath: key.keyPath, fingerprint: key.fingerprint })
            expect(result.fingerprint).to.equal(key.fingerprint)
        })

        it('refuses a tag signed by another key, even a valid one', () => {
            const { key, repo } = context
            expect(() => svc.verifyGitTagSignature({ repoDir: repo, tag: 'v9.9.8', keyPath: key.keyPath, fingerprint: key.fingerprint }))
                .to.throw(svc.ReleaseIntegrityError, /not verify against the pinned release key|not by the pinned release key|good signature/)
        })

        it('refuses an unsigned (lightweight) tag', () => {
            const { key, repo } = context
            expect(() => svc.verifyGitTagSignature({ repoDir: repo, tag: 'v9.9.7', keyPath: key.keyPath, fingerprint: key.fingerprint }))
                .to.throw(svc.ReleaseIntegrityError)
        })
    })
})

describe('ReleaseSignatureService', () => {
    describe('verifyGitTagSignature()', () => {
        let context

        before(function () {
            if (!gpgAvailable()) return this.skip()
            this.timeout(30000)
            context = createSignedRepo()
        })
        after(() => cleanup(context))

        it('refuses a tag that does not exist', () => {
            const { key, repo } = context
            expect(() => svc.verifyGitTagSignature({ repoDir: repo, tag: 'v0.0.0', keyPath: key.keyPath, fingerprint: key.fingerprint }))
                .to.throw(svc.ReleaseIntegrityError)
        })

        it('refuses when the pinned key file is missing', () => {
            const { key, repo } = context
            expect(() => svc.verifyGitTagSignature({ repoDir: repo, tag: 'v9.9.9', keyPath: path.join(repo, 'nope.asc'), fingerprint: key.fingerprint }))
                .to.throw(svc.ReleaseIntegrityError, /No release signing key/)
        })
    })
})
