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
const { assertSafeArchiveMemberNames }                = require('../utils/helpers')
const { dockerMariadbArgs, mariadbEnv }               = require('../utils/dockerMariadb')

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
        throw new Error(`Bootstrap signature file is malformed: ${sigPath}`)
    }
    const digestHex = await computeSha256(archivePath)
    const valid = crypto.verify(null, Buffer.from(digestHex, 'hex'), publicKey, Buffer.from(parts[2], 'base64'))
    if (!valid) {
        throw new Error(`Bootstrap signature verification FAILED for ${archivePath}: the archive does not match its published signature. Refusing to restore.`)
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
        throw new Error(`Refusing unsigned bootstrap: ${missing}. Signed bootstraps are required by default; set XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP=0 to override.`)
    }
    console.log(`WARNING: restoring bootstrap WITHOUT signature verification (${missing}). Signature enforcement disabled via XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP=0; the embedded checksum only detects transport corruption, not tampering.`)
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
    console.log(`Bootstrap signed: ${sigPath}`)
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
    if (!checksumMember) throw new Error(`Archive is malformed: missing ${checksumName}`)
    const { stdout: checksumBody } = await execFileAsync('tar', ['xzOf', archivePath, checksumMember], { maxBuffer: 1024 * 1024 })
    const expectedInnerSha = checksumBody.trim().split(/\s+/)[0]
    if (!/^[a-f0-9]{64}$/i.test(expectedInnerSha)) {
        throw new Error(`Archive ${checksumName} does not contain a valid SHA-256`)
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
        throw new Error(`Archive is malformed: missing ${innerName}`)
    }
    const computed = await computeSha256(innerArchive)
    if (computed !== expectedInnerSha) {
        fs.rmSync(workDir, { recursive: true })
        throw new Error(`Inner archive checksum mismatch\n  Expected: ${expectedInnerSha}\n  Got:      ${computed}`)
    }
    console.log('Outer archive extracted and inner checksum verified')
    return innerArchive
}

function getWorkDir(coin, network, module) {
    return path.join(tmpDir, `bootstrap-work-${coin}-${network}-${module}`)
}

// . Staging a bootstrap writes the whole dataset into the work dir, and
// tmpDir defaults to <repo>/tmp, which on a normal install is the ROOT
// filesystem. A 30G tracker archive staged there filled node-host-b's / to 100%
// and took the host down; the recovery was to point XCHAIN_NODE_TMP_DIR at the
// big volume, which works but only if you already know to do it.
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

// ─── Public: getBootstrapFilesList ───────────────────────────────

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
            // : only real archives are restorable. The directory also holds
            // the detached .sig (and older .sha256) sidecars, and listing those as
            // choices invites restoring a signature file.
            if (stats.isFile() && isBootstrapArchiveName(fileName))
                fileList.push({ name: fileName, mtimeMs: Number(stats.mtimeMs) || 0 })
        }
        // : NEWEST FIRST. This came back in raw readdir order, which is
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

// ─── Public: makeBootstrap ────────────────────────────────────────

async function makeBootstrap(coin, network, module) {
    switch (module) {
        case XChainService.XCHAIN_UTXO_TRACKER:
            return makeBootstrapUtxoTracker(coin, network)
        case XChainService.XCHAIN_DECODER:
        case XChainService.XCHAIN_INDEXER:
            return makeBootstrapMariaDb(coin, network, module)
        default:
            throw new Error(`Unsupported module for bootstrap create: ${module}`)
    }
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

    // Step 1: Estimate volume size
    let totalBytes = 0
    try {
        const { stdout } = await execFileAsync(
            'docker', ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'du', '-sb', '/data']
        )
        totalBytes = parseInt(stdout.trim().split(/\s+/)[0], 10) || 0
    } catch {
        console.log('Could not estimate volume size, progress will show as ?%')
    }

    // Step 1b: refuse now if either filesystem cannot hold it . Before
    // the stop below, so a capacity failure never costs the tracker any downtime.
    assertBootstrapCapacity(workDir, outputDir, totalBytes, `${coin}/${network} utxo-tracker`)

    // Step 2: Get container ID and stop service
    const containerId = await db.getModuleContainer(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
    if (!containerId) throw new Error(`utxo-tracker container not found for ${coin}/${network}`)

    console.log(`Stopping ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
    await stopContainer(containerId)

    try {
        // Prepare directories
        if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true })
        ensureDir(workDir)
        await ensureDirWritable(outputDir)

        // Step 3: Stream LevelDB volume through gzip → data.tar.gz
        const progress = startProgress('Compressing LevelDB data...', totalBytes)
        await new Promise((resolve, reject) => {
            const tarProc     = spawn('docker', ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'tar', 'cf', '-', '-C', '/data', '.'])
            const counter     = new PassThrough()
            const gzipStream  = zlib.createGzip()
            const writeStream = fs.createWriteStream(innerArchive)

            counter.on('data', chunk => progress.update(chunk.length))

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

        // Step 4: Compute SHA256 and write checksum file
        process.stdout.write('Computing checksum... ')
        const checksum = await computeSha256(innerArchive)
        await fs.promises.writeFile(checksumFile, `${checksum}  data.tar.gz\n`)
        console.log(checksum)

        // Step 5: Create outer wrapper archive
        console.log(`Wrapping into ${archiveName}...`)
        await execFileAsync('tar', ['czf', finalOutput, '-C', workDir, 'data.tar.gz', 'data.sha256'])

        // Step 5b: Sign the archive (publish the .sig next to it)
        await maybeSignBootstrap(finalOutput)

        // Cleanup work dir
        fs.rmSync(workDir, { recursive: true })
        console.log(`Bootstrap created: ${finalOutput}`)

    } finally {
        // Step 6: Always restart the container
        console.log(`Starting ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
        await startContainer(containerId)
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

    // Step 1: Get DB credentials (and container ID when not using external DB).
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

    // Step 2: Estimate DB size
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

    // Prepare directories
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true })
    ensureDir(workDir)
    await ensureDirWritable(outputDir)

    // Step 3: Stream mysqldump → gzip → dump.sql.gz
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

    // Step 4: Compute SHA256 and write checksum file
    process.stdout.write('Computing checksum... ')
    const checksum = await computeSha256(innerArchive)
    await fs.promises.writeFile(checksumFile, `${checksum}  dump.sql.gz\n`)
    console.log(checksum)

    // Step 5: Create outer wrapper archive
    console.log(`Wrapping into ${archiveName}...`)
    await execFileAsync('tar', ['czf', finalOutput, '-C', workDir, 'dump.sql.gz', 'dump.sha256'])

    // Step 5b: Sign the archive (publish the .sig next to it)
    await maybeSignBootstrap(finalOutput)

    // Cleanup work dir
    fs.rmSync(workDir, { recursive: true })
    console.log(`Bootstrap created: ${finalOutput}`)

    return true
}

// ─── Public: restoreBootstrap ─────────────────────────────────────

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

    // Steps 1-2: extract + verify the inner archive against the checksum that
    // shipped inside the signature-verified outer archive (resumable, but the
    // reused bytes are always re-bound to the verified archive; see the helper).
    const innerArchive = await ensureVerifiedInnerArchive(archivePath, workDir, 'data.tar.gz', 'data.sha256')

    // Step 3: Get container ID and stop service
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
        // Step 4: Clear volume
        console.log('Clearing LevelDB volume...')
        await execFileAsync('docker', ['run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c', 'find /data -mindepth 1 -delete'])

        // Step 5: Restore data.tar.gz into volume with progress
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

        // Cleanup
        fs.rmSync(workDir, { recursive: true })
        console.log('Bootstrap restore complete')

    } finally {
        // Step 6: Always restart container
        console.log(`Starting ${XChainService.XCHAIN_UTXO_TRACKER} container...`)
        await startContainer(containerId)
    }

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

    // Steps 1-2: extract + verify the inner archive against the checksum that
    // shipped inside the signature-verified outer archive (resumable, but the
    // reused bytes are always re-bound to the verified archive; see the helper).
    const innerArchive = await ensureVerifiedInnerArchive(archivePath, workDir, 'dump.sql.gz', 'dump.sha256')

    // Step 3: Get DB credentials (and container ID when not using external DB)
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
        // Step 4: Drop and recreate database
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

        // Step 5: Pipe decompressed SQL into mariadb with progress
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

        // Cleanup
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

// ─── Public: auto-download + restore on fresh install ─────────────

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

// Stream <BOOTSTRAP_BASE_URL>/<module>/<coin>/<network>/latest.tgz into destDir
// as latest.tgz. Returns the filename on success, null when none is published
// (404). Follows the http→https redirect. Throws on other network errors.
async function downloadBootstrap(coin, network, module, destDir) {
    const url      = `${BOOTSTRAP_BASE_URL}/${module}/${coin}/${network}/latest.tgz`
    const destPath = path.join(destDir, 'latest.tgz')
    ensureDir(destDir)

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

// On a FRESH utxo-tracker install, download the published bootstrap and restore
// it. Best-effort: any failure (no bootstrap published, download/restore error)
// logs a warning and returns so the install proceeds with a normal sync.
async function ensureBootstrapUtxoTracker(coin, network) {
    if (process.env.XCHAIN_NODE_NO_BOOTSTRAP) {
        console.log('Bootstrap auto-restore disabled (XCHAIN_NODE_NO_BOOTSTRAP): syncing from scratch')
        return false
    }
    try {
        const defaultConfig = await getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
        const bootstrapDir  = defaultConfig["UTXO_TRACKER_BOOTSTRAP_VOLUME"]

        console.log(`Checking for a published bootstrap for ${coin}/${network}...`)
        const fileName = await downloadBootstrap(coin, network, XChainService.XCHAIN_UTXO_TRACKER, bootstrapDir)
        if (!fileName) {
            console.log('No bootstrap available; the tracker will sync from scratch')
            return false
        }
        await restoreBootstrap(coin, network, XChainService.XCHAIN_UTXO_TRACKER, fileName)
        console.log('Bootstrap installed; tracker will continue from the bootstrap height')
        return true
    } catch (err) {
        console.log(`WARNING: bootstrap auto-restore failed (${err.message}): the tracker will sync from scratch`)
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
            return false
        }
        await restoreBootstrap(coin, network, module, fileName)
        console.log('Bootstrap installed; the service will continue from the bootstrap height')
        return true
    } catch (err) {
        console.log(`WARNING: bootstrap auto-restore failed (${err.message}): the service will sync from scratch`)
        return false
    }
}

// ─── Exports ──────────────────────────────────────────────────────

module.exports = {
    getBootstrapFilesList,
    makeBootstrap,
    restoreBootstrap,
    downloadBootstrap,
    utxoTrackerVolumeHasData,
    ensureBootstrapUtxoTracker,
    mariaDbModuleHasData,
    ensureBootstrapMariaDb,
    // Bootstrap signing (supply-chain integrity)
    signBootstrapArchive,
    verifyBootstrapSignature,
    checkBootstrapSignature,
    loadBootstrapPublicKey,
    ensureVerifiedInnerArchive
}
