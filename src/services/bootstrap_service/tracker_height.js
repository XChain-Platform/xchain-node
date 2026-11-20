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
 * The end height a utxo-tracker bootstrap archive records. The restore-time
 * node tip guard trusts this as a bound the archived data never exceeds.
 ********************************************************************/

let { execFile }          = require('child_process')
const { promisify }       = require('util')
let execFileAsync         = promisify(execFile)

let { XChainService } = require('../../config')
let { getDefaultConfig } = require('../config_service')
let bootstrapHealthGate = require('../bootstrap_health_gate')
const { redactSecrets, sleep } = require('../../utils/helpers')
const { getLogger } = require('../../observability/logger')
let logger = getLogger()

// Takes the same dependency bag tracker_archive.js is configured with.
function configureDependencies(dependencies) {
    ;({ execFile } = dependencies.childProcess)
    execFileAsync = promisify(execFile)
    ;({ XChainService } = dependencies.config)
    ;({ getDefaultConfig } = dependencies.configService)
    bootstrapHealthGate = dependencies.bootstrapHealthGate
    logger = dependencies.logger
}

// How long a just-restarted tracker gets to answer its status surface (5 min) before the publish refuses.
// The tracker is serving again by then, so the wait costs publish wall-clock time only.
const POST_RESTART_PROBE_ATTEMPTS = 60
const POST_RESTART_PROBE_DELAY_MS = 5000

// The tracker's committed height from its status surface, or null. Asked
// before the stop (a floor) and again after the restart (the recorded height).
async function readTrackerCommittedHeight(coin, network, containerId, { quiet = false } = {}) {
    try {
        const { probeServiceStatus, MODULE_API_PORT_KEY } = bootstrapHealthGate
        if (typeof probeServiceStatus !== 'function') return null
        const config = await getDefaultConfig(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
        const port = config && config[MODULE_API_PORT_KEY[XChainService.XCHAIN_UTXO_TRACKER]]
        if (!port) return null
        const runner = (cmd, args) => execFileAsync(cmd, args, { timeout: 15000 })
        const payload = await probeServiceStatus(containerId, port, runner)
        if (payload && (payload.halted === true || payload.status === 'halted')) {
            refuseBootstrapSource(`utxo-tracker ${coin}/${network}`,
                'the tracker status surface reports a durable halt, so its committed height cannot certify ' +
                'an archive. No archive was built or signed; resync the tracker from a known-good archive, then rerun the publish.')
        }
        const candidates = ['committed_height', 'tracker_height']
        for (const key of candidates) {
            const value = Number(payload && payload[key])
            if (Number.isInteger(value) && value >= 0) return value
        }
        return null
    } catch (err) {
        if (err && err.name === 'BootstrapSourceUnhealthyError') throw err
        if (!quiet) logger.info(`Could not read the tracker height for the archive metadata (${redactSecrets(err.message)}); the archive will carry no height.`)
        return null
    }
}

// The restarted tracker's committed height, retried while its API comes up, or null.
async function readTrackerHeightAfterRestart(coin, network, containerId, { attempts = POST_RESTART_PROBE_ATTEMPTS, delayMs = POST_RESTART_PROBE_DELAY_MS } = {}) {
    // No status probe wired in: nothing a retry could change.
    if (typeof bootstrapHealthGate.probeServiceStatus !== 'function') return null
    for (let i = 0; i < attempts; i++) {
        const height = await readTrackerCommittedHeight(coin, network, containerId, { quiet: true })
        if (height !== null) return height
        if (i + 1 < attempts) await sleep(delayMs)
    }
    return null
}

const READ_STORE_STATE_SCRIPT = `
const { ClassicLevel } = require('classic-level')
;(async () => {
    const db = new ClassicLevel(process.argv[1], {
        createIfMissing: false, keyEncoding: 'buffer', valueEncoding: 'buffer'
    })
    try {
        await db.open()
        const text = (await db.get(Buffer.from('LAST_BLOCK_HEIGHT'))).toString('utf8')
        if (!/^[0-9a-f]+$/i.test(text)) throw new Error('LAST_BLOCK_HEIGHT is not hexadecimal')
        const height = parseInt(text, 16)
        if (!Number.isSafeInteger(height) || height < 0) throw new Error('LAST_BLOCK_HEIGHT is outside the safe integer range')
        let marker
        try {
            marker = await db.get(Buffer.from([0x52]))
        } catch (err) {
            if (!err || err.code !== 'LEVEL_NOT_FOUND') throw err
        }
        const haltMarker = marker === undefined ? null : marker.toString('utf8')
        process.stdout.write(JSON.stringify({ height, haltMarker }))
    } finally {
        try { await db.close() } catch {}
    }
})().catch(err => { process.stderr.write(err.message + '\\n'); process.exitCode = 1 })
`

// The height and halt-marker state of the frozen store itself. The node mounts the tracker volume at
// the tracker's store path, so the volume root and each snapshot root are stores.
// Unlike the live status surface this cannot run ahead of the archived data.
async function readFrozenStoreState(volumeName, sourceDir, containerId) {
    try {
        const { stdout: inspectOut } = await execFileAsync('docker', [
            'inspect', '--format', '{{.Image}}', containerId
        ], { timeout: 15000 })
        const imageId = String(inspectOut).trim()
        if (!imageId) throw new Error('the tracker container image could not be resolved')
        const { stdout } = await execFileAsync('docker', [
            'run', '--rm', '-v', `${volumeName}:/data`, '-w', '/XChainUtxoTracker',
            '--entrypoint', 'node', imageId, '-e', READ_STORE_STATE_SCRIPT, sourceDir
        ], { timeout: 300000 })
        const text = String(stdout).trim()
        const parsed = JSON.parse(text)
        const height = Number.isSafeInteger(parsed && parsed.height) && parsed.height >= 0 ? parsed.height : null
        const markerField = parsed && Object.prototype.hasOwnProperty.call(parsed, 'haltMarker')
        const haltMarker = markerField && (parsed.haltMarker === null || typeof parsed.haltMarker === 'string')
            ? parsed.haltMarker : null
        const haltChecked = markerField && (parsed.haltMarker === null || typeof parsed.haltMarker === 'string')
        if (height === null) logger.info('The frozen tracker store reported an unusable height.')
        return { height, haltMarker, haltChecked }
    } catch (err) {
        logger.info(`Could not verify the frozen tracker store state (${redactSecrets(err.message)}).`)
        return { height: null, haltMarker: null, haltChecked: false }
    }
}

async function readFrozenStoreHeight(volumeName, sourceDir, containerId) {
    return (await readFrozenStoreState(volumeName, sourceDir, containerId)).height
}

function refuseBootstrapSource(label, reason) {
    const ErrorType = bootstrapHealthGate.BootstrapSourceUnhealthyError
    const error = typeof ErrorType === 'function'
        ? new ErrorType(label, [reason])
        : Object.assign(new Error(reason), { name: 'BootstrapSourceUnhealthyError', reasons: [reason] })
    if (typeof bootstrapHealthGate.gateSkipped === 'function' && bootstrapHealthGate.gateSkipped()) {
        logger.info(`WARNING: ${error.message}`)
        return
    }
    throw error
}

function haltMarkerReason(raw) {
    try {
        const marker = JSON.parse(raw)
        return marker && typeof marker.reason === 'string' && marker.reason.trim()
            ? ` (${marker.reason.trim()})` : ''
    } catch { return '' }
}

function refuseHaltedFrozenStore(context) {
    const state = context && context.frozenStoreState
    const label = `utxo-tracker ${context.coin}/${context.network}`
    if (!state || state.haltChecked !== true) {
        return refuseBootstrapSource(label,
            'the archived store could not be checked for the utxo-tracker halt marker at key 0x52. ' +
            'No archive was signed; the previously published archive stays in place, so verify the store and rerun the publish.')
    }
    if (state.haltMarker !== null) {
        return refuseBootstrapSource(label,
            'the archived store carries the utxo-tracker halt marker at key 0x52' +
            haltMarkerReason(state.haltMarker) + '. Every restore would boot halted. No archive was signed; ' +
            'the previously published archive stays in place. Resync the tracker from a known-good archive, then rerun the publish.')
    }
}

// The archived store is the only authoritative height. Live readings remain
// diagnostic because they can sit on either side of the frozen snapshot.
function chooseArchiveHeight(preStopHeight, postRestartHeight, frozenHeight = null) {
    if (Number.isInteger(frozenHeight)) {
        logger.info(`Archive height: ${frozenHeight} (read from the frozen store).`)
        return frozenHeight
    }
    const pre  = Number.isInteger(preStopHeight) ? preStopHeight : null
    const post = Number.isInteger(postRestartHeight) ? postRestartHeight : null
    throw new Error(`the archived store's own height could not be read; refusing to sign a height derived from live readings ` +
        `(pre-stop ${pre === null ? 'unknown' : pre}, after restart ${post === null ? 'unknown' : post})`)
}

// Throw when only the pre-stop reading exists, naming the run, so the publish stops before any compress or signing.
function refusePreStopOnlyHeight({ coin, network, preStopHeight, postRestartHeight, frozenHeight }) {
    if (Number.isInteger(frozenHeight)) return
    if (!Number.isInteger(preStopHeight) || Number.isInteger(postRestartHeight)) return
    throw new Error(`utxo-tracker ${coin}/${network} did not report its committed height after the restart; ` +
        `refusing to sign an archive whose recorded height could understate its data (pre-stop reading ${preStopHeight}). ` +
        'No archive was built or signed; the previously published archive stays in place, so rerun the publish.')
}

module.exports = {
    configureDependencies,
    READ_STORE_STATE_SCRIPT,
    readTrackerCommittedHeight,
    readTrackerHeightAfterRestart,
    readFrozenStoreState,
    readFrozenStoreHeight,
    refuseHaltedFrozenStore,
    chooseArchiveHeight,
    refusePreStopOnlyHeight
}
