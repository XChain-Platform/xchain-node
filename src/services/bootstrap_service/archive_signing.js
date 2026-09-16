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
 * XChain Node - Bootstrap Service
 * Create and restore bootstrap files for XChain modules
 * Supported: xchain-utxo-tracker, xchain-decoder, xchain-indexer
 ********************************************************************/

let fs                    = require('fs')
const path                = require('path')
const crypto              = require('crypto')
let { execFile }          = require('child_process')
const { promisify }       = require('util')
let execFileAsync         = promisify(execFile)

let config = require('../../config')
const { assertSafeArchiveMemberNames, redactSecrets } = require('../../utils/helpers')
const { ensureDir } = require('./workspace')
const { getLogger } = require('../../observability/logger')
let logger = getLogger()

function configureDependencies(dependencies) {
    fs = dependencies.fs
    execFile = dependencies.childProcess.execFile
    execFileAsync = promisify(execFile)
    config = dependencies.config
    logger = dependencies.logger
}

// Bootstrap signing (supply-chain integrity):
//
// The outer archive bundles data.tar.gz together with its own data.sha256,
// so that checksum only proves the download wasn't corrupted in transit;
// anyone who can alter the archive on (or en route from) the bootstrap
// server can recompute it. Restores therefore also verify an Ed25519
// signature published NEXT TO the archive (<archive>.sig) against a public
// key pinned in this repository (the trust anchor travels with the code,
// not with the data server).
//
//   Publisher (bootstrap create): set XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY to
//   the Ed25519 private key PEM path; a .sig is written beside the archive
//   and must be uploaded alongside it.
//
//   Consumers (restore / auto-bootstrap): the pinned public key is read
//   from src/config/bootstrap_signing_pubkey.pem (override path via
//   XCHAIN_NODE_BOOTSTRAP_PUBKEY). When the key and a .sig are present the
//   signature MUST verify or the restore aborts. Enforcement is ON BY DEFAULT
//   (fail closed): if the key or .sig is missing the restore is refused. Set
//   XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP=0 (or false/no) to opt out; e.g. a
//   self-hosted bootstrap source that publishes no signatures. (For the
//   auto-bootstrap-on-install path the refusal is caught and the node simply
//   syncs from scratch instead of restoring an unverified archive.)
//
//   Key generation (operator, one-time):
//     openssl genpkey -algorithm ed25519 -out bootstrap_signing_key.pem
//     openssl pkey -in bootstrap_signing_key.pem -pubout \
//       -out src/config/bootstrap_signing_pubkey.pem
//
// Signature format (v1): "v1 ed25519 <base64>" where the signature is over
// the raw 32-byte SHA-256 digest of the outer archive (digest-then-sign, so
// multi-GB archives never need to be buffered).

const BOOTSTRAP_SIG_SUFFIX = '.sig'
// Two levels up, not one: this module lives in src/services/bootstrap_service/,
// so the pinned key at src/config/ is __dirname/../../config. A single '..' aims
// at src/services/config/, which does not exist, and loadBootstrapPublicKey()
// then returns null and every restore refuses as "unsigned".
const DEFAULT_BOOTSTRAP_PUBKEY_PATH = path.join(__dirname, '..', '..', 'config', 'bootstrap_signing_pubkey.pem')

// A restore that stops because the archive failed its provenance/integrity
// gates is the gate WORKING, not the tool breaking. Left as a bare Error it
// escaped the CLI action uncaught, so the operator saw the `throw` source
// line, a stack, and the "Node.js v22.x" banner: indistinguishable from a
// crash, and the natural read is "the restore tool is broken, retry it" when
// the correct read is "this archive is not trustworthy, do not restore it".
// This was seen firsthand against a tampered archive in testing. Naming the
// class lets the CLI/TUI print the reason and exit 1 cleanly, mirroring how
// BootstrapSourceUnhealthyError is already classified on the create path.
class BootstrapIntegrityError extends Error {
    constructor(message) {
        super(message)
        this.name = 'BootstrapIntegrityError'
    }
}

function loadBootstrapPublicKey() {
    const override = config.XCHAIN_NODE_BOOTSTRAP_PUBKEY
    const pubkeyPath = override || DEFAULT_BOOTSTRAP_PUBKEY_PATH
    // The pinned key is the whole trust anchor. Swapping it via env silently
    // moves the trust root to a non-pinned key, so make it as loud as the
    // REQUIRE_SIGNED=0 opt-out: an operator watching the "signature OK" line
    // must be told the pinned anchor is NOT the one that validated the archive.
    if (override && path.resolve(override) !== path.resolve(DEFAULT_BOOTSTRAP_PUBKEY_PATH)) {
        logger.info(`WARNING: bootstrap signature trust anchor overridden via XCHAIN_NODE_BOOTSTRAP_PUBKEY=${override}; the repo-pinned public key (${DEFAULT_BOOTSTRAP_PUBKEY_PATH}) is NOT in use.`)
    }
    if (!fs.existsSync(pubkeyPath)) return null
    return crypto.createPublicKey(fs.readFileSync(pubkeyPath, 'utf8'))
}

async function signBootstrapArchive(archivePath, privateKeyPath) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath, 'utf8'))
    const digestHex  = await computeSha256(archivePath)
    const signature  = crypto.sign(null, Buffer.from(digestHex, 'hex'), privateKey)
    const sigPath    = archivePath + BOOTSTRAP_SIG_SUFFIX
    await fs.promises.writeFile(sigPath, `v1 ed25519 ${signature.toString('base64')}\n`)
    return sigPath
}

async function verifyBootstrapSignature(archivePath, sigPath, publicKey) {
    const sigText = (await fs.promises.readFile(sigPath, 'utf8')).trim()
    const parts   = sigText.split(/\s+/)
    if (parts.length !== 3 || parts[0] !== 'v1' || parts[1] !== 'ed25519') {
        throw new BootstrapIntegrityError(`Bootstrap signature file is malformed: ${sigPath}`)
    }
    const digestHex = await computeSha256(archivePath)
    const valid = crypto.verify(null, Buffer.from(digestHex, 'hex'), publicKey, Buffer.from(parts[2], 'base64'))
    if (!valid) {
        throw new BootstrapIntegrityError(`Bootstrap signature verification FAILED for ${archivePath}: the archive does not match its published signature. Refusing to restore.`)
    }
}

// Policy gate run before any restore. Returns silently when the archive may
// be used; throws when it must not be.
async function checkBootstrapSignature(archivePath) {
    // Fail closed by default. Opt out only with an explicit falsy value
    // (XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP=0/false/no); e.g. for a self-hosted
    // bootstrap source that publishes no signatures.
    const optOut        = /^(0|false|no)$/i.test(config.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP)
    const requireSigned = !optOut
    const sigPath       = archivePath + BOOTSTRAP_SIG_SUFFIX
    const publicKey     = loadBootstrapPublicKey()

    if (publicKey && fs.existsSync(sigPath)) {
        process.stdout.write('Verifying bootstrap signature... ')
        await verifyBootstrapSignature(archivePath, sigPath, publicKey)
        logger.info('OK')
        return
    }

    const missing = !publicKey
        ? 'no bootstrap signing public key is pinned (src/config/bootstrap_signing_pubkey.pem)'
        : `no signature file found (${sigPath})`
    if (requireSigned) {
        throw new BootstrapIntegrityError(`Refusing unsigned bootstrap: ${missing}. Signed bootstraps are required by default; set XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP=0 to override.`)
    }
    logger.info(redactSecrets(`WARNING: restoring bootstrap WITHOUT signature verification (${missing}). Signature enforcement disabled via XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP=0; the embedded checksum only detects transport corruption, not tampering.`))
}

// Sign the just-created archive when a publisher signing key is configured.
// Best-effort from the creator's perspective only in the sense that a missing
// env var skips signing; a configured-but-broken key fails the create loudly.
async function maybeSignBootstrap(finalOutput) {
    const keyPath = config.XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY
    if (!keyPath) {
        logger.info('NOTE: XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY not set; bootstrap is unsigned. Consumers cannot verify provenance.')
        return null
    }
    const sigPath = await signBootstrapArchive(finalOutput, keyPath)
    logger.info(redactSecrets(`Bootstrap signed: ${sigPath}`))
    return sigPath
}

async function computeSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash   = crypto.createHash('sha256')
        const stream = fs.createReadStream(filePath)
        stream.on('data',  chunk => hash.update(chunk))
        stream.on('end',   ()    => resolve(hash.digest('hex')))
        stream.on('error', err   => reject(err))
    })
}

// Extract + verify the inner archive (data.tar.gz / dump.sql.gz) from a
// bootstrap archive whose detached signature has ALREADY been verified by the
// caller, leaving workDir holding a verified `innerName`.
//
// Security-critical: the ONLY trust anchor is that outer-archive signature, so
// the expected inner checksum is read fresh from the (verified) outer archive,
// never from workDir. workDir is NOT a trust boundary: it lives under
// getWorkDir() -> tmpDir, which an operator may point at shared/NFS storage via
// XCHAIN_NODE_TMP_DIR, so a co-tenant or a hostile-env attacker could pre-plant
// a self-consistent malicious inner archive + checksum + sentinel there. The
// prior implementation skipped both the outer extract (when data.tar.gz +
// data.sha256 already existed) and the checksum verify (when a `verify.ok`
// sentinel existed), so those planted bytes were restored under a green
// signature. Here a prior extraction is reused ONLY when the on-disk inner
// archive re-hashes to the checksum that shipped inside the verified outer
// archive; anything else is discarded and re-extracted from that archive. The
// expensive inner re-hash runs every time (a work-dir marker can never be
// trusted), but the outer full-extract is still skipped on a clean resume.
async function ensureVerifiedInnerArchive(archivePath, workDir, innerName, checksumName) {
    const innerArchive = path.join(workDir, innerName)

    // Read the trusted expected inner checksum from the signature-verified
    // outer archive (also validates member paths before any extraction).
    const { stdout: memberList } = await execFileAsync('tar', ['tzf', archivePath], { maxBuffer: 64 * 1024 * 1024 })
    assertSafeArchiveMemberNames(memberList, archivePath)
    const checksumMember = memberList.split('\n').filter(Boolean).find(m => path.basename(m) === checksumName)
    if (!checksumMember) throw new BootstrapIntegrityError(`Archive is malformed: missing ${checksumName}`)
    const { stdout: checksumBody } = await execFileAsync('tar', ['xzOf', archivePath, checksumMember], { maxBuffer: 1024 * 1024 })
    const expectedInnerSha = checksumBody.trim().split(/\s+/)[0]
    if (!/^[a-f0-9]{64}$/i.test(expectedInnerSha)) {
        throw new BootstrapIntegrityError(`Archive ${checksumName} does not contain a valid SHA-256`)
    }

    // Reuse a prior extraction only when its bytes match the verified checksum.
    if (fs.existsSync(innerArchive)) {
        process.stdout.write('Checking existing work-dir archive against the verified checksum... ')
        const computed = await computeSha256(innerArchive)
        if (computed === expectedInnerSha) {
            logger.info('OK (reusing)')
            return innerArchive
        }
        logger.info('mismatch; discarding and re-extracting')
    }

    // Fresh extraction from the verified outer archive.
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true })
    ensureDir(workDir)
    logger.info('Extracting outer archive...')
    await execFileAsync('tar', ['xzf', archivePath, '-C', workDir])
    if (!fs.existsSync(innerArchive)) {
        fs.rmSync(workDir, { recursive: true })
        throw new BootstrapIntegrityError(`Archive is malformed: missing ${innerName}`)
    }
    const computed = await computeSha256(innerArchive)
    if (computed !== expectedInnerSha) {
        fs.rmSync(workDir, { recursive: true })
        throw new BootstrapIntegrityError(`Inner archive checksum mismatch\n  Expected: ${expectedInnerSha}\n  Got:      ${computed}`)
    }
    logger.info('Outer archive extracted and inner checksum verified')
    return innerArchive
}

module.exports = {
    configureDependencies,
    BOOTSTRAP_SIG_SUFFIX,
    BootstrapIntegrityError,
    loadBootstrapPublicKey,
    signBootstrapArchive,
    verifyBootstrapSignature,
    checkBootstrapSignature,
    maybeSignBootstrap,
    computeSha256,
    ensureVerifiedInnerArchive
}
