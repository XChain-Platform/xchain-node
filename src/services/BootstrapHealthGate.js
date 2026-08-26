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

const { XChainService, EXTERNAL_DB } = require('../config/constants')
const { db } = require('../state')
const { getDefaultConfig, getModuleDatabaseName } = require('./ConfigService')
const { dockerMariadbArgs, mariadbEnv } = require('../utils/dockerMariadb')

// A container that restarted recently is treated as crash-looping. Docker's
// RestartCount is cumulative for the container's life, so it only means
// "unstable" when paired with a short uptime; a container restarted once six
// months ago and up ever since is healthy.
const CRASH_LOOP_UPTIME_MS = 10 * 60 * 1000

// How far behind its own upstream a service may be and still be publishable.
// A bootstrap is a starting point, so a handful of blocks of drift is normal
// and harmless (the restorer catches up); hundreds of blocks means the service
// was not actually keeping up and the archive would hand every consumer that
// same backlog.
const DEFAULT_MAX_LAG_BLOCKS = 100

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
    const raw = String(process.env.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE || '').trim().toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes'
}

function maxLagBlocks() {
    const raw = parseInt(process.env.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS, 10)
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

// Parse the pipe-joined `docker inspect` format string below. Returns the list
// of refusal reasons (empty = the container looks stable).
function evaluateContainerState(raw, { now = Date.now() } = {}) {
    const reasons = []
    const [status, restarting, restartCount, startedAt, health] = String(raw || '').trim().split('|')

    if (!status) return ['could not read the container state from docker inspect']
    if (status !== 'running') reasons.push(`the container is not running (state: ${status})`)
    if (restarting === 'true') reasons.push('the container is restarting (crash loop)')

    const count = parseInt(restartCount, 10)
    const startedMs = Date.parse(startedAt)
    if (Number.isFinite(count) && count > 0 && Number.isFinite(startedMs)) {
        const uptimeMs = now - startedMs
        if (uptimeMs < CRASH_LOOP_UPTIME_MS) {
            reasons.push(`the container restarted ${count} time(s) and has only been up ` +
                `${Math.max(0, Math.round(uptimeMs / 1000))}s (crash-looping or still settling)`)
        }
    }

    // 'none' means the image/container carries no healthcheck; that is not a
    // fault by itself, the status probe below is the real check. 'starting'
    // IS a refusal: the service is inside its start period, so nothing has
    // confirmed it works yet, and fail-closed means we do not guess.
    if (health === 'unhealthy') reasons.push('docker reports the container HEALTHCHECK as unhealthy')
    if (health === 'starting') reasons.push('the container is still inside its healthcheck start period (no healthy check yet)')

    return reasons
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

// Interpret a decoder/indexer/utxo-tracker health payload. Pure, so the policy
// is unit-testable without docker. Field names differ per service, which is why
// every known spelling is checked rather than one canonical key:
//   decoder  health: status, lag_blocks/blockLag, reorg_halted, reorg_halt_checked_at
//   indexer  health: status, lag, decoderReorgHalted, stallClass
//   tracker  health: lag, synced, halted
//   any      /status: status ('ok'|'healthy'|'halted'|'degraded'|'unhealthy')
function evaluateStatusPayload(payload, { maxLag = DEFAULT_MAX_LAG_BLOCKS } = {}) {
    const reasons = []
    if (!payload || typeof payload !== 'object')
        return ['the service returned no readable status payload']

    const status = payload.status ? String(payload.status).toLowerCase() : null
    if (status && !['ok', 'healthy'].includes(status))
        reasons.push(`the service reports status "${payload.status}"`)

    if (payload.halted === true)
        reasons.push('the service reports itself HALTED' + (payload.halt_reason ? `: ${payload.halt_reason}` : ''))
    if (payload.reorg_halted === true)
        reasons.push('the decoder carries a durable REORG_HALT marker' +
            (payload.reorg_halt_reason ? `: ${payload.reorg_halt_reason}` : ''))
    // "not halted" is only an answer if something actually looked. The decoder's
    // marker probe is fail-soft on purpose (a DB blip keeps the last known state),
    // and that state starts at false with checked_at null, so a decoder that has
    // NEVER completed a probe publishes exactly what a clean one publishes. Keyed on
    // OWNING reorg_halted: the boolean and its timestamp shipped in the same decoder
    // commit, so a payload carrying one always carries the other, and an image
    // publishing neither is unaffected. The indexer's decoderReorgHalted has no
    // companion timestamp yet; extend this to it when the indexer publishes one.
    if (Object.prototype.hasOwnProperty.call(payload, 'reorg_halted')
        && (payload.reorg_halt_checked_at === null || payload.reorg_halt_checked_at === undefined))
        reasons.push('the decoder has never completed a REORG_HALT marker probe (reorg_halt_checked_at is ' +
            'null), so its "not halted" report is an untested default rather than a reading')
    if (payload.decoderReorgHalted === true)
        reasons.push('the upstream decoder carries a durable REORG_HALT marker, so this database is frozen behind it')
    // The indexer's own single-field verdict on its block counter:
    // 'none' | 'future_block_wait' | 'barrier_defer' | 'wedged'. Only 'wedged' is a
    // refusal, and it needs its own leg: the indexer reports status "healthy"
    // whenever its process is up and its DB circuit is closed, so a freshly-wedged
    // indexer whose lag is still inside the ceiling passes every other check here.
    // NOT keyed on `degraded`, which stays true throughout the healthy
    // future-stamped-block wait (the permanent testnet4 steady state) and would
    // refuse forever; stallClassOf resolves that wait to 'future_block_wait' before
    // it can ever reach 'wedged'. Strict equality, so an older image publishing no
    // stallClass keeps today's behavior exactly.
    if (payload.stallClass === 'wedged')
        reasons.push('the service reports its block counter WEDGED (stallClass "wedged": no commit for longer ' +
            'than its stall grace window)' + (payload.stallReason ? `: ${payload.stallReason}` : ''))
    if (payload.block_fetch_desync)
        reasons.push(`the service reports a block-fetch desync (${formatBlockFetchDesync(payload.block_fetch_desync)})`)
    if (payload.node_height_stale === true)
        reasons.push('the service cannot see the node tip (stale node height), so its lag is unknown')

    // First lag field the service actually publishes, bounded on BOTH sides. `null`
    // is a real answer and means "position unknown"; NO lag field at all means the
    // same thing (a /status body from an image that publishes none), and neither
    // can be certified as caught-up. A NEGATIVE lag is not "ahead": the service's
    // committed tip sits above its node's (the node-reset/reindex regression), so
    // the rows it would export reference blocks the node no longer recognizes. The
    // tracker floors its own synced verdict the same way; the ceiling stays local
    // because consumers own their own lag budget.
    const lagKeys = ['lag_blocks', 'blockLag', 'lag']
    const reported = lagKeys.find(k => Object.prototype.hasOwnProperty.call(payload, k))
    if (reported === undefined) {
        reasons.push('the service did not report how far behind it is (no lag field in its status payload), ' +
            'so its position could not be verified')
    } else {
        const lag = payload[reported]
        if (lag === null || lag === undefined)
            reasons.push(`the service cannot report how far behind it is (${reported} is null)`)
        else if (!Number.isFinite(Number(lag)))
            reasons.push(`the service reported an unreadable ${reported} (${lag})`)
        else if (Number(lag) < 0)
            reasons.push(`the service reported a negative ${reported} (${Number(lag)}): its committed tip sits above ` +
                'its upstream node\'s, so the data it would export may reference blocks the node no longer recognizes')
        else if (Number(lag) > maxLag)
            reasons.push(`the service is ${Number(lag)} blocks behind its upstream tip (limit ${maxLag}; ` +
                'override with XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS)')
    }

    return reasons
}

// The tracker publishes block_fetch_desync as {height, failures, lastError,
// detectedAt}, not a string; interpolated raw it renders "[object Object]" and
// loses the height/lastError that says the node is pruned past the cursor.
function formatBlockFetchDesync(desync) {
    if (!desync || typeof desync !== 'object') return String(desync)
    const parts = []
    if (desync.height !== undefined && desync.height !== null) parts.push(`height ${desync.height}`)
    if (desync.failures !== undefined && desync.failures !== null) parts.push(`${desync.failures} consecutive failed fetches`)
    if (desync.lastError) parts.push(`last error: ${desync.lastError}`)
    return parts.length ? parts.join(', ') : JSON.stringify(desync)
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

// The authoritative check for a decoder that is up and looks healthy but is
// quietly carrying a stale halt marker, and the one that does not depend on
// the running image being new enough to report the marker on its health
// surface: read the marker rows straight out of the database being dumped - and,
// for an indexer source, out of the paired decoder database that owns them.
async function readHaltMarkers(coin, network, module, deps) {
    const {
        runner,
        getDatabaseContainerId,
        askMariadbRootPassword,
        getExternalDbConfig,
        executeNativeMariaDbCommand
    } = deps

    // The names are derived from coin/network internally, never operator input, but
    // they are interpolated into SQL below; assert the shape rather than trust it.
    const assertDbName = (name) => {
        if (!/^[A-Za-z0-9_]+$/.test(String(name)))
            throw new Error(`refusing to probe an unexpected database name: ${name}`)
        return String(name)
    }
    const dbName = assertDbName(getModuleDatabaseName(module, coin, network))

    const run = async (sql) => {
        if (EXTERNAL_DB) {
            const cfg = await getExternalDbConfig()
            return String(await executeNativeMariaDbCommand(cfg, sql, '-BN'))
        }
        const dbContainerId = await getDatabaseContainerId()
        if (!dbContainerId) throw new Error('MariaDB container not found')
        const rootPassword = await askMariadbRootPassword(coin, network)
        const { stdout } = await runner(
            'docker',
            dockerMariadbArgs(dbContainerId, ['mariadb', '-u', 'root', '-BN', '-e', sql, 'information_schema']),
            { env: mariadbEnv(rootPassword) }
        )
        return String(stdout || '')
    }

    // Read one count, refusing on anything that is not a number. Output the probe
    // could not produce (an empty string from a mis-parsed client option, a driver
    // that returned nothing, a permission error rendered on stdout) parsed to NaN
    // here, and NaN loses every `> 0` comparison below, so "we could not tell"
    // arrived at the caller as "no halt markers" - the one collapse the file
    // header forbids.
    const readCount = async (sql, what) => {
        const raw = String(await run(sql)).trim()
        const value = parseInt(raw, 10)
        if (!Number.isFinite(value))
            throw new Error(`the ${what} probe returned unreadable output: ${JSON.stringify(raw)}`)
        return value
    }

    // Probe ONE database for both durable markers. Every failure shape throws, and
    // the caller turns a throw into a refusal reason: that is the whole contract.
    const probeDatabase = async (name) => {
        // One round trip: which marker tables exist, and how many live rows each has.
        // Counting information_schema rows (rather than querying the table directly)
        // keeps an absent table answerable as a 0 instead of an error; deciding what
        // that 0 means is this function's job below, and it is not always "clean".
        const query =
            `SELECT ` +
            `(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${name}' AND TABLE_NAME='events'), ` +
            `(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${name}' AND TABLE_NAME='sync_halt');`

        const rawTables = String(await run(query)).trim()
        const tableCounts = rawTables.split(/\s+/).map(n => parseInt(n, 10))
        if (tableCounts.length !== 2 || !tableCounts.every(Number.isFinite))
            throw new Error(`the marker-table probe for ${name} returned unreadable output: ${JSON.stringify(rawTables)}`)
        const [hasEvents, hasSyncHalt] = tableCounts

        // `events` is not optional on a decoder/indexer database: both provision it
        // unconditionally at startup (each repo's verifyTables creates every
        // src/sql/*.sql table), and it is the only durable home of the REORG_HALT
        // marker. Its absence therefore means the probe did not read the database
        // it was aimed at - a name drift, a wrong host - which is a refusal, not a
        // clean bill of health.
        if (hasEvents === 0)
            throw new Error(`${name} reports no events table, so the REORG_HALT marker could not be read`)

        const found = { reorgHalt: 0, syncHalt: 0 }
        found.reorgHalt = await readCount(
            `SELECT COUNT(*) FROM \`${name}\`.events WHERE code='REORG_HALT';`, 'REORG_HALT marker')
        // sync_halt IS optional: xchain-sync provisions it only where it runs, so an
        // absent table here is a genuine "no such marker", not an unread database.
        if (hasSyncHalt > 0)
            found.syncHalt = await readCount(
                `SELECT COUNT(*) FROM \`${name}\`.sync_halt WHERE cleared_at IS NULL;`, 'sync_halt marker')
        return found
    }

    const markers = await probeDatabase(dbName)

    // An xchain-indexer database structurally CANNOT carry the REORG_HALT marker, so
    // the probe above is a guaranteed zero for an indexer source and this backstop had
    // no reach there at all: the indexer only ever writes code='REORG' into its own
    // events table and reads the halt marker out of the DECODER's connection, while
    // the marker row is written solely into the decoder database. Nothing else in the
    // gate covers the gap either - the indexer's decoderReorgHalted mirror defaults
    // false and keeps its last value on any probe fault, and its published lag is
    // measured against the halted decoder's own frozen height, so it reads 0. Probe
    // the paired decoder database as well, fail-closed: probeDatabase throws on an
    // absent database, an absent events table and an unreadable count alike, and every
    // one of those means we could not tell.
    if (module === XChainService.XCHAIN_INDEXER) {
        const decoderDbName = assertDbName(getModuleDatabaseName(XChainService.XCHAIN_DECODER, coin, network))
        let upstream
        try {
            upstream = await probeDatabase(decoderDbName)
        } catch (err) {
            // Name the database that actually failed: the caller's wrapper names the
            // GATED module, which would otherwise blame the indexer for the decoder.
            throw new Error(`the paired decoder database ${decoderDbName} could not be probed: ${err && err.message}`)
        }
        markers.upstream = { dbName: decoderDbName, ...upstream }
    }
    return markers
}

// Refuse unless `module` on coin/network is a known-good bootstrap source.
// Resolves silently when the source passes; throws BootstrapSourceUnhealthyError
// (with every reason, not just the first) when it does not.
//
// `deps` exists for tests; production callers pass nothing.
async function assertBootstrapSourceHealthy(coin, network, module, deps = {}) {
    const label = `${coin}/${network} ${module}`

    if (gateSkipped()) {
        console.log(`WARNING: XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE is set - publishing ${label} WITHOUT ` +
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
        now = Date.now()
    } = deps
    // Required late so the DatabaseService <-> BootstrapService require cycle
    // stays exactly as it was before this gate existed.
    const databaseService = require('./DatabaseService')
    const dbDeps = {
        runner,
        getDatabaseContainerId:      getDatabaseContainerId      || databaseService.getDatabaseContainerId,
        askMariadbRootPassword:      askMariadbRootPassword      || databaseService.askMariadbRootPassword,
        getExternalDbConfig:         getExternalDbConfig         || databaseService.getExternalDbConfig,
        executeNativeMariaDbCommand: executeNativeMariaDbCommand || databaseService.executeNativeMariaDbCommand
    }

    const reasons = []

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
            const markers = await readHaltMarkers(coin, network, module, dbDeps)
            if (markers.reorgHalt > 0)
                reasons.push("the database carries a durable REORG_HALT marker (events.code='REORG_HALT'): " +
                    'this decoder aborted mid-rollback and will halt at its next reorg. Restoring this archive ' +
                    'reproduces that fault on every consumer. Recovery is a full resync from a known-good snapshot.')
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

    console.log(`Bootstrap source health gate: ${label} is healthy, no halt markers, within the lag limit.`)
    return { skipped: false, reasons: [] }
}

module.exports = {
    assertBootstrapSourceHealthy,
    BootstrapSourceUnhealthyError,
    // Exported for tests / reuse
    evaluateContainerState,
    evaluateStatusPayload,
    probeServiceStatus,
    readHaltMarkers,
    CRASH_LOOP_UPTIME_MS,
    DEFAULT_MAX_LAG_BLOCKS
}
