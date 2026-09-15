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
 *
 * XChain Node - Bootstrap source health gate status verdicts
 *
 * Pure verdicts over a container's `docker inspect` state and a service's own
 * status payload, plus the lag rendering their refusal reasons use. Nothing
 * here runs a probe; the gate hands these functions what its probes read.
 *
 ********************************************************************/

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

    reasons.push(...statusFlagReasons(payload))
    reasons.push(...lagReasons(payload, maxLag))

    return reasons
}

// Refusal reasons from the service's status string and its halt, stall, desync
// and stale-tip flags, in the order evaluateStatusPayload reports them.
function statusFlagReasons(payload) {
    const reasons = []
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
    // OWNING reorg_halted, and the pairing is per SURFACE rather than per image: the
    // decoder's JSON-RPC `health` result has always carried the timestamp, its GET
    // /status body did not until the field was added there (xchain-decoder
    // src/api.js), and its /live body still publishes the boolean alone. Only the
    // first two are probed here (see probeServiceStatus, which tries JSON-RPC `health`
    // then GET /status and nothing else), so an image predating that /status field is
    // refused by this leg on the fallback path. That is the intended fail-closed
    // direction and costs nothing today, because such a body carries no lag field
    // either and the lag leg below already refuses it. Do not restate this as "one
    // field implies the other": that claim was false for the /status fallback for as
    // long as it stood here. The indexer's decoderReorgHalted has no companion
    // timestamp yet; extend this to it when the indexer publishes one.
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

    return reasons
}

// Refusal reasons from the first lag field the payload publishes, checked
// against `maxLag`.
function lagReasons(payload, maxLag) {
    const reasons = []
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
        const value = strictLagValue(lag)
        if (lag === null || lag === undefined)
            reasons.push(`the service cannot report how far behind it is (${reported} is null)`)
        else if (value === null)
            reasons.push(`the service reported an unreadable ${reported} (${renderLag(lag)})`)
        else if (value < 0)
            reasons.push(`the service reported a negative ${reported} (${value}): its committed tip sits above ` +
                'its upstream node\'s, so the data it would export may reference blocks the node no longer recognizes')
        else if (value > maxLag)
            reasons.push(`the service is ${value} blocks behind its upstream tip (limit ${maxLag}; ` +
                'override with XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS)')
    }

    return reasons
}

// Read a lag field by SHAPE, before any comparison. Number() answers 0 for '',
// ' ', false and [], so coercing first and testing Number.isFinite afterwards let
// each of those certify an unknown position as caught up: the gate's own
// fail-closed parsing contract collapsed into "we could not tell = no lag".
// A number is a lag; so is a string a producer spelled one in (every in-repo
// producer emits number-or-null, but a drifted or older image may not). Anything
// else is unreadable, which is a refusal. Returns null for "not a lag value".
function strictLagValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed === '') return null
        const parsed = Number(trimmed)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

// Name the rejected value in the refusal reason. Interpolating it raw renders []
// as an empty string and an object as "[object Object]", which reads as if the
// probe found nothing rather than something it refused.
function renderLag(value) {
    if (typeof value === 'string') return JSON.stringify(value)
    if (typeof value === 'object') { try { return JSON.stringify(value) } catch (_) { return String(value) } }
    return String(value)
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

module.exports = {
    DEFAULT_MAX_LAG_BLOCKS,
    evaluateContainerState,
    evaluateStatusPayload
}
