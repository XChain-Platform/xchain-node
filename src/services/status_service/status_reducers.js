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
 * XChain Node - Status Service
 * Tracks installed modules and container status
 ********************************************************************/

let { XChainService } = require('../../config')
let childProcess = require('child_process')
let nodeUtil = require('util')
const path = require('path')
let configService = require('../config_service')
// The peer table names files beside src/services, one directory up from this part.
let peers = require('../peer_services').bindPeerServices((file) => require(path.join('..', file)))

function configureDependencies(dependencies) {
    ;({ XChainService, childProcess, nodeUtil, configService, peers } = dependencies)
}

// Distinguish a `docker inspect` failure that means the container is genuinely
// gone (safe to reconcile out of the persistent registry) from a transient one
// (daemon down, timeout, permission) where the container may still be live.
// `docker inspect <id>` on a missing id exits non-zero with "No such
// object/container"; anything we cannot positively identify as gone is treated
// as transient, so an ambiguous error never deletes a registry row (fail-safe:
// keep the row rather than risk dropping a live container from management).
function isContainerGoneError(err) {
    if (!err) return false
    const text = String((err.stderr || '') + ' ' + (err.message || '')).toLowerCase()
    return /no such (object|container|image)/.test(text)
}

// The decoder's `health` JSON-RPC answer, reduced to its REORG_HALT fields, or
// null when the surface is unreadable. Read through peers: BootstrapHealthGate pulls
// in DatabaseService, and StatusService is itself required from the operations
// layer that DatabaseService reaches back into. The 15s ceiling keeps a wedged
// container from holding `ps` hostage.
async function probeServiceHealthPayload(module, containerId, coin, network) {
    const { probeServiceStatus, MODULE_API_PORT_KEY } = peers.bootstrapHealthGate
    const { getDefaultConfig } = configService
    const { execFile } = childProcess
    const { promisify } = nodeUtil
    const runner = (cmd, args) => promisify(execFile)(cmd, args, { timeout: 15000 })
    const config = await getDefaultConfig(module, coin, network)
    const port = config && config[MODULE_API_PORT_KEY[module]]
    if (!port) return null
    return probeServiceStatus(containerId, port, runner)
}

// Readiness uses a separate route because the JSON-RPC health method omits it.
const READINESS_ROUTE = { 'xchain-indexer': '/status', 'xchain-decoder': '/live' }

// An unreadable or older readiness surface returns null.
async function probeReadinessPayload(module, containerId, coin, network) {
    const route = READINESS_ROUTE[module]
    const { probeReadinessSurface, MODULE_API_PORT_KEY } = peers.bootstrapHealthGate
    if (!route || typeof probeReadinessSurface !== 'function') return null
    const config = await configService.getDefaultConfig(module, coin, network)
    const port = config && config[MODULE_API_PORT_KEY[module]]
    if (!port) return null
    const runner = (cmd, args) => nodeUtil.promisify(childProcess.execFile)(cmd, args, { timeout: 15000 })
    return probeReadinessSurface(containerId, port, route, runner)
}

async function probeDecoderReorgHalt(containerId, coin, network) {
    return reduceDecoderReorgHalt(await probeServiceHealthPayload(XChainService.XCHAIN_DECODER, containerId, coin, network))
}

// The wait a decoder or tracker publishes while its coin node is still in
// initial block download below the service's own tip (`node_catching_up`,
// see the decoder and tracker IBD wait), or null when the service is not waiting or the payload
// predates the field. Strict on shape: an object with a numeric node height.
function reduceNodeCatchingUp(payload) {
    if (!payload || typeof payload !== 'object') return null
    const wait = payload.node_catching_up
    if (!wait || typeof wait !== 'object') return null
    const nodeHeight   = Number(wait.node_height)
    const storedHeight = Number(wait.stored_height)
    if (!Number.isFinite(nodeHeight)) return null
    return {
        node_height:   nodeHeight,
        stored_height: Number.isFinite(storedHeight) ? storedHeight : null,
        since:         wait.since || null
    }
}

// The line `ps` prints under the table for a service waiting on its node:
// what it is waiting for, how far the node has to go, and that it is not stuck.
function describeNodeCatchingUpNote(coin, network, module, wait) {
    const gap = (wait.stored_height !== null && Number.isFinite(wait.stored_height))
        ? " (" + Math.max(0, wait.stored_height - wait.node_height) + " blocks to go)" : ""
    return coin + "/" + network + " " + module + " is WAITING FOR NODE"
        + (wait.since ? " since " + wait.since : "")
        + ": the coin node is at " + wait.node_height + ", still in initial block download below the service's "
        + (wait.stored_height !== null ? "stored height " + wait.stored_height : "stored height") + gap
        + ". This is expected after a bootstrap restore next to a fresh node; the service continues on its own once the node passes it."
}

// A decoder or tracker publishes `node_unreachable` while its coin node does
// not answer. This differs from an IBD wait, where the node answered and the
// service is idle by choice. Strict on shape: an object with a `since` string.
function reduceNodeUnreachable(payload) {
    if (!payload || typeof payload !== 'object') return null
    const gap = payload.node_unreachable
    if (!gap || typeof gap !== 'object' || typeof gap.since !== 'string' || !gap.since) return null
    const seconds = Number(gap.seconds)
    return {
        since:      gap.since,
        last_ok_at: typeof gap.last_ok_at === 'string' && gap.last_ok_at ? gap.last_ok_at : null,
        seconds:    Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null
    }
}

// "3d 4h", "2h 05m", "45s": what an operator scans for, not a raw second count.
function describeDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return null
    const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60)
    if (d > 0) return d + "d " + h + "h"
    if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m"
    if (m > 0) return m + "m"
    return Math.floor(seconds) + "s"
}

// Describe when the node last answered and distinguish this from an IBD wait,
// which otherwise looks like the same healthy, idle container.
function describeNodeUnreachableNote(coin, network, module, gap) {
    const forHowLong = describeDuration(gap.seconds)
    return coin + "/" + network + " " + module + " cannot reach its coin node"
        + (forHowLong ? " (" + forHowLong + ", since " + gap.since + ")" : " (since " + gap.since + ")")
        + (gap.last_ok_at ? ": the last answer was at " + gap.last_ok_at + "." : ": it has NEVER had an answer from the node.")
        + " This is not the initial-block-download wait; the service has no answer to wait on."
        + " Check that the " + coin + " " + network + " node container is running and answering RPC"
        + " (a node mid-sync on slow hardware can time out every call for days), and its logs.";
}

// Reduce a decoder health payload to a halted, unknown, or confirmed-clear state.
// A parked parse loop is halted even if its marker read reports false.
function reduceDecoderReorgHalt(body) {
    if (!body || typeof body !== 'object') return null
    const payload = body.result !== undefined ? body.result : body
    if (!payload || typeof payload !== 'object') return null
    const flagPresent = Object.prototype.hasOwnProperty.call(payload, 'reorg_halted')
    const parked = payload.reorg_halt_parked === true
    const state = payload.reorg_halted === true || parked ? 'halted'
        : payload.reorg_halted === false && payload.reorg_halt_checked_at != null ? 'clear' : 'unknown'
    return {
        state,
        halted:         state === 'halted',
        unverified:      state === 'unknown',
        flag_present:    flagPresent,
        at:             payload.reorg_halted_at || null,
        reason:         payload.reorg_halt_reason || null,
        cleared_at:     payload.reorg_halt_cleared_at || null,
        cleared_reason: payload.reorg_halt_cleared_reason || null,
        checked_at:     payload.reorg_halt_checked_at == null ? null : payload.reorg_halt_checked_at,
        parked,
        parked_at:      payload.reorg_halt_parked_at || null
    }
}

// The line `ps` prints under the table for a halted or unverified decoder.
function describeReorgHaltNote(coin, network, reorgHalt) {
    if (reorgHalt.unverified) {
        const cause = reorgHalt.flag_present
            ? "The decoder has not completed a REORG_HALT marker probe since it started; check database readability and " +
                "`xchain-node logs xchain-decoder " + coin + " " + network + "`."
            : "The decoder image does not publish the halt field; update it with `xchain-node update xchain-decoder " +
                coin + " " + network + "`."
        return coin + "/" + network + " xchain-decoder REORG_HALT state is UNVERIFIED: its \"not halted\" state cannot be confirmed. " +
            "This is NOT a confirmed halt. " + cause
    }
    const activity = reorgHalt.parked
        ? ": its parse loop is PARKED" + (reorgHalt.parked_at ? " since " + reorgHalt.parked_at : "") +
            " on a REORG_HALT, so nothing is being parsed."
        : ": it parses forward but will refuse the next reorg and stop."
    return coin + "/" + network + " xchain-decoder carries a durable REORG_HALT marker"
        + (reorgHalt.at ? " since " + reorgHalt.at : "")
        + activity
        + (reorgHalt.reason ? " " + reorgHalt.reason : "")
        + " Recovery: a full resync, or once the rolled-back range is re-parsed and the database is verified intact, "
        + "`xchain-node clear-reorg-halt " + coin + " " + network + " --reason \"...\"`."
}

// A pending train activation remains visible while the indexer still advances,
// so operators can update before the activation boundary.
function reduceTrainActivationPending(payload) {
    if (!payload || typeof payload !== 'object') return null
    const train = payload.train_activation
    if (!train || typeof train !== 'object' || train.status !== 'pending') return null
    return {
        pending: true,
        required_rule_set: train.required_rule_set == null ? null : train.required_rule_set,
        required_at_height: train.required_at_height == null ? null : train.required_at_height,
        reason: train.reason == null ? null : train.reason
    }
}

function describeTrainActivationPendingNote(coin, network, finding) {
    const rule = finding.required_rule_set == null ? ' a rule set this build does not implement'
        : ' rule set ' + finding.required_rule_set + ', which this build does not implement'
    const height = finding.required_at_height == null ? ' at the activation boundary'
        : ' from BTC height ' + finding.required_at_height
    return coin + "/" + network + " xchain-indexer has an UPGRADE PENDING: the signed release manifest requires"
        + rule + height + ". It is advancing now but will halt at that boundary; run `xchain-node update xchain-indexer "
        + coin + " " + network + "` before activation."
}

function reduceIndexerStall(payload) {
    if (!payload || typeof payload !== 'object') return null
    const reason = typeof payload.stallReason === 'string' && payload.stallReason.trim() ? payload.stallReason.trim() : null
    const stallClass = typeof payload.stallClass === 'string' ? payload.stallClass : null
    const train = payload.train_activation
    const trainRuleSet = train && typeof train === 'object'
        ? (typeof train.required_rule_set === 'string' && train.required_rule_set.trim()
            ? train.required_rule_set.trim() : null)
        : undefined
    // The reason word alone, for the table: 'train_activation_halt: ...' reads as train_activation_halt.
    const word = reason ? reason.split(/[\s:]/)[0] : null
    // The price-landing wait is that same in-grace barrier defer, judged on its own longer window.
    // Tests the word, as fallbackIndexerStallHint does, so exception prose ending in `_barrier` never reads healthy.
    const healthyDefer = stallClass === 'future_block_wait'
        || ((stallClass === 'barrier_defer' || stallClass === 'price_landing_wait') && /_barrier$/.test(word || ''))
    const stall = {
        stalled:     reason !== null && !healthyDefer,
        reason,
        word,
        stall_class: stallClass,
        since:       describeCommitInstant(payload.lastBlockCommittedAt)
    }
    if (trainRuleSet !== undefined) stall.train_required_rule_set = trainRuleSet
    return stall
}

// The readiness verdict a service publishes: the indexer's `ready` / `notReadyReasons`
// (/status) and `barrierCeilingExceeded`, the decoder's `ready` / `not_ready_reasons`
// (/live). Strict on shape: only `ready === false` or `barrierCeilingExceeded === true`
// is a finding, so an older image that lacks the fields reads as ready, as today. A hub
// barrier held past its ceiling is NOT READY even though reduceIndexerStall calls a
// barrier_defer healthy: the block is not advancing and the hub is why.
function reduceNotReady(payload) {
    if (!payload || typeof payload !== 'object') return null
    const ceiling = payload.barrierCeilingExceeded === true
    if (payload.ready !== false && !ceiling) return null
    const listed = [payload.notReadyReasons, payload.not_ready_reasons].find(Array.isArray) || []
    const reasons = listed.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim())
    if (ceiling && !reasons.includes('barrier_ceiling_exceeded')) reasons.push('barrier_ceiling_exceeded')
    return { notReady: true, reasons }
}

// The line `ps` prints under the table for a service that is up but not ready.
function describeNotReadyNote(coin, network, module, finding) {
    return coin + "/" + network + " " + module + " is NOT READY"
        + (finding.reasons.length ? " (" + finding.reasons.join(", ") + ")" : "")
        + ": the process is alive and its healthcheck passes, but it is not serving the chain right now."
        + " A restart does not clear this; `xchain-node logs " + module + " " + coin + " " + network + "` names the cause."
}

// The indexer stamps its last commit in epoch milliseconds; the note wants an
// instant an operator can read. A string is passed through, anything else is null.
function describeCommitInstant(value) {
    if (typeof value === 'string' && value) return value
    if (Number.isFinite(value) && value > 0) return new Date(value).toISOString()
    return null
}

// What to do about each stall an indexer names, keyed by its reason word. A
// reason with no entry gets the hub-mirror line only when its word ends in
// `_barrier` (the indexer's name for a hub-mirror barrier), else the log line.
// The bridge proof wait ends in `_barrier` but no hub resync shortens it, so it has its own entry.
// The capability proof wait is not a hub-mirror barrier either, and has its own entry too.
const INDEXER_STALL_HINTS = {
    rollcall_proof_unavailable: (coin, network) =>
        "it cannot prove on Dogecoin who signed the roll call, so it defers the epoch close rather than read silence as absence."
        + " Set DOGE_INDEXER_API_URL (and DOGE_INDEXER_API_KEY) in the host .env to a reachable dogecoin " + network + " indexer"
        + " and run `xchain-node update xchain-indexer " + coin + " " + network + "`; if it is already set, check that the URL answers.",
    anchor_reward_proof_unavailable: () =>
        "it cannot read the Dogecoin anchor it must prove a reward against; check that DOGE_INDEXER_API_URL answers.",
    vm_executor_unavailable: (coin, network) =>
        "the VM executor is not answering; `xchain-node logs xchain-indexer " + coin + " " + network + "` names the host fault.",
    decoder_reorg_halt: () =>
        "its decoder carries a REORG_HALT marker (see the decoder's line); the indexer follows once the decoder is resynced or cleared.",
    decoder_reorg_halt_unverified: (coin, network) =>
        "it has not completed a read of its decoder's REORG_HALT marker since start, so it holds its pass rather than risk following a halted decoder."
        + " This is not a confirmed halt: check the decoder's line and database readability, then look for the REORG_HALT probe failed warning in"
        + " `xchain-node logs xchain-indexer " + coin + " " + network + "`; the pass resumes once a probe read succeeds.",
    train_activation_halt: (coin, network, stall) => {
        if (stall.train_required_rule_set === undefined)
            return "the signed release manifest names a rule set this build does not implement; `xchain-node update xchain-indexer " + coin + " " + network + "`."
        if (stall.train_required_rule_set)
            return "the signed release manifest names rule set " + stall.train_required_rule_set + ", which this build does not implement; "
                + "`xchain-node update xchain-indexer " + coin + " " + network + "`."
        return "the activation gate could not determine the required rule set because the manifest block is unreadable or the gate faulted. "
            + "An update is not by itself the fix; check the release manifest and `xchain-node logs xchain-indexer "
            + coin + " " + network + "`."
    },
    reorg_rollback: () =>
        "a reorg rollback is in progress; it resumes on its own once the rolled-back range is re-parsed.",
    ...require('./indexer_stall_hints'),
    retroactive_replay_needs_go: (coin, network) =>
        "the replay exceeded its block cap and needs an operator go row."
        + " `xchain-node logs xchain-indexer " + coin + " " + network + "` prints the exact go command.",
    retroactive_replay_diverged: (coin, network) =>
        "a replay witness did not reproduce its recorded result, so no block applies."
        + " Neither a restart nor a hub resync clears this data fault; fix the input named by"
        + " `xchain-node logs xchain-indexer " + coin + " " + network + "`, then run the rewitness command for the target.",
    bridge_proof_barrier: (coin, network) =>
        "it is waiting for a bridge escrow proof and defers the block rather than mint unproven. This is not a hub-mirror fault,"
        + " and neither a hub resync nor a restart shortens it: it clears once this node holds a quorum-established checkpoint"
        + " at or after the transfer's snapshot block, or an origin-chain indexer endpoint is configured and serves the proof."
        + " Look for BRIDGE ESCROW PROOF UNAVAILABLE in `xchain-node logs xchain-indexer " + coin + " " + network + "`.",
    capability_proof_unavailable: (coin, network) =>
        "it holds a mirrored capability snapshot row whose checkpoint proof it cannot verify yet, and defers the block rather than"
        + " apply an unproven validator set. This is not a hub-mirror lag, and a hub resync does not supply the proof:"
        + " held rows are re-checked every 15 seconds and the block moves once the proof verifies; a hold that outlasts the"
        + " proof-wait grace earns one automatic restart, which clears proof state held only in memory."
        + " `xchain-node logs xchain-indexer " + coin + " " + network + "` shows a \"Capability snapshot proof held\" line naming why,"
        + " such as the hub not serving the proof or the checkpoint validator trust pin missing or unreadable.",
    list_share_halt: (coin, network) =>
        "it refuses to commit the block because a list version is missing or altered, and committing would fork it from its peers;"
        + " this is not a hub-mirror wait. `xchain-node logs xchain-indexer " + coin + " " + network + "` shows the LIST SHARE HALT line and its reason.",
    parse_exception: (coin, network) =>
        "the same exception hit the same block twice, so the block is not committing;"
        + " `xchain-node logs xchain-indexer " + coin + " " + network + "` shows the repeated parse error."
}

// Hub-mirror line for an unlisted `_barrier` word, neutral log line for any other unlisted
// reason. Tests the word, not the reason, so exception prose ending in `_barrier` never matches.
function fallbackIndexerStallHint(stall) {
    if (/_barrier$/.test(stall.word || '')) return (c, n) =>
        "a hub-mirror barrier (" + stall.reason + ") has held the head block past the grace window; check that the hub is answering"
        + " and its mirror stream is advancing, then `xchain-node logs xchain-indexer " + c + " " + n + "`."
    return (c, n) => "`ps` has no specific remedy for this stall; `xchain-node logs xchain-indexer " + c + " " + n + "` names the fault."
}

// The line `ps` prints under the table for a stalled indexer: the reason, how
// long no block has committed, and the remedy for that reason.
function describeIndexerStallNote(coin, network, stall) {
    const hint = INDEXER_STALL_HINTS[stall.word] || fallbackIndexerStallHint(stall)
    return coin + "/" + network + " xchain-indexer is STALLED (" + stall.reason + ")"
        + (stall.since ? ", no block committed since " + stall.since : "")
        + ": " + hint(coin, network, stall)
}

// The halt a tracker publishes after an unrecoverable reorg (`halted`, with
// `halt_reason`), or null for anything that is not a payload. Strict
// `=== true` on the flag, as for the decoder: an older image without the
// field reads as running rather than as a halt. The reason is folded to one
// line because the tracker writes it as a paragraph.
function reduceTrackerHalt(payload) {
    if (!payload || typeof payload !== 'object') return null
    const reason = typeof payload.halt_reason === 'string' ? payload.halt_reason.split(/\r?\n/)[0].replace(/\s+/g, ' ').trim() : ''
    return {
        halted: payload.halted === true,
        reason: reason || null
    }
}

// The line `ps` prints under the table for a halted tracker: that no restart
// clears it, why it halted, and the one recovery.
function describeTrackerHaltNote(coin, network, halt) {
    // The tracker's own reason names the reset when the window ran dry; say it once.
    const namesReset = /xchain-node reset/.test(halt.reason || "")
    return coin + "/" + network + " xchain-utxo-tracker is HALTED and no restart clears it: it stopped polling after an unrecoverable reorg"
        + " and answers 503 until it is rebuilt."
        + (halt.reason ? " " + halt.reason : "")
        + (namesReset ? "" : " Recovery: `xchain-node reset xchain-utxo-tracker " + coin + " " + network + "`, which drops the store and takes the bulk-sync path.")
}

module.exports = {
    isContainerGoneError,
    probeServiceHealthPayload,
    probeReadinessPayload,
    reduceNotReady,
    describeNotReadyNote,
    probeDecoderReorgHalt,
    reduceNodeCatchingUp,
    describeNodeCatchingUpNote,
    reduceNodeUnreachable,
    describeDuration,
    describeNodeUnreachableNote,
    reduceDecoderReorgHalt,
    describeReorgHaltNote,
    reduceIndexerStall,
    describeIndexerStallNote,
    reduceTrainActivationPending,
    describeTrainActivationPendingNote,
    reduceTrackerHalt,
    describeTrackerHaltNote,
    configureDependencies
}
