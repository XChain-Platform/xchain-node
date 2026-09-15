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
 * XChain Node - Bootstrap source health gate
 *
 * `bootstrap create` used to dump whatever state the service happened to be
 * in. That is not a neutral default: a bootstrap archive's entire value is
 * being KNOWN-GOOD, and the publisher writes the newest file in the served
 * directory, which every "just take the latest" path (and `bootstrap restore
 * --latest`) selects by construction. So an unverified snapshot does not sit
 * harmlessly beside the last good one, it REPLACES it as the default choice.
 * Publishing nothing is strictly better.
 *
 * This is not theoretical. `mainnet-xchain-decoder-20260726_033031.tar.gz` was
 * cut by the weekly cron from a litecoin/mainnet decoder that had already
 * aborted mid-rollback, so the newest published archive contains a live
 * REORG_HALT row: anyone restoring it gets a decoder that halts at its next
 * reorg.
 *
 * The gate refuses to create a bootstrap from a source that is:
 *   - missing, not running, restarting, or crash-looping
 *   - reporting an unhealthy/halted status on its own health surface
 *   - carrying a durable halt marker in its database: a decoder REORG_HALT row
 *     (events.code = 'REORG_HALT') or an uncleared xchain-sync divergence halt
 *     (sync_halt with cleared_at IS NULL). For an indexer source that means the
 *     PAIRED DECODER's database, which is the only place either marker is written;
 *     an indexer's own events table only ever carries code='REORG'.
 *   - materially behind its node's tip
 *
 * FAIL CLOSED throughout. A probe that cannot be run, cannot be parsed, or
 * throws is a REFUSAL, never a pass: "we could not tell" and "it is fine" must
 * not collapse into the same outcome when the output is an artifact that
 * silently becomes the fleet's default recovery source.
 *
 * Escape hatch: XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE=1 (loudly warned),
 * matching the other XCHAIN_NODE_SKIP_* gates. Use it to snapshot a known-bad
 * database on purpose (forensics), never for a routine publish.
 ********************************************************************/

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const { XChainService } = require('../config')
const { db } = require('../state')
const { getDefaultConfig } = require('./config_service')
const databaseService = require('./database_service');
const config = require('../config');
const { getLogger } = require('../observability/logger');
const logger = getLogger();
const {
    DEFAULT_MAX_LAG_BLOCKS, evaluateContainerState, evaluateStatusPayload
} = require('./bootstrap_health_gate/status_evaluation.js')
const { parseCountTokens, readHaltMarkers } = require('./bootstrap_health_gate/halt_markers.js')

// Which env key carries the container-internal API port for each module.
// Mirrors ModuleService's SERVICE_HEALTHCHECK portKeys, deliberately: the probe
// below runs the same request the Docker healthcheck runs, so if the probe
// cannot run at all, neither can the healthcheck.
const MODULE_API_PORT_KEY = {
    [XChainService.XCHAIN_DECODER]:      'DECODER_API_PORT',
    [XChainService.XCHAIN_INDEXER]:      'INDEXER_API_PORT',
    [XChainService.XCHAIN_UTXO_TRACKER]: 'UTXO_TRACKER_API_PORT'
}

// Modules whose state lives in MariaDB and can therefore carry a durable halt
// marker row. The utxo-tracker's store is LevelDB and has no such table.
const MARIADB_MODULES = new Set([XChainService.XCHAIN_DECODER, XChainService.XCHAIN_INDEXER])

function gateSkipped() {
    const raw = String(config.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE).trim().toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes'
}

function maxLagBlocks() {
    const raw = parseInt(config.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS, 10)
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_LAG_BLOCKS
}

// Thrown so callers (and the publish script) can tell a refusal apart from an
// I/O failure mid-create.
class BootstrapSourceUnhealthyError extends Error {
    constructor(label, reasons) {
        super(
            `Refusing to create a bootstrap from ${label}: the source is not known-good.\n` +
            reasons.map(r => `  - ${r}`).join('\n') + '\n' +
            'A bootstrap archive becomes the newest (and therefore default) recovery source for the whole ' +
            'fleet, so publishing an unverified one is worse than publishing nothing. Fix the service (for a ' +
            'durable halt marker that means a full resync from a known-good snapshot), then re-run. To snapshot ' +
            'a known-bad database deliberately, set XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE=1.'
        )
        this.name = 'BootstrapSourceUnhealthyError'
        this.reasons = reasons
    }
}

async function inspectContainer(containerId, runner) {
    // RestartCount is top-level, NOT under .State. `{{.State.RestartCount}}` is not a
    // field that reads empty, it is a template-execution ERROR ("map has no entry for
    // key"), so docker exits 1, this rejects, and the caller records "could not inspect
    // the container" and refuses to publish: the gate failed closed on healthy sources.
    const format = '{{.State.Status}}|{{.State.Restarting}}|{{.RestartCount}}|{{.State.StartedAt}}|' +
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
    const { stdout } = await runner('docker', ['inspect', '--format', format, containerId])
    return String(stdout || '')
}

// Ask the service itself. JSON-RPC `health` first because it is the richest
// surface (lag + halt markers); GET /status is the fallback for an older image
// or a shed health POST, and is exactly what the Docker healthcheck runs. A
// fallback body that carries no lag field still refuses in evaluateStatusPayload.
async function probeServiceStatus(containerId, port, runner) {
    const rpcBody = JSON.stringify({ jsonrpc: '2.0', method: 'health', id: 1 })
    const attempts = [
        ['wget', '-qO-', `--post-data=${rpcBody}`, '--header=Content-Type: application/json', `http://localhost:${port}/`],
        ['wget', '-qO-', `http://localhost:${port}/status`]
    ]
    let lastErr = null
    for (const cmd of attempts) {
        let stdout
        try {
            ({ stdout } = await runner('docker', ['exec', containerId, ...cmd]))
        } catch (err) {
            lastErr = err
            continue
        }
        let parsed
        try {
            parsed = JSON.parse(String(stdout || '').trim())
        } catch (_) {
            lastErr = new Error('unparseable status body')
            continue
        }
        // JSON-RPC envelope: an error envelope means this route is unsupported,
        // so fall through to the next attempt rather than reading it as a fault.
        if (parsed && parsed.error && parsed.result === undefined) {
            lastErr = new Error(`json-rpc error: ${parsed.error.message || 'unknown'}`)
            continue
        }
        return (parsed && parsed.result !== undefined) ? parsed.result : parsed
    }
    throw lastErr || new Error('no status probe succeeded')
}

// Refuse unless `module` on coin/network is a known-good bootstrap source.
// Resolves silently when the source passes; throws BootstrapSourceUnhealthyError
// (with every reason, not just the first) when it does not.
//
// `deps` exists for tests; production callers pass nothing.
async function assertBootstrapSourceHealthy(coin, network, module, deps = {}) {
    const label = `${coin}/${network} ${module}`

    if (gateSkipped()) {
        logger.info(`WARNING: XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE is set - publishing ${label} WITHOUT ` +
            'verifying the source is healthy. The resulting archive becomes the newest (default) recovery ' +
            'source for anyone who restores it. Do not use this for a routine publish.')
        return { skipped: true, reasons: [] }
    }

    const {
        runner = execFileAsync,
        getModuleContainer = (m, c, n) => db.getModuleContainer(m, c, n),
        getDatabaseContainerId,
        askMariadbRootPassword,
        getExternalDbConfig,
        executeNativeMariaDbCommand,
        now = Date.now(),
        // A watermark returned by an EARLIER call to this gate. Given it, the marker
        // probe also refuses when a halt was raised anywhere between that call and
        // this one, which is the window the post-dump reading cannot otherwise see:
        // the archive is the --single-transaction snapshot taken inside it, so a halt
        // that arrived and was cleared while mariadb-dump streamed is captured in the
        // bytes that ship while both live readings look clean.
        since = null
    } = deps
    // Required late so the DatabaseService <-> BootstrapService require cycle
    // stays exactly as it was before this gate existed.
    const dbDeps = {
        runner,
        getDatabaseContainerId:      getDatabaseContainerId      || databaseService.getDatabaseContainerId,
        askMariadbRootPassword:      askMariadbRootPassword      || databaseService.askMariadbRootPassword,
        getExternalDbConfig:         getExternalDbConfig         || databaseService.getExternalDbConfig,
        executeNativeMariaDbCommand: executeNativeMariaDbCommand || databaseService.executeNativeMariaDbCommand
    }

    const reasons = []
    // Filled in by the marker probe below and handed back to the caller, which passes
    // it to the post-dump call as `since`.
    let watermark = null

    // 1. Container state.
    let containerId = null
    try {
        containerId = await getModuleContainer(module, coin, network)
    } catch (err) {
        reasons.push(`could not look up the ${module} container: ${err && err.message}`)
    }
    if (!containerId) {
        reasons.push(`no ${module} container is registered for ${coin}/${network}`)
    } else {
        try {
            reasons.push(...evaluateContainerState(await inspectContainer(containerId, runner), { now }))
        } catch (err) {
            reasons.push(`could not inspect the ${module} container: ${err && err.message}`)
        }
    }

    // 2. The service's own health surface (status, halt flags, lag).
    if (containerId) {
        let port = null
        try {
            const config = await getDefaultConfig(module, coin, network)
            port = config[MODULE_API_PORT_KEY[module]]
        } catch (err) {
            reasons.push(`could not resolve the ${module} API port: ${err && err.message}`)
        }
        if (!port) {
            reasons.push(`no API port configured for ${module}, so its health could not be verified`)
        } else {
            try {
                const payload = await probeServiceStatus(containerId, port, runner)
                reasons.push(...evaluateStatusPayload(payload, { maxLag: maxLagBlocks() }))
            } catch (err) {
                reasons.push(`the ${module} health probe failed: ${err && err.message}`)
            }
        }
    }

    // 3. Durable halt markers in the database that is about to be dumped, plus (for
    // an indexer) the paired decoder database that actually owns the REORG_HALT row.
    // This is the check that catches a decoder which is up, healthy-looking, and
    // quietly carrying a REORG_HALT row, including on an older image whose health
    // surface does not report it.
    if (MARIADB_MODULES.has(module)) {
        try {
            const markers = await readHaltMarkers(coin, network, module, dbDeps, since)
            watermark = {
                own: markers.watermark,
                upstream: markers.upstream ? markers.upstream.watermark : null
            }
            reasons.push(...windowReasons(markers.raisedInWindow))
            if (markers.upstream) reasons.push(...windowReasons(markers.upstream.raisedInWindow))
            if (markers.reorgHalt > 0)
                reasons.push("the database carries a durable REORG_HALT marker (events.code='REORG_HALT'): " +
                    'this decoder aborted mid-rollback and will halt at its next reorg. Restoring this archive ' +
                    'reproduces that fault on every consumer. Recovery is a full resync from a known-good snapshot, ' +
                    'or, once the rolled-back range is re-parsed and the database is verified intact, ' +
                    '`xchain-node clear-reorg-halt <chain> <network> --reason "..."`.')
            if (markers.syncHalt > 0)
                reasons.push('the database carries an uncleared xchain-sync divergence halt ' +
                    '(sync_halt with cleared_at IS NULL): its contents are known to diverge from the source of truth.')
            // An indexer's own database cannot hold these rows; the paired decoder's can,
            // and an indexer frozen behind a halted decoder is exactly as unfit to publish.
            if (markers.upstream && markers.upstream.reorgHalt > 0)
                reasons.push(`the paired decoder database ${markers.upstream.dbName} carries a durable REORG_HALT ` +
                    "marker (events.code='REORG_HALT'), so this indexer is frozen behind a decoder that aborted " +
                    'mid-rollback. Its own health surface reports lag 0 only because that lag is measured against ' +
                    'the frozen decoder height. Recovery is a full resync of the decoder and this indexer from a ' +
                    'known-good snapshot.')
            if (markers.upstream && markers.upstream.syncHalt > 0)
                reasons.push(`the paired decoder database ${markers.upstream.dbName} carries an uncleared ` +
                    'xchain-sync divergence halt (sync_halt with cleared_at IS NULL), so the rows this indexer ' +
                    'derived from it are known to diverge from the source of truth.')
        } catch (err) {
            reasons.push(`could not read the halt markers from the ${module} database: ${err && err.message}`)
        }
    }

    if (reasons.length > 0) throw new BootstrapSourceUnhealthyError(label, reasons)

    logger.info(`Bootstrap source health gate: ${label} is healthy, no halt markers, within the lag limit.`)
    return { skipped: false, reasons: [], watermark }
}

// Turn a probe's dump-window report into refusal reasons. Written for an operator:
// the archive is discarded because a halt existed while the dump was streaming, and
// the fix is to re-run the publish once the source has settled.
function windowReasons(raised) {
    if (!raised) return []
    const out = []
    if (raised.reorgHalt > 0)
        out.push("a REORG_HALT marker (events.code='REORG_HALT') was raised while the dump was streaming. " +
            'The archive is the snapshot taken inside that window, so it may carry the halt even though the ' +
            'database looks clean now. Re-run the publish once the source has settled.')
    if (raised.syncHalt > 0)
        out.push('an xchain-sync divergence halt (a sync_halt row) was raised while the dump was streaming, ' +
            'so the archive may carry it even though the row is cleared now. Re-run the publish once the ' +
            'source has settled.')
    for (const table of raised.unreadable || [])
        out.push(`could not tell whether a halt was raised while the dump was streaming: the ${table} id ` +
            'sequence does not line up with the reading taken before the dump. Re-run the publish.')
    return out
}

module.exports = {
    assertBootstrapSourceHealthy,
    BootstrapSourceUnhealthyError,
    // Exported for tests / reuse
    evaluateContainerState,
    evaluateStatusPayload,
    parseCountTokens,
    // StatusService reads a decoder's health surface through the same probe so
    // `xchain-node ps` can show a latent REORG_HALT.
    probeServiceStatus,
    MODULE_API_PORT_KEY
}
