/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - GPG Verification
 ********************************************************************/

const fs       = require('fs')
const os       = require('os')
const path     = require('path')
const { execFileSync, spawnSync } = require('child_process')
const config = require('../../config');
const {
    PLATFORM_KEY_FINGERPRINT,
    KEY_PATH,
    SUMS_ASSET,
    SIG_ASSET,
    ReleaseIntegrityError
} = require('./release_assets.js')

function gpgBinary() {
    return config.XCHAIN_NODE_GPG_BIN
}

function normalizeFingerprint(value) {
    return String(value || '').replace(/\s+/g, '').toUpperCase()
}

function validateFingerprint(fingerprint) {
    const expected = normalizeFingerprint(fingerprint)
    if (!/^[0-9A-F]{40}$/.test(expected)) {
        throw new ReleaseIntegrityError(
            `Release signing key is not pinned to a 40-hex fingerprint (got ${JSON.stringify(fingerprint)}).`
        )
    }
    return expected
}

/**
 * Verify a detached armored signature against the pinned release key.
 *
 * @param {object}  args
 * @param {Buffer}  args.data        the signed bytes (SHA256SUMS)
 * @param {Buffer}  args.signature   the detached armored signature
 * @param {string} [args.keyPath]    trust anchor; defaults to the repo-shipped key
 * @param {string} [args.fingerprint] expected primary key fingerprint
 * @returns {{fingerprint: string}}
 * @throws {ReleaseIntegrityError}
 */
function verifyDetachedSignature({ data, signature, keyPath = KEY_PATH, fingerprint = PLATFORM_KEY_FINGERPRINT }) {
    const expected = validateFingerprint(fingerprint)

    if (!fs.existsSync(keyPath)) {
        throw new ReleaseIntegrityError(
            `No release signing key is shipped at ${keyPath}. The trust anchor must travel with the`
            + ' code; fetching it at verification time proves nothing.'
        )
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-relsig-'))
    const homeDir = path.join(workDir, 'gnupg')
    fs.mkdirSync(homeDir, { mode: 0o700 })

    const dataFile = path.join(workDir, SUMS_ASSET)
    const sigFile  = path.join(workDir, SIG_ASSET)
    fs.writeFileSync(dataFile, data)
    fs.writeFileSync(sigFile, signature)

    const gpg = (args, opts = {}) => execFileSync(gpgBinary(), [
        '--batch', '--no-tty', '--quiet', '--homedir', homeDir, ...args
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

    try {
        try {
            gpg(['--import', keyPath])
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                throw new ReleaseIntegrityError(
                    'gpg is not installed, so this release cannot be verified. Install gnupg, or set'
                    + ' XCHAIN_NODE_REQUIRE_SIGNED_RELEASE=0 to install without provenance checks.'
                )
            }
            throw new ReleaseIntegrityError(`Could not import the pinned release key: ${describeGpgError(err)}`)
        }

        let status = ''
        try {
            // --status-fd 1 puts the machine-readable verdict on stdout. The
            // human-readable text on stderr is advisory; every decision below
            // reads the status lines, because the prose has changed shape
            // between gpg versions and the status protocol has not.
            status = gpg(['--status-fd', '1', '--verify', sigFile, dataFile])
        } catch (err) {
            throw new ReleaseIntegrityError(
                `${SIG_ASSET} does not verify against the pinned release key`
                + ` (${expected}): ${describeGpgError(err)}`
            )
        }

        assertStatusIsGood(status, expected)
        return { fingerprint: expected }
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true })
    }
}

function describeGpgError(err) {
    const detail = [err && err.stderr, err && err.stdout, err && err.message]
        .map(part => (part ? String(part).trim() : ''))
        .filter(Boolean)
        .join(' | ')
    return detail || 'gpg failed with no output'
}

// gpg exiting zero is not the verdict. An expired or revoked key still produces
// a "good" signature line and exit status 0, and a signature made by any other
// key in the keyring would pass a naive check. Bind the result to the pin.
function assertStatusIsGood(status, expected, subject = SIG_ASSET) {
    const lines = String(status).split('\n').map(line => line.trim())
    const flag  = name => lines.some(line => line.startsWith(`[GNUPG:] ${name}`))

    if (flag('REVKEYSIG')) {
        throw new ReleaseIntegrityError(`${subject} was signed with a REVOKED key. Refusing this release.`)
    }
    if (flag('EXPKEYSIG')) {
        throw new ReleaseIntegrityError(`${subject} was signed with an EXPIRED key. Refusing this release.`)
    }
    if (flag('BADSIG') || !flag('GOODSIG')) {
        throw new ReleaseIntegrityError(`${subject} does not carry a good signature.`)
    }

    // VALIDSIG's first field is the fingerprint of the key that made the
    // signature (a subkey, when a subkey signed) and its tenth is the primary
    // key's. Accepting either is what lets the pin stay on the primary key
    // through a future signing-subkey rotation without loosening it.
    const validsig = lines.find(line => line.startsWith('[GNUPG:] VALIDSIG '))
    if (!validsig) {
        throw new ReleaseIntegrityError(`${subject} produced no VALIDSIG line; refusing an unverified release.`)
    }

    const fields = validsig.replace('[GNUPG:] VALIDSIG ', '').split(/\s+/)
    const signing = normalizeFingerprint(fields[0])
    const primary = normalizeFingerprint(fields[9])

    if (signing !== expected && primary !== expected) {
        throw new ReleaseIntegrityError(
            `${subject} is signed, but not by the pinned release key.`
            + ` Expected ${expected}, got ${signing || 'nothing'}.`
            + ' A valid signature by the wrong key is not an official release.'
        )
    }
}

/**
 * Verify a git tag's signature against the pinned release key.
 *
 * Step 1 of the chain in the header, made available to the CLI's own
 * self-update: before the carrier checks itself out at a release tag it
 * proves the release key cut that tag. Same ephemeral-homedir discipline as
 * the digest check above: `git verify-tag` consults GNUPGHOME, so pointing it
 * at a keyring that holds only the pinned key, and then binding the status
 * lines to the fingerprint, means no key the operator happens to trust can
 * satisfy this.
 *
 * @param {object}  args
 * @param {string}  args.repoDir      the checkout holding the tag
 * @param {string}  args.tag
 * @param {string} [args.keyPath]
 * @param {string} [args.fingerprint]
 * @param {function} [args.execFileSyncImpl]  test seam
 * @returns {{fingerprint: string}}
 * @throws {ReleaseIntegrityError}
 */
function verifyGitTagSignature({ repoDir, tag, keyPath = KEY_PATH, fingerprint = PLATFORM_KEY_FINGERPRINT, execFileSyncImpl = execFileSync, spawnSyncImpl = spawnSync }) {
    const expected = normalizeFingerprint(fingerprint)
    if (!/^[0-9A-F]{40}$/.test(expected)) {
        throw new ReleaseIntegrityError(
            `Release signing key is not pinned to a 40-hex fingerprint (got ${JSON.stringify(fingerprint)}).`
        )
    }
    if (!fs.existsSync(keyPath)) {
        throw new ReleaseIntegrityError(
            `No release signing key is shipped at ${keyPath}. The trust anchor must travel with the`
            + ' code; fetching it at verification time proves nothing.'
        )
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-tagsig-'))
    const homeDir = path.join(workDir, 'gnupg')
    fs.mkdirSync(homeDir, { mode: 0o700 })

    try {
        try {
            execFileSyncImpl(gpgBinary(), ['--batch', '--no-tty', '--quiet', '--homedir', homeDir, '--import', keyPath],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                throw new ReleaseIntegrityError(
                    'gpg is not installed, so this release tag cannot be verified. Install gnupg, or set'
                    + ' XCHAIN_NODE_REQUIRE_SIGNED_RELEASE=0 to update without provenance checks.'
                )
            }
            throw new ReleaseIntegrityError(`Could not import the pinned release key: ${describeGpgError(err)}`)
        }

        // `--raw` prints gpg's status protocol on stderr, whether git exits
        // zero or not: git exits non-zero for a bad signature and the status
        // lines still say which kind of bad. spawnSync rather than execFileSync
        // because the latter surfaces stderr only on failure, and the GOODSIG
        // line this needs arrives on the SUCCESS path.
        const run = spawnSyncImpl('git', ['-C', repoDir, 'verify-tag', '--raw', tag], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...config.childProcessEnv(), GNUPGHOME: homeDir }
        })
        const status = [run.stdout, run.stderr].map(part => (part ? String(part) : '')).join('\n')
        if (run.error || !/\[GNUPG:\]/.test(status)) {
            const detail = run.error ? run.error.message : (status.trim() || `git exited ${run.status}`)
            throw new ReleaseIntegrityError(
                `Tag ${tag} does not verify against the pinned release key (${expected}): ${detail}`
            )
        }

        assertStatusIsGood(status, expected, `tag ${tag}`)
        return { fingerprint: expected }
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true })
    }
}

module.exports = {
    gpgBinary,
    normalizeFingerprint,
    verifyDetachedSignature,
    describeGpgError,
    assertStatusIsGood,
    verifyGitTagSignature
}
