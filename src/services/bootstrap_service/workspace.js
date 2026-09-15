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

let fs                  = require('fs')
const path              = require('path')
let { execFile }        = require('child_process')
const { promisify }     = require('util')
let execFileAsync       = promisify(execFile)

let { XChainService, tmpDir } = require('../../config')
let { getDefaultConfig } = require('../config_service')
let directoryMode = '755'

function configureDependencies(dependencies) {
    fs = dependencies.fs
    execFile = dependencies.childProcess.execFile
    execFileAsync = promisify(execFile)
    ;({ XChainService, tmpDir } = dependencies.config)
    ;({ getDefaultConfig } = dependencies.configService)
    directoryMode = dependencies.directoryMode
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
    await execFileAsync('docker', ['run', '--rm', '-v', `${parent}:/parent`, 'alpine', 'chmod', directoryMode, `/parent/${dirName}`])
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

module.exports = {
    configureDependencies,
    startProgress,
    buildDateTimeString,
    getWorkDir,
    assertBootstrapCapacity,
    ensureDir,
    ensureDirWritable,
    getBootstrapFilesList
}
