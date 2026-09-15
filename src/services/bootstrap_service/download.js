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

let fs      = require('fs')
const path  = require('path')
let axios   = require('axios')
const { PassThrough } = require('stream')

let { XChainService, SEP, BOOTSTRAP_BASE_URL } = require('../../config')
const { BOOTSTRAP_SIG_SUFFIX } = require('./archive_signing')
let { startProgress, ensureDirWritable } = require('./workspace')
const { getLogger } = require('../../observability/logger')
let logger = getLogger()

function configureDependencies(dependencies) {
    fs = dependencies.fs
    axios = dependencies.axios
    ;({ XChainService, SEP, BOOTSTRAP_BASE_URL } = dependencies.config)
    ;({ startProgress, ensureDirWritable } = dependencies.workspace)
    logger = dependencies.logger
    BOOTSTRAP_STALE_AFTER_DAYS = dependencies.staleAfterDays
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
let BOOTSTRAP_STALE_AFTER_DAYS = 10

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

    await writeBootstrapResponse(response, destPath, module, coin, network)

    // Also fetch the detached signature published next to the archive. A 404
    // means this bootstrap is unsigned; remove any stale local .sig so the
    // restore's signature policy sees the true current state instead of
    // verifying today's archive against yesterday's signature.
    //
    // Pin the .sig to the archive we ACTUALLY downloaded: latest.tgz
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

    reportBootstrapAge(finalUrl, module, coin, network)
    await downloadBootstrapSignature(finalUrl, destPath)

    return 'latest.tgz'
}

async function writeBootstrapResponse(response, destPath, module, coin, network) {
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
}

// Report the age during the install, not after a halt traced back to it.
// Only the tracker can be left unable to walk forward, so only it is warned
// about that; the others just resync from the archive height.
function reportBootstrapAge(finalUrl, module, coin, network) {
    const ageDays = bootstrapArchiveAgeDays(finalUrl)
    if (ageDays === null || ageDays < BOOTSTRAP_STALE_AFTER_DAYS) return
    const consequence = module === XChainService.XCHAIN_UTXO_TRACKER
        ? '  A snapshot whose tip has drifted past the chain it is restored onto can leave the tracker\n' +
          '  unable to walk forward, which halts it until it is reset and rebuilt. If that happens, the\n' +
          '  archive is the cause, not your host.'
        : '  It still restores; the service resyncs forward from the archive height, which just takes longer\n' +
          '  the older the archive is.'
    logger.info(
        `WARNING: the published ${module} bootstrap for ${coin}/${network} is ${ageDays} days old ` +
        `(${path.basename(finalUrl)}).\n` + consequence
    )
}

async function downloadBootstrapSignature(finalUrl, destPath) {
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
}

module.exports = {
    configureDependencies,
    downloadBootstrap,
    bootstrapArchiveAgeDays,
    BOOTSTRAP_STALE_AFTER_DAYS
}
