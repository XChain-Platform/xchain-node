/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * XChain Node - Bootstrap restore: coin-node tip guard
 *
 * A bootstrap restore puts a service at the archive's end height in minutes.
 * The coin node next to it, on a fresh mainnet install, is syncing from zero
 * and can be days below that height. Until the decoder and tracker learned to
 * wait out a node in initial block download, a service restored
 * above its node read the node's lower tip as a reorg the first time the RPC
 * answered, rolled back to the safe-depth ceiling, and wrote a durable halt.
 * That was the DEFAULT first-install path on mainnet, not a race.
 *
 * At restore time both numbers exist: the archive now carries its end height
 * (BootstrapArchiveMeta) and the coin node container answers
 * getblockchaininfo. This guard compares them BEFORE the restore touches the
 * store and gives one of four verdicts:
 *
 *   ok             the node is at or past the archive; nothing to say
 *   behind-wait    the node is below the archive and the service waits out a
 *                  catching-up node: restore, and say what the wait means
 *   behind-refuse  the node is below the archive and the service does NOT
 *                  wait (an image older than that fix): refuse the
 *                  restore, the service syncs forward from its start height
 *                  as the node catches up, and the summary says how to take
 *                  the restore later
 *   unknown        the archive carries no height, or the node cannot be
 *                  asked: restore as before, one line says why
 *
 * Whether the service waits is read from the service itself: an image with
 * the fix publishes `node_catching_up` on its status surface (null when not
 * waiting), so its presence is the capability. When the surface cannot be
 * read (the container is still coming up) the module's package.json version
 * decides, 0.16.0 being the first release that carries the wait. The indexer
 * follows the decoder, not the node, so it always passes.
 *
 * Escape hatch: XCHAIN_NODE_SKIP_NODE_TIP_GUARD=1 (loudly warned), matching
 * the other XCHAIN_NODE_SKIP_* gates.
 ********************************************************************/

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const { XChainService, NODE_MODULE_NAME } = require('../config/constants')

// How each coin image's CLI reaches its daemon. Mirrors the HEALTHCHECK line
// in crypto_nodes/<coin>/Dockerfile, which is the same call and the proof the
// arguments work inside the container.
const NODE_CLI_ARGS = {
    bitcoin:  ['bitcoin-cli', '-conf=/etc/bitcoin/bitcoin.conf', '-datadir=/root/.bitcoin/'],
    litecoin: ['litecoin-cli', '-conf=/etc/litecoin/litecoin.conf'],
    dogecoin: ['dogecoin-cli', '-conf=/etc/dogecoin/dogecoin.conf']
}

// First release whose decoder and utxo-tracker wait out a node in initial
// block download instead of reconciling a reorg that never happened.
const CATCH_UP_WAIT_SINCE = [0, 16, 0]

// The service status surface is asked a few times: `install` starts the
// container and restores right after, so the API may still be coming up.
const STATUS_PROBE_ATTEMPTS = 3
const STATUS_PROBE_DELAY_MS = 5000

const VERDICT = Object.freeze({
    OK:            'ok',
    BEHIND_WAIT:   'behind-wait',
    BEHIND_REFUSE: 'behind-refuse',
    UNKNOWN:       'unknown',
    SKIPPED:       'skipped'
})

function guardSkipped() {
    const raw = String(process.env.XCHAIN_NODE_SKIP_NODE_TIP_GUARD || '').trim().toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes'
}

function defaultRunner(cmd, args) {
    return execFileAsync(cmd, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
}

// { blocks, headers, initialblockdownload } from the coin node container's own
// CLI. Throws with a reason when the container is missing or the daemon does
// not answer (still loading, RPC not up yet).
async function readCoinNodeChainInfo(coin, network, { runner = defaultRunner, getModuleContainer } = {}) {
    const cliArgs = NODE_CLI_ARGS[coin]
    if (!cliArgs) throw new Error(`no node CLI known for coin ${coin}`)
    const lookup = getModuleContainer || require('../state').db.getModuleContainer.bind(require('../state').db)
    const containerId = await lookup(NODE_MODULE_NAME, coin, network)
    if (!containerId) throw new Error(`no ${coin}/${network} node container is registered`)
    const { stdout } = await runner('docker', ['exec', containerId, ...cliArgs, 'getblockchaininfo'])
    let info
    try {
        info = JSON.parse(String(stdout))
    } catch {
        throw new Error('getblockchaininfo did not return JSON')
    }
    const blocks = Number(info && info.blocks)
    if (!Number.isFinite(blocks) || blocks < 0) throw new Error('getblockchaininfo carried no usable block height')
    return {
        blocks,
        headers: Number.isFinite(Number(info.headers)) ? Number(info.headers) : null,
        initialblockdownload: info.initialblockdownload === true
    }
}

function parseSemver(version) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function versionAtLeast(version, floor) {
    const v = parseSemver(version)
    if (!v) return false
    for (let i = 0; i < 3; i++) {
        if (v[i] > floor[i]) return true
        if (v[i] < floor[i]) return false
    }
    return true
}

// Does this service wait out a catching-up node? The status surface is the
// authority when it can be read; the version is the fallback.
function serviceWaitsOutCatchUp(module, { statusPayload = null, version = null } = {}) {
    if (module === XChainService.XCHAIN_INDEXER) return true
    if (statusPayload && typeof statusPayload === 'object') {
        return Object.prototype.hasOwnProperty.call(statusPayload, 'node_catching_up')
    }
    return versionAtLeast(version, CATCH_UP_WAIT_SINCE)
}

// Pure comparison; everything above feeds it.
function evaluateNodeTipAgainstArchive({ archiveHeight, chainInfo, serviceWaits, module }) {
    if (!Number.isInteger(archiveHeight)) {
        return { verdict: VERDICT.UNKNOWN, detail: 'the archive carries no end height (published before bootstrap.json existed), so it cannot be compared with the node' }
    }
    if (!chainInfo || !Number.isFinite(chainInfo.blocks)) {
        return { verdict: VERDICT.UNKNOWN, detail: `the coin node did not answer, so its tip cannot be compared with the archive height ${archiveHeight}` }
    }
    const nodeHeight = chainInfo.blocks
    if (nodeHeight >= archiveHeight) return { verdict: VERDICT.OK, archiveHeight, nodeHeight, gap: 0 }
    const gap = archiveHeight - nodeHeight
    const ibd = chainInfo.initialblockdownload === true
    const position = `the coin node is at ${nodeHeight}${ibd ? ' (initial block download)' : ''}, ${gap} blocks below the archive's ${archiveHeight}`
    if (serviceWaits) {
        return {
            verdict: VERDICT.BEHIND_WAIT, archiveHeight, nodeHeight, gap, ibd,
            detail: `${position}; the ${module} waits until the node passes ${archiveHeight} and then continues, which \`xchain-node ps\` shows as WAITING FOR NODE`
        }
    }
    return {
        verdict: VERDICT.BEHIND_REFUSE, archiveHeight, nodeHeight, gap, ibd,
        detail: `${position}, and this ${module} image does not wait out a catching-up node (it would read the node's lower tip as a reorg and halt); ` +
                `it now syncs forward from its start height as the node catches up. To take the restore later, wait for the node to pass ${archiveHeight} ` +
                `and re-run install with XCHAIN_NODE_FORCE_BOOTSTRAP=1, or pass --no-bootstrap to install to stop it trying`
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// The service's own status payload, or null when it cannot be read within the
// attempts. Rides the same probe the health gate and `ps` use.
async function probeServiceCapability(module, coin, network, { runner = defaultRunner, getModuleContainer, getDefaultConfig, probeServiceStatus, attempts = STATUS_PROBE_ATTEMPTS, delayMs = STATUS_PROBE_DELAY_MS } = {}) {
    const gate = require('./BootstrapHealthGate')
    const probe = probeServiceStatus || gate.probeServiceStatus
    const portKey = gate.MODULE_API_PORT_KEY[module]
    if (!portKey) return null
    const cfg = getDefaultConfig || require('./ConfigService').getDefaultConfig
    const lookup = getModuleContainer || require('../state').db.getModuleContainer.bind(require('../state').db)
    let containerId
    let port
    try {
        containerId = await lookup(module, coin, network)
        const config = await cfg(module, coin, network)
        port = config && config[portKey]
    } catch {
        return null
    }
    if (!containerId || !port) return null
    for (let i = 0; i < attempts; i++) {
        try {
            const payload = await probe(containerId, port, runner)
            if (payload && typeof payload === 'object') return payload
        } catch { /* not up yet */ }
        if (i + 1 < attempts) await sleep(delayMs)
    }
    return null
}

// The whole assessment for one restore, never throwing: reads the archive
// height, asks the node, asks the service, compares, prints the verdict.
// Returns { verdict, refuse, detail, archiveHeight, nodeHeight, gap, ibd }.
async function assessNodeTipForRestore({ coin, network, module, archivePath }, deps = {}) {
    if (guardSkipped()) {
        console.log('WARNING: XCHAIN_NODE_SKIP_NODE_TIP_GUARD is set: the archive height is NOT compared with the coin node tip.')
        return { verdict: VERDICT.SKIPPED, refuse: false, detail: 'node tip guard skipped by XCHAIN_NODE_SKIP_NODE_TIP_GUARD' }
    }
    const meta = deps.readBootstrapArchiveMeta || require('./BootstrapArchiveMeta').readBootstrapArchiveMeta
    let archiveHeight = null
    try {
        const parsed = await meta(archivePath)
        archiveHeight = parsed ? parsed.height : null
    } catch { /* no metadata is "unknown", handled below */ }

    let chainInfo = null
    let nodeProblem = null
    if (Number.isInteger(archiveHeight)) {
        try {
            chainInfo = await (deps.readCoinNodeChainInfo || readCoinNodeChainInfo)(coin, network, deps)
        } catch (err) {
            nodeProblem = err && err.message ? err.message : String(err)
        }
    }

    let serviceWaits = true
    if (Number.isInteger(archiveHeight) && chainInfo && chainInfo.blocks < archiveHeight && module !== XChainService.XCHAIN_INDEXER) {
        const payload = await (deps.probeServiceCapability || probeServiceCapability)(module, coin, network, deps)
        let version = null
        if (!payload) {
            try {
                version = await (deps.getLocalModuleVersion || require('./VersionService').getLocalModuleVersion)(module)
            } catch { /* unknown version reads as "does not wait" */ }
        }
        serviceWaits = serviceWaitsOutCatchUp(module, { statusPayload: payload, version })
    }

    const result = evaluateNodeTipAgainstArchive({ archiveHeight, chainInfo, serviceWaits, module })
    if (result.verdict === VERDICT.UNKNOWN && nodeProblem) result.detail = `${result.detail} (${nodeProblem})`
    result.refuse = result.verdict === VERDICT.BEHIND_REFUSE

    switch (result.verdict) {
        case VERDICT.OK:
            console.log(`Coin node tip ${result.nodeHeight} is at or past the archive height ${result.archiveHeight}.`)
            break
        case VERDICT.BEHIND_WAIT:
            console.log(`WARNING: ${result.detail}.`)
            break
        case VERDICT.BEHIND_REFUSE:
            console.log(`REFUSING the ${module} bootstrap restore: ${result.detail}.`)
            break
        default:
            console.log(`Note: ${result.detail}.`)
    }
    return result
}

module.exports = {
    VERDICT,
    NODE_CLI_ARGS,
    CATCH_UP_WAIT_SINCE,
    readCoinNodeChainInfo,
    serviceWaitsOutCatchUp,
    evaluateNodeTipAgainstArchive,
    probeServiceCapability,
    assessNodeTipForRestore,
    // Exported for tests
    parseSemver,
    versionAtLeast,
    guardSkipped
}
