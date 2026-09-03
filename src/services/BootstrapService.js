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

const fs              = require('fs')
const path            = require('path')
const crypto          = require('crypto')
const zlib            = require('zlib')
const axios           = require('axios')
const { execFile, spawn } = require('child_process')
const { promisify }   = require('util')
const { PassThrough } = require('stream')
const execFileAsync   = promisify(execFile)

const { XChainService, DB_MODULE_NAME, SEP, tmpDir, BOOTSTRAP_BASE_URL, EXTERNAL_DB } = require('../config/constants')
const { db }                                          = require('../state')
const { getDefaultConfig, getModuleDatabaseName, getUtxoTrackerVolumeName } = require('./ConfigService')
const { stopContainer, startContainer }               = require('./DockerService')
const { getDatabaseContainerId, ensureDatabasePool, getExternalDbConfig, executeNativeMariaDbCommand } = require('./DatabaseService')
const { assertSafeArchiveMemberNames, redactSecrets } = require('../utils/helpers')
const { dockerMariadbArgs, mariadbEnv }               = require('../utils/dockerMariadb')
const { assertBootstrapSourceHealthy }                = require('./BootstrapHealthGate')
const { recordBootstrapPublished }                    = require('./BootstrapRepublishLedger')
const { declareEncoderMaintenance, clearEncoderMaintenance } = require('./EncoderMaintenanceWindow')

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
const DEFAULT_BOOTSTRAP_PUBKEY_PATH = path.join(__dirname, '..', 'config', 'bootstrap_signing_pubkey.pem')

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
    const override = process.env.XCHAIN_NODE_BOOTSTRAP_PUBKEY
    const pubkeyPath = override || DEFAULT_BOOTSTRAP_PUBKEY_PATH
    // The pinned key is the whole trust anchor. Swapping it via env silently
    // moves the trust root to a non-pinned key, so make it as loud as the
    // REQUIRE_SIGNED=0 opt-out: an operator watching the "signature OK" line
    // must be told the pinned anchor is NOT the one that validated the archive.
    if (override && path.resolve(override) !== path.resolve(DEFAULT_BOOTSTRAP_PUBKEY_PATH)) {
        console.log(`WARNING: bootstrap signature trust anchor overridden via XCHAIN_NODE_BOOTSTRAP_PUBKEY=${override}; the repo-pinned public key (${DEFAULT_BOOTSTRAP_PUBKEY_PATH}) is NOT in use.`)
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
    const optOut        = /^(0|false|no)$/i.test(process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP || '')
    const requireSigned = !optOut
    const sigPath       = archivePath + BOOTSTRAP_SIG_SUFFIX
    const publicKey     = loadBootstrapPublicKey()

    if (publicKey && fs.existsSync(sigPath)) {
        process.stdout.write('Verifying bootstrap signature... ')
        await verifyBootstrapSignature(archivePath, sigPath, publicKey)
        console.log('OK')
        return
    }

    const missing = !publicKey
        ? 'no bootstrap signing public key is pinned (src/config/bootstrap_signing_pubkey.pem)'
        : `no signature file found (${sigPath})`
    if (requireSigned) {
        throw new BootstrapIntegrityError(`Refusing unsigned bootstrap: ${missing}. Signed bootstraps are required by default; set XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP=0 to override.`)
    }
    console.log(redactSecrets(`WARNING: restoring bootstrap WITHOUT signature verification (${missing}). Signature enforcement disabled via XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP=0; the embedded checksum only detects transport corruption, not tampering.`))
}

// Sign the just-created archive when a publisher signing key is configured.
// Best-effort from the creator's perspective only in the sense that a missing
// env var skips signing; a configured-but-broken key fails the create loudly.
async function maybeSignBootstrap(finalOutput) {
    const keyPath = process.env.XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY
    if (!keyPath) {
        console.log('NOTE: XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY not set; bootstrap is unsigned. Consumers cannot verify provenance.')
        return null
    }
    const sigPath = await signBootstrapArchive(finalOutput, keyPath)
    console.log(redactSecrets(`Bootstrap signed: ${sigPath}`))
    return sigPath
}

function startProgress(message, totalBytes) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    let written    = 0
    let frameIndex = 0

    const interval = setInterval(() => {
        const mb  = (written / 1024 / 1024).toFixed(1)
        const pct = totalBytes > 0
            ? Math.floor(written / totalBytes * 100)
            : '?'
        process.stdout.write(`\r${frames[frameIndex++ % 10]} ${message} ${mb} MB (${pct}%)`)
    }, 100)
    // Never let the progress ticker by itself hold the event loop open. If a
    // dump/restore path throws before stop() clears this interval, an un-unref'd
    // timer keeps the process (and the test runner) alive forever.
    interval.unref()

    return {
        update(bytes) { written += bytes },
        stop(finalMessage) {
            clearInterval(interval)
            process.stdout.write(`\r✓ ${finalMessage}\n`)
        }
    }
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

function buildDateTimeString() {
    // UTC, not local time: the <network>-<service>-<YYYYMMDD_HHMMSS> suffix is the
    // sort key both the listing (bootstraps.build.js) and latest-resolution
    // (latest.php) rely on for "lexically sortable => newest". Local accessors let a
    // DST fall-back hour, a host timezone change, or a cross-timezone migration stamp
    // a newer archive with an older suffix, so latest.tgz would serve a stale snapshot.
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
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
            console.log('OK (reusing)')
            return innerArchive
        }
        console.log('mismatch; discarding and re-extracting')
    }

    // Fresh extraction from the verified outer archive.
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true })
    ensureDir(workDir)
    console.log('Extracting outer archive...')
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
    console.log('Outer archive extracted and inner checksum verified')
    return innerArchive
}

function getWorkDir(coin, network, module) {
    return path.join(tmpDir, `bootstrap-work-${coin}-${network}-${module}`)
}

// Staging a bootstrap writes the whole dataset into the work dir, and tmpDir
// defaults to <repo>/tmp, which on a normal install is the ROOT filesystem.
// A 30G tracker archive staged there once filled a host's / to 100% and took
// it down; the recovery was to point XCHAIN_NODE_TMP_DIR at the big volume,
// which works but only if you already know to do it.
//
// So refuse up front instead of discovering it at 100%. Deliberately checked
// BEFORE the service container is stopped: failing after the stop would take
// the tracker down to accomplish nothing. estimatedBytes is the UNCOMPRESSED
// size, which is the honest worst case, since we cannot know the ratio before
// compressing and an incompressible dataset is exactly the one that fills a
// disk. A reserve on top keeps the filesystem off zero even if the estimate is
// slightly low, because filling root is far worse than refusing a bootstrap.
const BOOTSTRAP_FS_RESERVE_BYTES = 2 * 1024 * 1024 * 1024

// Both the staging dir AND the output dir have to hold it, and on a default
// install they are DIFFERENT filesystems only if the operator made them so:
// tmpDir defaults to <install>/tmp and the bootstrap output to <install>/data,
// i.e. both on root. Checking only the work dir would have left the outage
// half-fixed, since the finished archive lands in the output dir.
function assertBootstrapCapacity(workDir, outputDir, estimatedBytes, label) {
    assertPathCapacity(workDir, estimatedBytes, label, 'staging (XCHAIN_NODE_TMP_DIR)')
    assertPathCapacity(outputDir, estimatedBytes, label, 'published archives (XCHAIN_NODE_BOOTSTRAP_DIR)')
}

function assertPathCapacity(targetDir, estimatedBytes, label, role) {
    if (!estimatedBytes || estimatedBytes <= 0) return   // unknown size: nothing to assert against

    // statfs needs a path that exists; walk up to the nearest existing ancestor.
    let probe = path.resolve(targetDir)
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe)
        if (parent === probe) break
        probe = parent
    }

    let free
    try {
        const st = fs.statfsSync(probe)
        free = st.bavail * st.bsize
    } catch {
        return   // cannot measure (unsupported platform): do not block the operator
    }

    const needed = estimatedBytes + BOOTSTRAP_FS_RESERVE_BYTES
    if (free >= needed) return

    const gb = n => (n / 1024 / 1024 / 1024).toFixed(1) + 'G'
    throw new Error(
        `Not enough space for the ${label} bootstrap's ${role} under ${probe}: ` +
        `${gb(free)} free, need about ${gb(needed)} (${gb(estimatedBytes)} of data plus a ${gb(BOOTSTRAP_FS_RESERVE_BYTES)} reserve). ` +
        `Point it at a larger volume and re-run; both default to the install dir, which is usually the root filesystem.`
    )
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
    }
}

async function ensureDirWritable(dirPath) {
    const normalized = path.resolve(dirPath)

    if (!fs.existsSync(normalized)) {
        try {
            fs.mkdirSync(normalized, { recursive: true })
            return
        } catch { /* fall through to Docker approach */ }
    } else {
        try {
            fs.accessSync(normalized, fs.constants.W_OK)
            return
        } catch { /* fall through to Docker approach */ }
    }

    // Directory exists but isn't writable (likely created by Docker as root).
    // Use a throwaway Alpine container to create it and hand ownership to the
    // invoking user. chmod 755 alone is not enough: the dir stays root-owned, so
    // a non-root prod user only gets r-x (others) and still cannot write, which
    // broke `bootstrap create` on non-root hosts. chown to our uid/gid first.
    const parent  = path.dirname(normalized)
    const dirName = path.basename(normalized)
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0
    const gid = typeof process.getgid === 'function' ? process.getgid() : 0
    await execFileAsync('docker', ['run', '--rm', '-v', `${parent}:/parent`, 'alpine', 'mkdir', '-p', `/parent/${dirName}`])
    await execFileAsync('docker', ['run', '--rm', '-v', `${parent}:/parent`, 'alpine', 'chown', `${uid}:${gid}`, `/parent/${dirName}`])
    await execFileAsync('docker', ['run', '--rm', '-v', `${parent}:/parent`, 'alpine', 'chmod', '755', `/parent/${dirName}`])
}

async function getBootstrapFilesList(coin, network, module) {
    const defaultConfig = await getDefaultConfig(module, coin, network)
    const fileList = []

    let directory = null
    switch (module) {
        case XChainService.XCHAIN_UTXO_TRACKER:
            directory = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
            break
        case XChainService.XCHAIN_DECODER:
            directory = defaultConfig["DECODER_BOOTSTRAP_VOLUME"]
            break
        case XChainService.XCHAIN_INDEXER:
            directory = defaultConfig["INDEXER_BOOTSTRAP_VOLUME"]
            break
        default:
            throw new Error(`Unsupported module for bootstrap: ${module}`)
    }

    try {
        const entries = await fs.promises.readdir(directory)
        for (const fileName of entries) {
            const filePath = path.join(directory, fileName)
            const stats    = await fs.promises.stat(filePath)
            // Only real archives are restorable. The directory also holds
            // the detached .sig (and older .sha256) sidecars, and listing those as
            // choices invites restoring a signature file.
            if (stats.isFile() && isBootstrapArchiveName(fileName))
                fileList.push({ name: fileName, mtimeMs: Number(stats.mtimeMs) || 0 })
        }
        // NEWEST FIRST. This came back in raw readdir order, which is
        // effectively arbitrary and in practice oldest-first, so every caller
        // that reached for "the latest" by taking the head of the list restored
        // the OLDEST archive instead. Sorting here fixes the interactive menu
        // and any scripted driver at once; ties break on the name, which embeds
        // the build timestamp, so the order is total and reproducible even when
        // mtimes are equal or unavailable.
        fileList.sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name))
        return fileList.map(f => f.name)
    } catch (err) {
        throw err
    }
}

// A published bootstrap is the outer wrapper archive; .sig/.sha256 sit beside it.
function isBootstrapArchiveName(fileName) {
    return /\.(tar\.gz|tgz)$/.test(fileName)
}

async function makeBootstrap(coin, network, module) {
    switch (module) {
        case XChainService.XCHAIN_UTXO_TRACKER:
        case XChainService.XCHAIN_DECODER:
        case XChainService.XCHAIN_INDEXER:
            break
        default:
            throw new Error(`Unsupported module for bootstrap create: ${module}`)
    }

    // Refuse to snapshot a source that is not known-good, BEFORE any work
    // (and, for the utxo-tracker, before the container is stopped, so a refusal
    // costs no downtime). A published archive becomes the newest file in the served
    // directory and so the default choice for every restore path, including
    // `bootstrap restore --latest`; publishing an unverified snapshot silently
    // replaces the last good archive. The unsupported-module throw above stays
    // first so an unknown module still fails on its own message.
    await assertBootstrapSourceHealthy(coin, network, module)

    const result = module === XChainService.XCHAIN_UTXO_TRACKER
        ? await makeBootstrapUtxoTracker(coin, network)
        : await makeBootstrapMariaDb(coin, network, module)

    // A fresh archive is a fresh LINEAGE, so it clears any republish this
    // combo was owed after a reset (see BootstrapRepublishLedger). Recorded on
    // CREATE rather than after the upload: the create is what re-derives the
    // archive from the post-reindex store, and an upload that then fails is
    // already reported as PUBLISH-FAIL and retried by the next scheduled run.
    // Never fatal - the archive exists either way.
    try {
        recordBootstrapPublished(module, coin, network)
    } catch (err) {
        console.log(`Warning: could not clear the bootstrap republish marker for ${module} ${coin}/${network} (${err.message}).`)
    }

    return result
}

// Where the pre-compress hardlink snapshot of the tracker volume lives.
//
// It has to sit INSIDE the volume, because a hardlink cannot cross a
// filesystem, and the volume is the only thing mounted into the helper
// container. It is a sibling of the LevelDB store (LevelUpDb opens
// /data/<dbName>, never /data itself), so the running tracker never looks at
// it. Fixed literal with no shell metacharacters: it is interpolated into the
// snapshot shell script below.
const TRACKER_SNAPSHOT_DIR = '.xchain-bootstrap-snapshot'

// Freeze the tracker volume without keeping the tracker down for the compress.
//
// Taken while the container is STOPPED, so the store is quiescent and the
// result is a byte-exact point-in-time copy. Two passes, because the two kinds
// of file in a classic-level store need different treatment:
//
//   1. Hardlink everything. Compaction afterwards unlinks the SSTs it merges
//      away, but the snapshot's links keep those inodes alive, so the compress
//      reads the store as it stood at the stop even though the tracker has been
//      serving traffic for hours by then. That is the whole trick, and it is
//      only sound because an .ldb/.sst file is written once and never edited.
//
//   2. Replace the link with a real copy for every OTHER regular file. LevelDB
//      appends to its live MANIFEST and write-ahead log in place, and a
//      hardlink shares the inode, so those would follow the live store forward
//      and the archive would carry a manifest describing SSTs it does not hold.
//      In practice leveldb opens a fresh MANIFEST/log per open (reuse_logs is
//      off) and rewrites CURRENT via rename, so the links would usually survive
//      untouched; "usually" is not a property to hand a published mainnet
//      bootstrap. These files are kilobytes-to-megabytes next to a 162 GB
//      store, so copying them costs nothing measurable.
//
// Cost while the snapshot is held: the volume keeps every SST the tracker
// compacts away during the run, so it needs headroom for that churn rather than
// for a second full copy. The snapshot is dropped in the caller's finally.
//
// Rejects when the volume's filesystem will not take the hardlinks; the caller
// falls back to the old behavior (compress with the container stopped).
async function snapshotTrackerVolume(volumeName) {
    const snapPath = `/data/${TRACKER_SNAPSHOT_DIR}`
    const script = [
        'set -e',
        `rm -rf ${snapPath}`,
        `mkdir -p ${snapPath}`,
        // -mindepth 1 -maxdepth 1 walks only the volume's top level, and the
        // ! -name guard keeps the snapshot from copying itself.
        `find /data -mindepth 1 -maxdepth 1 ! -name ${TRACKER_SNAPSHOT_DIR} -exec cp -al {} ${snapPath}/ ';'`,
        // Pass 2. The .xcsnap guard keeps a temp file from being re-processed
        // if the directory walk sees one mid-flight.
        `find ${snapPath} -type f ! -name '*.ldb' ! -name '*.sst' ! -name '*.xcsnap'` +
            ` -exec sh -c 'cp -a "$1" "$1.xcsnap" && mv -f "$1.xcsnap" "$1"' _ {} ';'`
    ].join('\n')

    await execFileAsync('docker', [
        'run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c', script
    ])
    return true
}

// Headroom the volume should have spare before we pin its compaction churn for
// the length of a compress, as a fraction of the store size. A guess by
// construction (nobody can predict a run's write amplification), so it only
// gates a warning.
const TRACKER_SNAPSHOT_HEADROOM_RATIO = 0.15

async function warnOnThinTrackerVolume(volumeName, totalBytes) {
    if (!totalBytes || totalBytes <= 0) return
    let availableBytes = 0
    try {
        const { stdout } = await execFileAsync('docker', [
            'run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'df', '-Pk', '/data'
        ])
        const cols = stdout.trim().split('\n').pop().trim().split(/\s+/)
        availableBytes = (parseInt(cols[3], 10) || 0) * 1024
    } catch {
        return   // unknown free space: nothing honest to say
    }
    const wanted = Math.round(totalBytes * TRACKER_SNAPSHOT_HEADROOM_RATIO)
    if (availableBytes >= wanted) return
    const gb = bytes => (bytes / 1024 / 1024 / 1024).toFixed(1)
    console.log(
        `WARNING: ${volumeName} has ${gb(availableBytes)} GB free against a ${gb(totalBytes)} GB store.\n` +
        `The snapshot holds every SST the tracker compacts away while the archive is built, so a long\n` +
        `run on this volume can fill it and halt the tracker. Free space or expect a stopped tracker.`
    )
}

async function removeTrackerSnapshot(volumeName) {
    await execFileAsync('docker', [
        'run', '--rm', '-v', `${volumeName}:/data`, 'alpine',
        'rm', '-rf', `/data/${TRACKER_SNAPSHOT_DIR}`
    ])
}

// Bundle already-compressed members into the published .tar.gz WITHOUT
// recompressing them.
//
// The outer archive exists only so the payload travels with its own checksum;
// its members (data.tar.gz / dump.sql.gz) are gzip streams already, which
// deflate cannot shrink. The old `tar czf` therefore pushed the whole dataset
// through gzip a second time for no size win: on 2026-08-01 that was 162.5 GB
// of incompressible bytes re-deflated. Level 0 emits stored deflate blocks, so
// the result is still a genuine gzip file that every existing consumer reads
// unchanged (`tar tzf` / `tar xzf`, the tracker's own single-layer restore),
// only without the CPU.
function writeStoredGzipTar(finalOutput, workDir, members) {
    return new Promise((resolve, reject) => {
        const tarProc     = spawn('tar', ['cf', '-', '-C', workDir, ...members])
        const storeStream = zlib.createGzip({ level: 0 })
        const writeStream = fs.createWriteStream(finalOutput)

        let tarExit  = null
        let written  = false
        let settled  = false

        // The half-written file sits in the directory the publish rsyncs from,
        // so it has to go: a truncated archive that survives here is one the
        // next node restores from.
        const discardPartial = () => {
            try { writeStream.destroy() } catch { /* already torn down */ }
            try { fs.rmSync(finalOutput, { force: true }) } catch { /* nothing to remove */ }
        }

        // Both conditions are required: tar can die mid-stream, which ends the
        // pipe and fires 'finish' on a TRUNCATED archive. Resolving on 'finish'
        // alone would publish that truncated file as a good bootstrap.
        const settle = () => {
            if (settled || tarExit === null || !written) return
            settled = true
            if (tarExit !== 0) { discardPartial(); reject(new Error(`tar exited with code ${tarExit}`)) }
            else resolve()
        }
        const fail = err => { if (!settled) { settled = true; discardPartial(); reject(err) } }

        tarProc.stdout.pipe(storeStream).pipe(writeStream)
        tarProc.stderr.on('data', () => {})
        tarProc.on('error', fail)
        storeStream.on('error', fail)
        writeStream.on('error', fail)
        writeStream.on('finish', () => { written = true; settle() })
        tarProc.on('close', code => { tarExit = code; settle() })
    })
}

async function makeBootstrapUtxoTracker(coin, network) {
    const defaultConfig = await getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    const outputDir     = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
    // Routed through the shared helper (uuid:a61fc673): the unprefixed name
    // used here previously backed up the wrong stack's data under a
    // non-default NODE_PREFIX.
    const volumeName    = getUtxoTrackerVolumeName(coin, network)
    const archiveName   = `${network}${SEP}${XChainService.XCHAIN_UTXO_TRACKER}${SEP}${buildDateTimeString()}.tar.gz`
    const workDir       = getWorkDir(coin, network, XChainService.XCHAIN_UTXO_TRACKER)
    const innerArchive  = path.join(workDir, 'data.tar.gz')
    const checksumFile  = path.join(workDir, 'data.sha256')
    const finalOutput   = path.join(outputDir, archiveName)

    // Drop a snapshot left behind by a crashed run BEFORE measuring, so the
    // estimate describes the real dataset and no stale directory can end up
    // inside the archive on the stopped-container fallback path. Deliberately
    // not swallowed: failing here costs no downtime, whereas publishing a
    // snapshot-polluted archive is silent corruption.
    await removeTrackerSnapshot(volumeName)

    let totalBytes = 0
    try {
        const { stdout } = await execFileAsync(
            'docker', ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'du', '-sb', '/data']
        )
        totalBytes = parseInt(stdout.trim().split(/\s+/)[0], 10) || 0
    } catch {
        console.log('Could not estimate volume size, progress will show as ?%')
    }

    // Refuse now if either filesystem cannot hold it. Checked before the stop
    // below, so a capacity failure never costs the tracker any downtime.
    assertBootstrapCapacity(workDir, outputDir, totalBytes, `${coin}/${network} utxo-tracker`)

    // Warn, don't refuse: the snapshot below pins every SST the tracker compacts
    // away while the compress runs, so the VOLUME (not just the staging and
    // output filesystems checked above) needs churn headroom for the length of
    // the run. Refusing here would be worse than the old behavior, but filling
    // the volume halts the tracker, so the operator should hear about it.
    await warnOnThinTrackerVolume(volumeName, totalBytes)

    const containerId = await db.getModuleContainer(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    if (!containerId) throw new Error(`utxo-tracker container not found for ${coin}/${network}`)

    // Staging and output dirs are prepared before the stop for the same reason
    // as the capacity check: a read-only mount or a missing parent should not be
    // discovered with the tracker already dark.
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true })
    ensureDir(workDir)
    await ensureDirWritable(outputDir)

    // Declared BEFORE the stop, so the first probe that sees the tracker gone
    // already has the operator's reason for it. The encoder keeps reporting the
    // outage truthfully (tracker_reachable:false, 503); this only lets the
    // public board call it Maintenance instead of Degraded. Best-effort by
    // construction: a status label must never hold up a publish.
    let maintenanceDeclared = await declareEncoderMaintenance(coin, network, {
        reason: `${XChainService.XCHAIN_UTXO_TRACKER} bootstrap publish`
    })
    // Ends the window the moment the tracker is back, not when the whole
    // multi-hour compress finishes: on the snapshot path the encoder recovers
    // seconds after the stop, and leaving the window open would have /status
    // advertising maintenance on an encoder that is serving again. Idempotent,
    // and never throws for the same reason the declare does not.
    const endMaintenanceWindow = async () => {
        if (!maintenanceDeclared) return
        maintenanceDeclared = false
        await clearEncoderMaintenance(coin, network)
    }

    console.log(`Stopping ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
    await stopContainer(containerId)

    let snapshotTaken     = false
    let containerRestored = false
    try {
        try {
            snapshotTaken = await snapshotTrackerVolume(volumeName)
        } catch (err) {
            console.log(`Volume snapshot unavailable (${err.message}); compressing with the tracker stopped.`)
            // A half-written snapshot must not be swept into the fallback
            // archive, and a volume we cannot clean is not one we can publish
            // from: let this throw into the outer finally, which restarts the
            // container.
            await removeTrackerSnapshot(volumeName)
        }

        // The whole point of the snapshot: the outage ends HERE, seconds after
        // the stop, instead of after the multi-hour compress below. Without it
        // the monthly cron took each mainnet encoder's tracker dark for the
        // full run (2026-08-01: 3h36m BTC, 1h04m LTC, 42m DOGE), which the
        // encoder correctly published as tracker_reachable:false.
        if (snapshotTaken) {
            console.log(`Starting ${XChainService.XCHAIN_UTXO_TRACKER} container (compressing from the snapshot)...`)
            await startContainer(containerId)
            containerRestored = true
            await endMaintenanceWindow()
        }

        const tarSource = snapshotTaken ? `/data/${TRACKER_SNAPSHOT_DIR}` : '/data'

        const progress = startProgress('Compressing LevelDB data...', totalBytes)
        // Hashed inline off the gzip output rather than by re-reading the
        // finished file: at tracker scale that second full read was another
        // pass over 162.5 GB to learn something the write already knew.
        const innerHash = crypto.createHash('sha256')
        await new Promise((resolve, reject) => {
            const tarProc     = spawn('docker', ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'tar', 'cf', '-', '-C', tarSource, '.'])
            const counter     = new PassThrough()
            const gzipStream  = zlib.createGzip()
            const writeStream = fs.createWriteStream(innerArchive)

            counter.on('data', chunk => progress.update(chunk.length))
            gzipStream.on('data', chunk => innerHash.update(chunk))

            tarProc.stdout.pipe(counter).pipe(gzipStream).pipe(writeStream)

            tarProc.stderr.on('data', () => {})
            tarProc.on('error', err => reject(err))
            writeStream.on('error', err => reject(err))
            writeStream.on('finish', resolve)
            tarProc.on('close', code => {
                if (code !== 0) reject(new Error(`docker tar exited with code ${code}`))
            })
        })
        const innerStats = await fs.promises.stat(innerArchive)
        progress.stop(`LevelDB compressed: ${(innerStats.size / 1024 / 1024).toFixed(1)} MB`)

        const checksum = innerHash.digest('hex')
        await fs.promises.writeFile(checksumFile, `${checksum}  data.tar.gz\n`)
        console.log(`Checksum: ${checksum}`)

        console.log(`Wrapping into ${archiveName}...`)
        await writeStoredGzipTar(finalOutput, workDir, ['data.tar.gz', 'data.sha256'])

        await maybeSignBootstrap(finalOutput)

        fs.rmSync(workDir, { recursive: true })
        console.log(redactSecrets(`Bootstrap created: ${finalOutput}`))

    } finally {
        // Cleanup first, but never let it throw past the restart: a pinned
        // snapshot costs disk, a tracker left stopped costs the encoder.
        try {
            await removeTrackerSnapshot(volumeName)
        } catch (err) {
            console.log(`Warning: could not remove /data/${TRACKER_SNAPSHOT_DIR} in ${volumeName} (${err.message}); it holds disk until removed.`)
        }
        if (!containerRestored) {
            console.log(`Starting ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
            await startContainer(containerId)
        }
        // After the restart, always: the fallback path held the window for the
        // whole compress, and a failed run must not leave the board excusing an
        // encoder that is serving again.
        await endMaintenanceWindow()
    }

    return true
}

async function makeBootstrapMariaDb(coin, network, module) {
    const { askMariadbRootPassword } = require('./DatabaseService')

    const defaultConfig = await getDefaultConfig(module, coin, network)
    const outputDir     = module === XChainService.XCHAIN_DECODER
        ? defaultConfig["DECODER_BOOTSTRAP_VOLUME"]
        : defaultConfig["INDEXER_BOOTSTRAP_VOLUME"]
    const dbName        = getModuleDatabaseName(module, coin, network)
    const archiveName   = `${network}${SEP}${module}${SEP}${buildDateTimeString()}.tar.gz`
    const workDir       = getWorkDir(coin, network, module)
    const innerArchive  = path.join(workDir, 'dump.sql.gz')
    const checksumFile  = path.join(workDir, 'dump.sha256')
    const finalOutput   = path.join(outputDir, archiveName)

    // In external-DB mode there is no local container; talk to the DB over the
    // native connection (mirrors restoreBootstrapMariaDb's EXTERNAL_DB branch)
    // so bootstrap publishing works from an external-DB host too.
    let dbContainerId = null
    let rootPassword  = null
    let externalCfg   = null
    if (EXTERNAL_DB) {
        externalCfg = await getExternalDbConfig()
    } else {
        dbContainerId = await getDatabaseContainerId()
        if (!dbContainerId) throw new Error('MariaDB container not found')
        rootPassword = await askMariadbRootPassword(coin, network)
    }

    let totalBytes = 0
    try {
        const sizeQuery = `SELECT SUM(DATA_LENGTH + INDEX_LENGTH) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${dbName}'`
        let sizeOut
        if (EXTERNAL_DB) {
            sizeOut = await executeNativeMariaDbCommand(externalCfg, sizeQuery, '-BN')
        } else {
            const { stdout } = await execFileAsync(
                'docker', dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', '-BN', '-e', sizeQuery, 'information_schema']),
                { env: mariadbEnv(rootPassword) }
            )
            sizeOut = stdout
        }
        totalBytes = parseInt(String(sizeOut).trim(), 10) || 0
    } catch {
        console.log('Could not estimate DB size, progress will show as ?%')
    }

    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true })
    ensureDir(workDir)
    await ensureDirWritable(outputDir)

    const progress = startProgress(`Dumping ${dbName}...`, totalBytes)
    await new Promise((resolve, reject) => {
        const dumpProc    = EXTERNAL_DB
            ? spawn('mariadb-dump',
                ['-h', externalCfg.host, '-P', String(externalCfg.port), '-u', externalCfg.root_user,
                 '--single-transaction', '--routines', '--triggers', dbName],
                { env: mariadbEnv(externalCfg.root_password) })
            : spawn('docker', dockerMariadbArgs(dbContainerId, ['mariadb-dump', '-u', 'root', '--single-transaction', '--routines', '--triggers', dbName], { interactive: true }), { env: mariadbEnv(rootPassword) })
        const counter     = new PassThrough()
        const gzipStream  = zlib.createGzip()
        const writeStream = fs.createWriteStream(innerArchive)

        counter.on('data', chunk => progress.update(chunk.length))

        dumpProc.stdout.pipe(counter).pipe(gzipStream).pipe(writeStream)

        dumpProc.stderr.on('data', () => {})
        dumpProc.on('error', err => reject(err))
        writeStream.on('error', err => reject(err))
        writeStream.on('finish', resolve)
        dumpProc.on('close', code => {
            if (code !== 0) reject(new Error(`mariadb-dump exited with code ${code}`))
        })
    })
    const innerStats = await fs.promises.stat(innerArchive)
    progress.stop(`${dbName} dumped: ${(innerStats.size / 1024 / 1024).toFixed(1)} MB compressed`)

    process.stdout.write('Computing checksum... ')
    const checksum = await computeSha256(innerArchive)
    await fs.promises.writeFile(checksumFile, `${checksum}  dump.sql.gz\n`)
    console.log(checksum)

    console.log(`Wrapping into ${archiveName}...`)
    await execFileAsync('tar', ['czf', finalOutput, '-C', workDir, 'dump.sql.gz', 'dump.sha256'])

    await maybeSignBootstrap(finalOutput)

    fs.rmSync(workDir, { recursive: true })
    console.log(redactSecrets(`Bootstrap created: ${finalOutput}`))

    return true
}

async function restoreBootstrap(coin, network, module, fileName) {
    switch (module) {
        case XChainService.XCHAIN_UTXO_TRACKER:
            return restoreBootstrapUtxoTracker(coin, network, fileName)
        case XChainService.XCHAIN_DECODER:
        case XChainService.XCHAIN_INDEXER:
            return restoreBootstrapMariaDb(coin, network, module, fileName)
        default:
            throw new Error(`Unsupported module for bootstrap restore: ${module}`)
    }
}

async function restoreBootstrapUtxoTracker(coin, network, fileName) {
    const defaultConfig = await getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    const bootstrapDir  = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]
    const archivePath   = path.join(bootstrapDir, fileName)
    // Routed through the shared helper (uuid:a61fc673): the unprefixed name
    // used here previously unpacked into the wrong stack's volume under a
    // non-default NODE_PREFIX.
    const volumeName    = getUtxoTrackerVolumeName(coin, network)
    const workDir       = getWorkDir(coin, network, `${XChainService.XCHAIN_UTXO_TRACKER}-restore`)

    if (!fs.existsSync(archivePath)) throw new Error(`Bootstrap file not found: ${archivePath}`)

    // Supply-chain gate: the embedded data.sha256 below only detects transport
    // corruption (it ships inside the same archive). Provenance comes from the
    // detached signature checked here.
    await checkBootstrapSignature(archivePath)

    // Extract + verify the inner archive against the checksum that shipped
    // inside the signature-verified outer archive (resumable, but the reused
    // bytes are always re-bound to the verified archive; see the helper).
    const innerArchive = await ensureVerifiedInnerArchive(archivePath, workDir, 'data.tar.gz', 'data.sha256')

    // Make sure the DB pool is open first; when this routine is invoked outside
    // the CLI precheck the pool is null, and getModuleContainer would silently
    // return null, masquerading as a missing container.
    await ensureDatabasePool()
    const containerId = await db.getModuleContainer(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    if (!containerId) {
        if (!db.isReady()) {
            throw new Error(`utxo-tracker container lookup failed: MariaDB connection pool is not initialized for ${coin}/${network}`)
        }
        throw new Error(`utxo-tracker container not found for ${coin}/${network} (DB pool is ready but no matching row in the modules table)`)
    }

    console.log(`Stopping ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
    await stopContainer(containerId)

    try {
        console.log('Clearing LevelDB volume...')
        await execFileAsync('docker', ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c', 'find /data -mindepth 1 -delete'])

        const stats      = await fs.promises.stat(innerArchive)
        const totalBytes = stats.size
        const progress   = startProgress('Restoring LevelDB data...', totalBytes)

        await new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(innerArchive)
            const counter    = new PassThrough()
            const gunzip     = zlib.createGunzip()
            const tarProc    = spawn('docker', ['run', '--rm', '-i', '-v', `${volumeName}:/data`, 'alpine', 'tar', 'xf', '-', '-C', '/data'], { stdio: ['pipe', 'inherit', 'pipe'] })

            counter.on('data', chunk => progress.update(chunk.length))
            readStream.pipe(counter).pipe(gunzip).pipe(tarProc.stdin)

            readStream.on('error', err => reject(err))
            gunzip.on('error',    err => reject(err))
            tarProc.on('error',   err => reject(err))
            tarProc.on('close', code => {
                if (code === 0) resolve()
                else reject(new Error(`docker tar restore exited with code ${code}`))
            })
        })
        progress.stop('LevelDB data restored')

        fs.rmSync(workDir, { recursive: true })
        console.log('Bootstrap restore complete')

    } catch (err) {
        // Post-wipe regime (uuid:7edc76f3). Every statement in the try above runs
        // at or after `find /data -mindepth 1 -delete`, so a failure here leaves
        // the LevelDB store partially wiped. Restarting the container over it (the
        // old unconditional `finally`) boots a fresh XChainUtxoTracker with
        // halted=false, so get_sync_status / GET /status report a normal non-503
        // status and BootstrapHealthGate has nothing to refuse on: an emptied
        // store reads as caught up. Mirrors the tracker's own contract in
        // xchain-utxo-tracker/src/bootstrap-recovery.js `handleRestoreFailure`,
        // where a post-wipe abort fails loud instead of resuming.
        err.postWipe = true
        console.log(
            `[fatal] ${XChainService.XCHAIN_UTXO_TRACKER} bootstrap restore failed AFTER the LevelDB\n` +
            `volume was wiped; the store is incomplete and the container has been left STOPPED so it\n` +
            `cannot report a wiped store as caught up. Re-run the restore with\n` +
            `XCHAIN_NODE_FORCE_BOOTSTRAP=1, or clear the volume and resync from scratch.`
        )
        throw err
    }

    console.log(`Starting ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
    await startContainer(containerId)

    return true
}

async function restoreBootstrapMariaDb(coin, network, module, fileName) {
    const { askMariadbRootPassword } = require('./DatabaseService')

    const defaultConfig = await getDefaultConfig(module, coin, network)
    const bootstrapDir  = module === XChainService.XCHAIN_DECODER
        ? defaultConfig["DECODER_BOOTSTRAP_VOLUME"]
        : defaultConfig["INDEXER_BOOTSTRAP_VOLUME"]
    const archivePath   = path.join(bootstrapDir, fileName)
    const dbName        = getModuleDatabaseName(module, coin, network)
    const workDir       = getWorkDir(coin, network, `${module}-restore`)

    if (!fs.existsSync(archivePath)) throw new Error(`Bootstrap file not found: ${archivePath}`)

    // Supply-chain gate: the embedded dump.sha256 below only detects transport
    // corruption (it ships inside the same archive). Provenance comes from the
    // detached signature checked here.
    await checkBootstrapSignature(archivePath)

    // Extract + verify the inner archive against the checksum that shipped
    // inside the signature-verified outer archive (resumable, but the reused
    // bytes are always re-bound to the verified archive; see the helper).
    const innerArchive = await ensureVerifiedInnerArchive(archivePath, workDir, 'dump.sql.gz', 'dump.sha256')

    let dbContainerId = null
    let rootPassword  = null
    let externalCfg   = null

    if (EXTERNAL_DB) {
        externalCfg = await getExternalDbConfig()
    } else {
        dbContainerId = await getDatabaseContainerId()
        if (!dbContainerId) throw new Error('MariaDB container not found')
        rootPassword = await askMariadbRootPassword(coin, network)
    }

    // Stop the service that owns this DB so it isn't writing rows or holding
    // connections while we DROP and reimport (mirrors the utxo-tracker path,
    // which stops the tracker before clearing its volume). Best-effort: a
    // manual restore run before the service is installed has no container to
    // stop. Open the DB pool first so getModuleContainer can resolve the row.
    await ensureDatabasePool()
    let serviceContainerId = null
    try {
        serviceContainerId = await db.getModuleContainer(module, coin, network)
    } catch { /* service not installed yet, proceed without stopping */ }
    if (serviceContainerId) {
        console.log(`Stopping ${module} container...`)
        await stopContainer(serviceContainerId)
    }

    try {
        console.log(`Recreating database ${dbName}...`)
        if (EXTERNAL_DB) {
            // Driver-based path: DROP and CREATE as separate statements (the
            // mariadb driver rejects multi-statement strings unlike the CLI).
            await executeNativeMariaDbCommand(externalCfg, `DROP DATABASE IF EXISTS ${dbName}`)
            await executeNativeMariaDbCommand(externalCfg, `CREATE DATABASE ${dbName}`)
        } else {
            await execFileAsync(
                'docker', dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', '-e', `DROP DATABASE IF EXISTS ${dbName}; CREATE DATABASE ${dbName}`]),
                { env: mariadbEnv(rootPassword) }
            )
        }

        const stats      = await fs.promises.stat(innerArchive)
        const totalBytes = stats.size
        const progress   = startProgress(`Restoring ${dbName}...`, totalBytes)

        await new Promise((resolve, reject) => {
            const readStream  = fs.createReadStream(innerArchive)
            const counter     = new PassThrough()
            const gunzip      = zlib.createGunzip()

            // For external (native) MariaDB, invoke the mariadb CLI directly
            // over TCP. The password travels via MYSQL_PWD env only, never argv.
            let mysqlProc
            if (EXTERNAL_DB) {
                mysqlProc = spawn('mariadb',
                    ['-h', externalCfg.host, '-P', String(externalCfg.port),
                     '-u', externalCfg.root_user, dbName],
                    { stdio: ['pipe', 'inherit', 'pipe'], env: mariadbEnv(externalCfg.root_password) })
            } else {
                mysqlProc = spawn('docker', dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', dbName], { interactive: true }),
                    { stdio: ['pipe', 'inherit', 'pipe'], env: mariadbEnv(rootPassword) })
            }

            counter.on('data', chunk => progress.update(chunk.length))
            readStream.pipe(counter).pipe(gunzip).pipe(mysqlProc.stdin)

            readStream.on('error',  err => reject(err))
            gunzip.on('error',      err => reject(err))
            mysqlProc.on('error',   err => reject(err))
            mysqlProc.on('close', code => {
                if (code === 0) resolve()
                else reject(new Error(`mariadb restore exited with code ${code}`))
            })
        })
        progress.stop(`${dbName} restored`)

        fs.rmSync(workDir, { recursive: true })
        console.log('Bootstrap restore complete')

        return true
    } finally {
        // Always restart the service so a failed restore doesn't leave it down.
        if (serviceContainerId) {
            console.log(`Starting ${module} container...`)
            await startContainer(serviceContainerId)
        }
    }
}

// Whether the utxo-tracker LevelDB volume already holds data. Used as a
// race-free freshness gate: it must be checked BEFORE the container starts,
// because a freshly-started tracker creates an (empty) LevelDB immediately.
// Returns false when the volume is absent or empty (i.e. a fresh install).
async function utxoTrackerVolumeHasData(coin, network) {
    // Routed through the shared helper (uuid:a61fc673): the unprefixed name
    // used here previously read the wrong stack's freshness under a
    // non-default NODE_PREFIX.
    const volumeName = getUtxoTrackerVolumeName(coin, network)
    try {
        await execFileAsync('docker', ['volume', 'inspect', volumeName])
    } catch {
        return false // volume doesn't exist yet (fresh install)
    }
    try {
        const { stdout } = await execFileAsync('docker',
            ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c', 'ls -A /data 2>/dev/null | head -1'])
        return stdout.trim().length > 0
    } catch {
        return false
    }
}

// Age in whole days of the resolved archive, from the UTC <YYYYMMDD_HHMMSS>
// stamp in its name (the field latest.php orders by). Null when the name
// carries none, as a hand-placed latest.tgz does.
function bootstrapArchiveAgeDays(archiveUrl, now = Date.now()) {
    const stamp = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(path.basename(archiveUrl || ''))
    if (!stamp) return null
    const [, y, mo, d, h, mi, s] = stamp
    const published = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
    if (!Number.isFinite(published)) return null
    const days = Math.floor((now - published) / 86400000)
    return days >= 0 ? days : null
}

// Days before a published archive is called out at restore time. Warn, never
// refuse: a stale archive still beats the days of scratch sync refusing costs.
// Above the weekly publish cadence, so only a publisher that missed runs trips it.
const BOOTSTRAP_STALE_AFTER_DAYS = 10

// Stream <BOOTSTRAP_BASE_URL>/<module>/<coin>/<network>/latest.tgz into destDir
// as latest.tgz. Returns the filename on success, null when none is published
// (404). Follows the http→https redirect. Throws on other network errors.
async function downloadBootstrap(coin, network, module, destDir) {
    const url      = `${BOOTSTRAP_BASE_URL}/${module}/${coin}/${network}/latest.tgz`
    const destPath = path.join(destDir, 'latest.tgz')
    // destDir is the bind-mounted bootstrap volume, which a service container
    // may already have created root-owned; the writable variant chowns it back
    // (same failure ensureDirWritable was written for on the create path).
    await ensureDirWritable(destDir)

    const response = await axios({
        method: 'get',
        url,
        responseType: 'stream',
        maxRedirects: 5,
        timeout: 60000,                 // connect/headers timeout; body has no timeout
        validateStatus: s => s === 200 || s === 404
    })
    if (response.status === 404) return null

    const totalBytes = parseInt(response.headers['content-length'] || '0', 10)
    const progress   = startProgress(`Downloading bootstrap (${module} ${coin}/${network})...`, totalBytes)
    try {
        await new Promise((resolve, reject) => {
            const counter     = new PassThrough()
            const writeStream = fs.createWriteStream(destPath)
            counter.on('data', chunk => progress.update(chunk.length))
            response.data.pipe(counter).pipe(writeStream)
            response.data.on('error', reject)
            writeStream.on('error',   reject)
            writeStream.on('finish',  resolve)
        })
    } finally {
        progress.stop('Bootstrap downloaded')
    }

    // Also fetch the detached signature published next to the archive. A 404
    // means this bootstrap is unsigned; remove any stale local .sig so the
    // restore's signature policy sees the true current state instead of
    // verifying today's archive against yesterday's signature.
    //
    // Pin the .sig to the archive we ACTUALLY downloaded (#2259): latest.tgz
    // resolves per-request to the newest archive, and a multi-GB download spans
    // a long window, so a second independent "latest" resolution for the
    // signature can land on an archive published mid-download; the bytes of
    // archive A then verify against B's signature and the restore is refused
    // (fail-closed) on perfectly good data. The archive request's final
    // redirected URL names the concrete archive, and the publisher writes
    // <archive>.sig next to it, so derive the sig URL from that. Fall back to
    // latest.tgz.sig when no redirect happened (a manually-dropped real
    // latest.tgz is served directly and its .sig sits beside it).
    const finalUrl = response.request && response.request.res && response.request.res.responseUrl
        ? response.request.res.responseUrl : url

    // Report the age during the install, not after a halt traced back to it.
    // Only the tracker can be left unable to walk forward, so only it is warned
    // about that; the others just resync from the archive height.
    const ageDays = bootstrapArchiveAgeDays(finalUrl)
    if (ageDays !== null && ageDays >= BOOTSTRAP_STALE_AFTER_DAYS) {
        const consequence = module === XChainService.XCHAIN_UTXO_TRACKER
            ? '  A snapshot whose tip has drifted past the chain it is restored onto can leave the tracker\n' +
              '  unable to walk forward, which halts it until it is reset and rebuilt. If that happens, the\n' +
              '  archive is the cause, not your host.'
            : '  It still restores; the service resyncs forward from the archive height, which just takes longer\n' +
              '  the older the archive is.'
        console.log(
            `WARNING: the published ${module} bootstrap for ${coin}/${network} is ${ageDays} days old ` +
            `(${path.basename(finalUrl)}).\n` + consequence
        )
    }

    const sigPath = destPath + BOOTSTRAP_SIG_SUFFIX
    const sigResponse = await axios({
        method: 'get',
        url: finalUrl + BOOTSTRAP_SIG_SUFFIX,
        responseType: 'text',
        maxRedirects: 5,
        timeout: 60000,
        validateStatus: s => s === 200 || s === 404
    })
    if (sigResponse.status === 200) {
        await fs.promises.writeFile(sigPath, sigResponse.data)
    } else if (fs.existsSync(sigPath)) {
        fs.rmSync(sigPath, { force: true })
    }

    return 'latest.tgz'
}

// What each service's bootstrap attempt did, for the end-of-install summary:
// a skipped restore is the difference between a published height and hours of
// rescanning, too costly to leave as one warning mid-log. Reset per run.
const bootstrapOutcomes = []

function recordBootstrapOutcome(module, status, detail) {
    bootstrapOutcomes.push({ module, status, detail })
}

function resetBootstrapOutcomes() {
    bootstrapOutcomes.length = 0
}

// Printed at the end of install/update. Says nothing when no bootstrap was
// attempted, so ordinary runs stay quiet.
function reportBootstrapOutcomes() {
    if (bootstrapOutcomes.length === 0) return
    const failed = bootstrapOutcomes.filter((o) => o.status === 'failed')
    // Wiped-then-failed is NOT part of `failed`: those services are down, not
    // syncing from block 0, so the paragraph below would misdescribe them.
    const wipedDown = bootstrapOutcomes.filter((o) => o.status === 'wiped-left-down')
    console.log('\nBootstrap restore summary:')
    for (const o of bootstrapOutcomes) {
        const line = o.status === 'restored' ? 'restored'
            : o.status === 'none-published' ? 'none published, syncing from scratch'
            : o.status === 'disabled' ? 'disabled by XCHAIN_NODE_NO_BOOTSTRAP'
            : o.status === 'wiped-left-down' ? `NOT restored, DATA WIPED, container left stopped: ${o.detail}`
            : `NOT restored: ${o.detail}`
        console.log(`  ${o.module}: ${line}`)
    }
    if (wipedDown.length > 0) {
        console.log(
            '\nThose services had their data directory wiped by a restore that then failed, so\n' +
            'their containers were deliberately left STOPPED rather than restarted over an\n' +
            'incomplete store that would report itself caught up. Re-run install with\n' +
            'XCHAIN_NODE_FORCE_BOOTSTRAP=1 to take the restore again, or clear the volume and\n' +
            'start the service to resync from block 0.\n'
        )
    }
    if (failed.length > 0) {
        console.log(
            '\nThose services are now syncing from block 0, which takes hours to days\n' +
            'rather than minutes. Fix the cause above, then re-run install with\n' +
            'XCHAIN_NODE_FORCE_BOOTSTRAP=1 to take the restore again: without it a\n' +
            'service that has already started syncing is left alone.\n'
        )
    }
}

// Opt-in restore over an already-populated service. Off by default because the
// restore wipes the data directory; needed because a failed restore leaves a
// service scratch-syncing, which reads as populated to every later run.
function forceBootstrapRequested() {
    const v = process.env.XCHAIN_NODE_FORCE_BOOTSTRAP
    return v !== undefined && v !== '' && v !== '0'
}

// On a FRESH utxo-tracker install, download the published bootstrap and restore
// it. Best-effort: any failure (no bootstrap published, download/restore error)
// logs a warning and returns so the install proceeds with a normal sync.
async function ensureBootstrapUtxoTracker(coin, network) {
    if (process.env.XCHAIN_NODE_NO_BOOTSTRAP) {
        console.log('Bootstrap auto-restore disabled (XCHAIN_NODE_NO_BOOTSTRAP): syncing from scratch')
        recordBootstrapOutcome(XChainService.XCHAIN_UTXO_TRACKER, 'disabled')
        return false
    }
    try {
        const defaultConfig = await getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
        const bootstrapDir  = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]

        console.log(`Checking for a published bootstrap for ${coin}/${network}...`)
        const fileName = await downloadBootstrap(coin, network, XChainService.XCHAIN_UTXO_TRACKER, bootstrapDir)
        if (!fileName) {
            console.log('No bootstrap available; the tracker will sync from scratch')
            recordBootstrapOutcome(XChainService.XCHAIN_UTXO_TRACKER, 'none-published')
            return false
        }
        await restoreBootstrap(coin, network, XChainService.XCHAIN_UTXO_TRACKER, fileName)
        console.log('Bootstrap installed; tracker will continue from the bootstrap height')
        recordBootstrapOutcome(XChainService.XCHAIN_UTXO_TRACKER, 'restored')
        return true
    } catch (err) {
        const reason = redactSecrets(err.message)
        // A post-wipe abort did NOT leave a scratch-syncing tracker: the store was
        // emptied and the container was left stopped (uuid:7edc76f3), so the old
        // "will sync from scratch" wording described a state that is not on disk.
        if (err.postWipe) {
            console.log(
                `WARNING: bootstrap auto-restore failed (${reason}) AFTER the LevelDB volume was wiped: ` +
                `the tracker store is incomplete and its container was left stopped, not syncing.`
            )
            recordBootstrapOutcome(XChainService.XCHAIN_UTXO_TRACKER, 'wiped-left-down', reason)
            return false
        }
        console.log(`WARNING: bootstrap auto-restore failed (${reason}): the tracker will sync from scratch`)
        recordBootstrapOutcome(XChainService.XCHAIN_UTXO_TRACKER, 'failed', reason)
        return false
    }
}

// Whether the decoder/indexer MariaDB database already holds indexed data.
// The MariaDB analogue of utxoTrackerVolumeHasData: a fresh install has either
// no database yet or an empty `blocks` table (both decoder and indexer carry a
// `blocks` table that fills as they follow the chain). Used as the freshness
// gate before the service container starts decoding/indexing. Best-effort:
// any lookup error is treated as "fresh" so install proceeds with a normal sync.
async function mariaDbModuleHasData(coin, network, module) {
    const { askMariadbRootPassword } = require('./DatabaseService')
    const dbName = getModuleDatabaseName(module, coin, network)

    // External-DB mode has no local `xchain-node-database` container, so the
    // container-id lookup below always returns null and would report "fresh"
    // regardless of how much data the external DB holds, re-triggering the
    // bootstrap DROP/restore over a populated database on every install/update.
    // Check freshness over the native connection instead (mirrors the
    // EXTERNAL_DB branch in restoreBootstrapMariaDb / resetDatabases).
    if (EXTERNAL_DB) {
        try {
            const externalCfg = await getExternalDbConfig()
            const existsQuery = `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${dbName}' AND TABLE_NAME = 'blocks'`
            const tblOut = await executeNativeMariaDbCommand(externalCfg, existsQuery, '-BN')
            if (parseInt(String(tblOut).trim(), 10) === 0) return false
            const countQuery = `SELECT COUNT(*) FROM \`${dbName}\`.blocks`
            const cntOut = await executeNativeMariaDbCommand(externalCfg, countQuery, '-BN')
            return parseInt(String(cntOut).trim(), 10) > 0
        } catch {
            return false
        }
    }

    let dbContainerId
    try {
        dbContainerId = await getDatabaseContainerId()
    } catch { return false }
    if (!dbContainerId) return false // no DB container yet (fresh install)

    let rootPassword
    try {
        rootPassword = await askMariadbRootPassword(coin, network)
    } catch { return false }

    try {
        // Does the `blocks` table exist? (DB or table absent ⇒ fresh)
        const existsQuery = `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${dbName}' AND TABLE_NAME = 'blocks'`
        const { stdout: tblOut } = await execFileAsync(
            'docker', dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', '-BN', '-e', existsQuery, 'information_schema']),
            { env: mariadbEnv(rootPassword) }
        )
        if (parseInt(tblOut.trim(), 10) === 0) return false

        // Table exists: does it hold any rows?
        const countQuery = `SELECT COUNT(*) FROM \`${dbName}\`.blocks`
        const { stdout: cntOut } = await execFileAsync(
            'docker', dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', '-BN', '-e', countQuery]),
            { env: mariadbEnv(rootPassword) }
        )
        return parseInt(cntOut.trim(), 10) > 0
    } catch {
        return false
    }
}

// On a FRESH decoder/indexer install, download the published bootstrap and
// restore it. Best-effort, mirroring ensureBootstrapUtxoTracker: any failure
// (none published, download/restore error) logs a warning and returns so the
// install proceeds with a normal sync from scratch.
async function ensureBootstrapMariaDb(coin, network, module) {
    if (process.env.XCHAIN_NODE_NO_BOOTSTRAP) {
        console.log('Bootstrap auto-restore disabled (XCHAIN_NODE_NO_BOOTSTRAP): syncing from scratch')
        recordBootstrapOutcome(module, 'disabled')
        return false
    }
    try {
        const defaultConfig = await getDefaultConfig(module, coin, network)
        const bootstrapDir  = module === XChainService.XCHAIN_DECODER
            ? defaultConfig["DECODER_BOOTSTRAP_VOLUME"]
            : defaultConfig["INDEXER_BOOTSTRAP_VOLUME"]

        console.log(`Checking for a published ${module} bootstrap for ${coin}/${network}...`)
        const fileName = await downloadBootstrap(coin, network, module, bootstrapDir)
        if (!fileName) {
            console.log('No bootstrap available; the service will sync from scratch')
            recordBootstrapOutcome(module, 'none-published')
            return false
        }
        await restoreBootstrap(coin, network, module, fileName)
        console.log('Bootstrap installed; the service will continue from the bootstrap height')
        recordBootstrapOutcome(module, 'restored')
        return true
    } catch (err) {
        const reason = redactSecrets(err.message)
        console.log(`WARNING: bootstrap auto-restore failed (${reason}): the service will sync from scratch`)
        recordBootstrapOutcome(module, 'failed', reason)
        return false
    }
}

// The services a bootstrap archive can be built from, in the order the
// publisher lists them.
const BOOTSTRAPPABLE_SERVICES = [
    XChainService.XCHAIN_DECODER,
    XChainService.XCHAIN_INDEXER,
    XChainService.XCHAIN_UTXO_TRACKER
]

// Every served <service>:<coin>:<network> combo, read from the module REGISTRY
// rather than from live containers. publish-bootstraps.sh --all used to build
// its plan from `docker ps`, so a stopped or crash-looping combo was dropped
// before the source-health gate could report it and the cron exited 0
// while that consumer archive went stale (uuid:d0cfcba9). The registry keeps a
// row for a stopped container (DiscoveryService prunes against `docker ps -a`,
// not `docker ps`), so reading it puts every installed combo into the plan and
// lets the health gate refuse the unhealthy ones loudly.
//
// regtest is skipped: it is a throwaway local chain with no consumer archive.
async function listServedBootstrapCombos() {
    const rows = await db.getAllModuleContainers(null, null)
    const combos = new Set()
    for (const row of rows || []) {
        if (!BOOTSTRAPPABLE_SERVICES.includes(row.module)) continue
        if (!row.coin || !row.network) continue
        if (row.network === 'regtest') continue
        combos.add(`${row.module}:${row.coin}:${row.network}`)
    }
    return Array.from(combos).sort()
}

module.exports = {
    BootstrapIntegrityError,
    listServedBootstrapCombos,
    getBootstrapFilesList,
    makeBootstrap,
    restoreBootstrap,
    downloadBootstrap,
    utxoTrackerVolumeHasData,
    ensureBootstrapUtxoTracker,
    mariaDbModuleHasData,
    ensureBootstrapMariaDb,
    forceBootstrapRequested,
    reportBootstrapOutcomes,
    resetBootstrapOutcomes,
    bootstrapArchiveAgeDays,
    BOOTSTRAP_STALE_AFTER_DAYS,
    // Bootstrap signing (supply-chain integrity)
    signBootstrapArchive,
    verifyBootstrapSignature,
    checkBootstrapSignature,
    loadBootstrapPublicKey,
    ensureVerifiedInnerArchive
}
