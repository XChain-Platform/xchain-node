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
 * XChain Node - Node Service: coin node download
 * Pinned mirror lookup and the coin node tarball download
 ********************************************************************/

const { https } = require('follow-redirects')
const dns       = require('dns')
const fs        = require('fs')
const semver    = require('semver')

const {
    NODE_VERSION_FILE_NAME, Coin, cryptoNodesDir
} = require('../../config')
const nodeVersion = process.versions.node
const { gitHubDownloader } = require('../../state')
const { decompressTarGz }  = require('../../utils/helpers')
const { getLogger } = require('../../observability/logger');
const logger = getLogger();

// Enumerate a host's mirror addresses so a failover can dial one of them.
// Pinning the address changes nothing else: URL, SNI and certificate checks
// still run against the hostname. Returns [] when resolution fails.
async function resolveMirrorAddresses(hostname) {
    try {
        const records = await dns.promises.lookup(hostname, { all: true })
        return records.map((r) => ({ address: r.address, family: r.family }))
    } catch {
        return []
    }
}

// Only a transport failure is worth another mirror: every mirror answers an
// HTTP status alike. Flagged on the error rather than matched from its
// message, which is wrapped by the time it is read.
function isTransportFailure(err) {
    return err instanceof Error && err.transportFailure === true
}

// Answer dns.lookup with the one pinned address, in both callback shapes.
// autoSelectFamily (default since Node 20) calls it with `all: true` and
// requires an ARRAY; the single-address form fails the connect before it dials.
function pinnedLookup(pinned) {
    return (hostname, opts, cb) => {
        if (opts && opts.all) return cb(null, [{ address: pinned.address, family: pinned.family }])
        return cb(null, pinned.address, pinned.family)
    }
}

// One download attempt against one mirror address (or the default resolver
// when `pinned` is null). Resolves once the tarball is fully written.
function downloadTarball(downloadUrl, filePath, pinned) {
    return new Promise((resolve, reject) => {
        // No options argument unpinned: the common path keeps the plain
        // https.get shape and does no name resolution of its own.
        const options = pinned ? { lookup: pinnedLookup(pinned) } : null
        const target = pinned ? `${downloadUrl} via ${pinned.address}` : downloadUrl
        const file = fs.createWriteStream(filePath)
        let settled = false
        const fail = (err, transportFailure = true) => {
            if (settled) return
            settled = true
            file.destroy()
            // Name the URL, the mirror dialled and the cause: a broken mirror is
            // otherwise indistinguishable from a broken installer.
            const wrapped = new Error(`Bitcoin Core download failed from ${target}: ${err.message}`, { cause: err })
            wrapped.transportFailure = transportFailure
            reject(wrapped)
        }

        const onResponse = (response) => {
            // Fail closed on a non-success response (404 / redirect to an
            // error page / etc.) instead of piping an HTML error body into
            // the tarball and only discovering it later.
            if (response.statusCode !== 200) {
                response.resume() // drain
                fail(new Error(`HTTP ${response.statusCode}`), false)
                return
            }
            response.pipe(file)
            response.on("error", fail)
            file.on("error", fail)
            file.on("finish", () => {
                if (settled) return
                settled = true
                file.close()
                resolve(true)
            })
        }

        const request = options ? https.get(downloadUrl, options, onResponse) : https.get(downloadUrl, onResponse)

        // Surface transport-level failures (DNS, connection reset, TLS) as a
        // rejection instead of leaving the promise to hang forever.
        request.on("error", fail)
    })
}

function bitcoinDownloadDetails(version) {
    logger.info("Downloading bitcoin node...")
    const destination = cryptoNodesDir + "/bitcoin"
    const filePath = destination + "/bitcoin" + version + ".tar.gz"

    // The default crypto_nodes/bitcoin ships in the repo, but a custom
    // XCHAIN_NODE_CRYPTO_NODES_DIR (the documented big-volume setup)
    // starts empty, and createWriteStream does not create directories.
    fs.mkdirSync(destination, { recursive: true })
    // Pick the right prebuilt tarball for the host architecture.
    // bitcoincore.org publishes x86_64-linux-gnu and aarch64-linux-gnu builds.
    const archMap = { x64: 'x86_64', arm64: 'aarch64' }
    const arch = archMap[process.arch]
    if (!arch) throw new Error("Unsupported architecture for Bitcoin Core download: " + process.arch)
    const downloadUrl = "https://bitcoincore.org/bin/bitcoin-core-" + version + "/bitcoin-" + version + "-" + arch + "-linux-gnu.tar.gz"
    return { destination, filePath, arch, downloadUrl }
}

// Honour a tarball the operator placed here, which is the only route left
// when every resolved mirror serves a broken certificate chain.
// Hash-checked here so a corrupt leftover is discarded and re-downloaded
// rather than failing the install; the verify below still gates every path.
async function usePlacedBitcoinTarball(filePath, version, arch) {
    if (!fs.existsSync(filePath)) return false
    try {
        await gitHubDownloader.verifyFileHash(filePath, 'bitcoin/bitcoin', 'v' + version, arch)
        logger.info(`Using the bitcoin node tarball already at ${filePath}: it matches the pinned SHA-256.`)
        return true
    } catch {
        logger.info(`Discarding the file at ${filePath}: it does not match the pinned SHA-256.`)
        try { fs.rmSync(filePath, { force: true }) } catch { /* best-effort */ }
        return false
    }
}

async function fetchBitcoinTarball(downloadUrl, filePath, downloaded) {
    const failures = []
    // One attempt at the resolver's choice; only a transport failure widens
    // into a mirror-by-mirror search, so a healthy install pays nothing.
    try {
        if (!downloaded) {
            await downloadTarball(downloadUrl, filePath, null)
            downloaded = true
        }
    } catch (err) {
        failures.push(err.message)
        // A partial file would otherwise be hashed as if it were the download.
        try { fs.rmSync(filePath, { force: true }) } catch { /* best-effort */ }
        if (!isTransportFailure(err)) throw err

        const mirrors = await resolveMirrorAddresses(new URL(downloadUrl).hostname)
        for (const pinned of mirrors) {
            logger.info(`Retrying the bitcoin node download via mirror ${pinned.address}...`)
            try {
                await downloadTarball(downloadUrl, filePath, pinned)
                downloaded = true
                break
            } catch (retryErr) {
                failures.push(retryErr.message)
                try { fs.rmSync(filePath, { force: true }) } catch { /* best-effort */ }
            }
        }
    }
    if (!downloaded) {
        throw new Error(
            "Couldn't download the bitcoin node. Every mirror for " + downloadUrl + " failed:\n  " +
            failures.join("\n  ") +
            "\nIf these are certificate errors the mirror is serving an incomplete chain, not your CA store," +
            " and every address your resolver returns can be serving the same one." +
            " Fetch the tarball with curl (which recovers the missing intermediate where Node cannot), put it at " + filePath +
            ", and re-run install: a tarball already at that path is used as-is, and its pinned SHA-256 is still verified before it is used."
        )
    }
}

async function unpackBitcoinTarball(destination, filePath, version, arch) {
    try {
        // Supply-chain guard: bitcoind is a prebuilt binary fetched
        // straight from bitcoincore.org over the wire. Verify the
        // downloaded tarball against the project's published
        // SHA-256 (github_hashes.json, sourced from the GPG-signed
        // SHA256SUMS) BEFORE decompressing, so a tampered or
        // truncated download can never reach the build/run path.
        // Fails closed: unknown version/arch or any mismatch throws.
        await gitHubDownloader.verifyFileHash(filePath, 'bitcoin/bitcoin', 'v' + version, arch)

        logger.info("Decompressing bitcoin node files...")
        await decompressTarGz(filePath)

        if (fs.existsSync(destination + "/bitcoin")) {
            if (semver.gte(nodeVersion, "14.14.0")) {
                fs.rmSync(destination + "/bitcoin", { recursive: true, force: true })
            } else {
                fs.rmdirSync(destination + "/bitcoin", { recursive: true })
            }
        }

        fs.renameSync(destination + "/bitcoin-" + version, destination + "/bitcoin")
        fs.writeFileSync(destination + "/bitcoin/" + NODE_VERSION_FILE_NAME, version)
    } catch (err) {
        // Remove the unverified/failed tarball so a later retry
        // re-downloads cleanly instead of trusting a cached bad file.
        try { fs.rmSync(filePath, { force: true }) } catch { /* best-effort */ }
        throw err
    }
}

async function getBitcoinNode(version) {
    if (version.startsWith("v")) version = version.substring(1)
    const { destination, filePath, arch, downloadUrl } = bitcoinDownloadDetails(version)
    const downloaded = await usePlacedBitcoinTarball(filePath, version, arch)
    await fetchBitcoinTarball(downloadUrl, filePath, downloaded)
    await unpackBitcoinTarball(destination, filePath, version, arch)
}

async function getCryptoNode(coin, network, version) {
    if (coin === Coin.BITCOIN) {
        await getBitcoinNode(version)
    } else if (coin === Coin.DOGECOIN) {
        await gitHubDownloader.downloadRepoVersion("dogecoin", "dogecoin", version, { outputPath: cryptoNodesDir + "/dogecoin" })
    } else if (coin === Coin.LITECOIN) {
        await gitHubDownloader.downloadRepoVersion("litecoin-project", "litecoin", version, { outputPath: cryptoNodesDir + "/litecoin" })
    } else {
        throw new Error("There's no support for " + coin + " in " + network + " network yet")
    }
    return true
}

module.exports = {
    nodeVersion,
    resolveMirrorAddresses,
    isTransportFailure,
    pinnedLookup,
    downloadTarball,
    getCryptoNode
}
