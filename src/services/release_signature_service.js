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
 * XChain Node - Release Signature Service
 *
 * Turns clone integrity into a PROVENANCE check.
 *
 * A pinned install verifies every clone against `release-manifest.json`
 * (ReleaseManifestService + cloneIntegrity). That check is only as trustworthy
 * as the manifest, and the manifest is fetched from the same repository the
 * clones come from: unsigned, it proves the install is self-consistent, which
 * anyone who can write to the org can also arrange. The signature is what makes
 * it evidence of who published the release.
 *
 * The chain a verifier walks (release-management spec section 12):
 *
 *   1. the TAG signature            proves who cut the release      (git tag -v)
 *   2. SHA256SUMS.asc               proves the asset set is theirs  (this file)
 *   3. release-manifest.json        pins every component to a commit
 *   4. clone verification           proves the tree IS that commit  (cloneIntegrity)
 *
 * This service is step 2, plus the digest comparison that binds step 3 to it.
 *
 * TRUST ANCHOR: `tools/release/release-signing-key.asc`, shipped in this repo,
 * pinned to PLATFORM_KEY_FINGERPRINT below. The canonical copy lives in
 * xchain-documentation (operations/RELEASE-SIGNING-KEY.asc) and the fingerprint
 * is published independently at https://xchain.io/security, so an operator can
 * compare two channels rather than trust one. The copy here is what the code
 * uses: a key fetched at verification time from the same place as the artifact
 * verifies nothing.
 *
 * Verification runs in an EPHEMERAL gpg homedir. Using the operator's keyring
 * would let any key they happen to trust satisfy the gate, and `gpg --verify`
 * succeeding says only "some key in this keyring signed it", never "the release
 * key signed it". Every check below is bound to the pinned fingerprint.
 *
 * OPT-OUT: XCHAIN_NODE_REQUIRE_SIGNED_RELEASE=0 (or false/no) for airgapped and
 * development installs. It announces itself on every run; a gate that goes quiet
 * when disabled is a gate nobody notices is off.
 ********************************************************************/

const crypto   = require('crypto')
const config = require('../config');
const { getLogger } = require('../observability/logger')
const {
    PLATFORM_KEY_FINGERPRINT,
    KEY_PATH,
    SUMS_ASSET,
    SIG_ASSET,
    MANIFEST_ASSET,
    ReleaseIntegrityError
} = require('./release_signature_service/release_assets.js')
const {
    verifyDetachedSignature,
    verifyGitTagSignature,
    assertStatusIsGood
} = require('./release_signature_service/gpg_verification.js')

function defaultLogger() {
    const logger = getLogger()
    return {
        log: logger.info.bind(logger),
        warn: logger.warn.bind(logger),
        error: logger.error.bind(logger)
    }
}

function signatureCheckDisabled() {
    return /^(0|false|no)$/i.test(config.XCHAIN_NODE_REQUIRE_SIGNED_RELEASE)
}

/**
 * Parse a coreutils-format SHA256SUMS body.
 *
 * Strict on purpose. A line this parser cannot read is not skipped, because a
 * skipped line is an artifact whose digest silently stops being checked, and a
 * duplicate name is an ambiguity a verifier must never resolve by "last wins".
 *
 * @param {string} text
 * @returns {Map<string,string>} filename -> lowercase hex digest
 */
function parseSha256sums(text) {
    const entries = new Map()

    String(text).split('\n').forEach((rawLine, index) => {
        const line = rawLine.replace(/\r$/, '')
        if (line.trim() === '') return

        // `<64 hex><space><space-or-asterisk><name>`: two spaces is text mode,
        // ` *` is coreutils binary mode. Both are emitted in the wild, so both
        // are accepted; anything else is a malformed digest file.
        const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line)
        if (!match) {
            throw new ReleaseIntegrityError(
                `SHA256SUMS line ${index + 1} is malformed: ${JSON.stringify(line)}.`
                + ' Refusing to verify against a digest file that cannot be read exactly.'
            )
        }

        const name = match[2].trim()
        if (entries.has(name)) {
            throw new ReleaseIntegrityError(
                `SHA256SUMS lists '${name}' more than once. Refusing an ambiguous digest file.`
            )
        }
        entries.set(name, match[1].toLowerCase())
    })

    if (entries.size === 0) {
        throw new ReleaseIntegrityError('SHA256SUMS is empty; there is nothing to verify against.')
    }

    return entries
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * Bind one artifact to a verified digest file.
 *
 * @param {object} args
 * @param {string} args.sumsText   verified SHA256SUMS body
 * @param {Buffer} args.bytes      the artifact as fetched
 * @param {string} args.name       its name in SHA256SUMS
 */
function assertDigestMatches({ sumsText, bytes, name }) {
    const entries = parseSha256sums(sumsText)
    const expected = entries.get(name)

    if (!expected) {
        throw new ReleaseIntegrityError(
            `${SUMS_ASSET} does not list '${name}', so nothing signed covers it.`
            + ` Listed: ${[...entries.keys()].join(', ')}`
        )
    }

    const actual = sha256(bytes)
    if (actual !== expected) {
        throw new ReleaseIntegrityError(
            `'${name}' does not match the signed digest (expected ${expected}, got ${actual}).`
            + ' Refusing to install from an artifact the release key did not cover.'
        )
    }
}

/**
 * The install-time gate: verify a release's manifest bytes against the signed
 * digest file published with that release.
 *
 * `fetchAsset` is injected rather than imported so the network path stays with
 * the caller that already owns GitHub access (and so this is testable without
 * one). It resolves to a Buffer, or null when the release carries no such asset.
 *
 * `keyPath` and `fingerprint` default to the pins and exist so the gate itself
 * can be exercised against a scratch key. No install path passes them: an
 * install that could choose its own trust anchor would not have one.
 *
 * @param {object}   args
 * @param {string}   args.tag
 * @param {Buffer}   args.manifestBytes
 * @param {function} args.fetchAsset      (assetName) => Promise<Buffer|null>
 * @param {object}  [args.logger]
 * @param {string}  [args.keyPath]
 * @param {string}  [args.fingerprint]
 * @returns {Promise<{verified: boolean, fingerprint?: string, reason?: string}>}
 */
async function verifyManifestForTag({
    tag, manifestBytes, fetchAsset, logger = defaultLogger(),
    keyPath = KEY_PATH, fingerprint = PLATFORM_KEY_FINGERPRINT
}) {
    const disabled = signatureCheckDisabled()

    const refuse = (message) => {
        if (!disabled) {
            throw new ReleaseIntegrityError(
                `${message} Signed releases are required by default;`
                + ' set XCHAIN_NODE_REQUIRE_SIGNED_RELEASE=0 to install anyway (airgapped/dev use).'
            )
        }
        // The opt-out is loud on every run, and says what it gave up rather
        // than just that it is on: an operator who sees this line is being told
        // the install is pinned but not attributed.
        logger.warn(
            `WARNING: installing ${tag} WITHOUT release signature verification (${message.trim()})`
            + ' XCHAIN_NODE_REQUIRE_SIGNED_RELEASE=0 is set, so this install is pinned but its'
            + ' provenance is unproven: the manifest is trusted because it was served, not because'
            + ' the release key covered it.'
        )
        return { verified: false, reason: message.trim() }
    }

    let sums, sig
    try {
        [sums, sig] = await Promise.all([fetchAsset(SUMS_ASSET), fetchAsset(SIG_ASSET)])
    } catch (err) {
        return refuse(`Could not fetch the signed digest files for ${tag} (${err.message}).`)
    }

    if (!sums || !sig) {
        const missing = [!sums && SUMS_ASSET, !sig && SIG_ASSET].filter(Boolean).join(' and ')
        return refuse(`Release ${tag} publishes no ${missing}.`)
    }

    // Signature first, then digests. Reading the digest file before proving who
    // wrote it would mean acting on unverified input, and the failure message
    // would name a mismatch when the real finding is an unsigned release.
    let verified
    try {
        verified = verifyDetachedSignature({ data: sums, signature: sig, keyPath, fingerprint })
    } catch (err) {
        if (disabled) return refuse(`${err.message}`)
        throw err
    }

    try {
        assertDigestMatches({ sumsText: sums.toString('utf8'), bytes: manifestBytes, name: MANIFEST_ASSET })
    } catch (err) {
        if (disabled) return refuse(`${err.message}`)
        throw err
    }

    logger.log(`Release ${tag}: ${SIG_ASSET} verified against ${verified.fingerprint}, ${MANIFEST_ASSET} digest matches.`)
    return { verified: true, fingerprint: verified.fingerprint }
}

module.exports = {
    PLATFORM_KEY_FINGERPRINT,
    KEY_PATH,
    SUMS_ASSET,
    SIG_ASSET,
    MANIFEST_ASSET,
    ReleaseIntegrityError,
    signatureCheckDisabled,
    parseSha256sums,
    sha256,
    verifyDetachedSignature,
    verifyGitTagSignature,
    assertStatusIsGood,
    assertDigestMatches,
    verifyManifestForTag
}
