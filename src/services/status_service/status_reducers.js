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
let path = require('path')
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

// The stretch a decoder or tracker publishes while its most recent call to the
// coin node failed (`node_unreachable`, alongside `node_last_ok_at`), or null
// when the node answered last, the service has not called it yet, or the
// payload predates the field. Distinct from WAITING FOR NODE on purpose: a
// waiting service has an answer from its node and is idle by choice, an
// unreachable one has no answer at all. A decoder on a slow host once sat
// five and a half days in this state and every surface read healthy, because
// the docker healthcheck, correctly, does not fail on an outage a restart
// cannot fix. Strict on shape: an object with a `since` string.
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

// The line `ps` prints under the table for a service whose node is not
// answering: since when, whether it ever answered, and what to look at. Says
// explicitly that this is not the IBD wait, because from outside the two look
// the same (a healthy, idle container).
function describeNodeUnreachableNote(coin, network, module, gap) {
    const forHowLong = describeDuration(gap.seconds)
    return coin + "/" + network + " " + module + " cannot reach its coin node"
        + (forHowLong ? " (" + forHowLong + ", since " + gap.since + ")" : " (since " + gap.since + ")")
        + (gap.last_ok_at ? ": the last answer was at " + gap.last_ok_at + "." : ": it has NEVER had an answer from the node.")
        + " This is not the initial-block-download wait; the service has no answer to wait on."
        + " Check that the " + coin + " " + network + " node container is running and answering RPC"
        + " (a node mid-sync on slow hardware can time out every call for days), and its logs.";
}

// The REORG_HALT fields of a decoder health payload, or null for anything that
// is not a payload. Strict `=== true` on the flag: an older image without the
// field reads as not halted rather than as a halt.
function reduceDecoderReorgHalt(payload) {
    if (!payload || typeof payload !== 'object') return null
    return {
        halted:         payload.reorg_halted === true,
        at:             payload.reorg_halted_at || null,
        reason:         payload.reorg_halt_reason || null,
        cleared_at:     payload.reorg_halt_cleared_at || null,
        cleared_reason: payload.reorg_halt_cleared_reason || null
    }
}

// The line `ps` prints under the table for a halted decoder: what it means,
// since when, why, and both recoveries (the clear names its own preconditions).
function describeReorgHaltNote(coin, network, reorgHalt) {
    return coin + "/" + network + " xchain-decoder carries a durable REORG_HALT marker"
        + (reorgHalt.at ? " since " + reorgHalt.at : "")
        + ": it parses forward but will refuse the next reorg and stop."
        + (reorgHalt.reason ? " " + reorgHalt.reason : "")
        + " Recovery: a full resync, or once the rolled-back range is re-parsed and the database is verified intact, "
        + "`xchain-node clear-reorg-halt " + coin + " " + network + " --reason \"...\"`."
}

// The stall the indexer publishes on its health surface (`stallReason`, with
// `stallClass` beside it on a build that grades its own stalls), or null for
// anything that is not a payload. `stalled` is what the table shows. It is
// false for the two stalls the indexer itself calls healthy: a wait for wall
// clock to reach a future-stamped block, and a hub-mirror barrier still inside
// its grace window, which a BTC mainnet indexer's price mirror defers on
// almost every poll while the counter keeps advancing. A host fault (a
// missing DOGE read, a VM executor down) shows at once, and so does any stall
// the indexer graded wedged, or one an older image left ungraded.
function reduceIndexerStall(payload) {
    if (!payload || typeof payload !== 'object') return null
    const reason = typeof payload.stallReason === 'string' && payload.stallReason.trim() ? payload.stallReason.trim() : null
    const stallClass = typeof payload.stallClass === 'string' ? payload.stallClass : null
    const healthyDefer = stallClass === 'future_block_wait'
        || (stallClass === 'barrier_defer' && /_barrier$/.test(reason || ''))
    return {
        stalled:     reason !== null && !healthyDefer,
        reason,
        // The reason word alone, for the table: 'train_activation_halt: ...' reads as train_activation_halt.
        word:        reason ? reason.split(/[\s:]/)[0] : null,
        stall_class: stallClass,
        since:       describeCommitInstant(payload.lastBlockCommittedAt)
    }
}

// The indexer stamps its last commit in epoch milliseconds; the note wants an
// instant an operator can read. A string is passed through, anything else is null.
function describeCommitInstant(value) {
    if (typeof value === 'string' && value) return value
    if (Number.isFinite(value) && value > 0) return new Date(value).toISOString()
    return null
}

// What to do about each stall an indexer names, keyed by its reason word. A
// reason with no entry gets the barrier line, since every hub-mirror barrier
// is named `<something>_barrier` and they all clear the same way.
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
    train_activation_halt: (coin, network) =>
        "the signed release manifest names a rule set this build does not implement; `xchain-node update xchain-indexer " + coin + " " + network + "`.",
    reorg_rollback: () =>
        "a reorg rollback is in progress; it resumes on its own once the rolled-back range is re-parsed."
}

// The line `ps` prints under the table for a stalled indexer: the reason, how
// long no block has committed, and the remedy for that reason.
function describeIndexerStallNote(coin, network, stall) {
    const hint = INDEXER_STALL_HINTS[stall.word] || ((c, n) =>
        "a hub-mirror barrier (" + stall.reason + ") has held the head block past the grace window; check that the hub is answering"
        + " and its mirror stream is advancing, then `xchain-node logs xchain-indexer " + c + " " + n + "`.")
    return coin + "/" + network + " xchain-indexer is STALLED (" + stall.reason + ")"
        + (stall.since ? ", no block committed since " + stall.since : "")
        + ": " + hint(coin, network)
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
    reduceTrackerHalt,
    describeTrackerHaltNote,
    configureDependencies
}
