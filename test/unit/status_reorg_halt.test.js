'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// `xchain-node ps` and a decoder's durable REORG_HALT marker. The marker keeps
// the decoder parsing and its healthcheck green (autoheal must not restart-loop
// it), so nothing docker reports shows it; the decoder's health surface does.
// These pin the reduction of that payload and the note the table prints.

const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const StatusService = proxyquire('../../src/services/status_service', {
    './docker_service':  { getStatusFromContainer: async () => { throw new Error('not used') } },
    './version_service': {
        checkRemoteNodeVersion: async () => {}, getLocalNodeVersion: async () => '0', getContainerNodeVersion: async () => '0',
        getLocalModuleVersion: async () => '0', getContainerModuleVersion: async () => '0'
    }
})
const { reduceDecoderReorgHalt, describeReorgHaltNote, reduceNodeCatchingUp, describeNodeCatchingUpNote,
        reduceNodeUnreachable, describeNodeUnreachableNote, describeDuration,
        reduceIndexerStall, describeIndexerStallNote, reduceTrackerHalt, describeTrackerHaltNote } = StatusService

// The indexer's surface carries `stallReason` (and `stallClass` on a build that
// grades its own stalls). A BTC testnet indexer with no DOGE read sat at one
// block for a day logging ROLLCALL PROOF UNAVAILABLE every five seconds while
// its node, its decoder and `ps` all read fine. This is where it shows now.
describe('ps: indexer STALL surface', function () {

    it('reduces a wedged host fault to the reason, its word and the last commit as an instant', function () {
        const r = reduceIndexerStall({ status: 'unhealthy', stallReason: 'rollcall_proof_unavailable', stallClass: 'wedged',
            lastBlockCommittedAt: 1757869440000 })
        expect(r).to.deep.equal({ stalled: true, reason: 'rollcall_proof_unavailable', word: 'rollcall_proof_unavailable',
            stall_class: 'wedged', since: '2025-09-14T17:04:00.000Z' })
        expect(reduceIndexerStall({ stallReason: 'x', lastBlockCommittedAt: null }).since).to.equal(null)
    })

    it('takes the word before the colon of a reason that carries prose', function () {
        const r = reduceIndexerStall({ stallReason: 'train_activation_halt: manifest names v3, this build implements v2' })
        expect(r.stalled).to.equal(true)
        expect(r.word).to.equal('train_activation_halt')
    })

    it('shows a host fault at once, even inside the grace window', function () {
        expect(reduceIndexerStall({ stallReason: 'rollcall_proof_unavailable', stallClass: 'barrier_defer' }).stalled).to.equal(true)
        expect(reduceIndexerStall({ stallReason: 'vm_executor_unavailable', stallClass: 'barrier_defer' }).stalled).to.equal(true)
    })

    it('does not show the two stalls the indexer itself calls healthy', function () {
        expect(reduceIndexerStall({ stallReason: 'price_sync_barrier', stallClass: 'barrier_defer' }).stalled).to.equal(false)
        expect(reduceIndexerStall({ stallReason: 'price_sync_barrier', stallClass: 'future_block_wait' }).stalled).to.equal(false)
        expect(reduceIndexerStall({ stallReason: 'price_sync_barrier', stallClass: 'wedged' }).stalled).to.equal(true)
    })

    it('reads an older image that names a reason but grades nothing as stalled, and no reason as advancing', function () {
        expect(reduceIndexerStall({ stallReason: 'oracle_sync_barrier' }).stalled).to.equal(true)
        expect(reduceIndexerStall({ status: 'healthy', stallReason: null }).stalled).to.equal(false)
        expect(reduceIndexerStall({ status: 'healthy' }).stalled).to.equal(false)
        expect(reduceIndexerStall({ stallReason: '  ' }).stalled).to.equal(false)
        expect(reduceIndexerStall(null)).to.equal(null)
        expect(reduceIndexerStall('garbage')).to.equal(null)
    })

    it('the roll-call note names the variable, the update command and the reason it defers', function () {
        const note = describeIndexerStallNote('bitcoin', 'testnet',
            { stalled: true, reason: 'rollcall_proof_unavailable', word: 'rollcall_proof_unavailable', stall_class: 'wedged', since: '2026-09-14T17:04:00Z' })
        expect(note).to.match(/^bitcoin\/testnet xchain-indexer is STALLED \(rollcall_proof_unavailable\), no block committed since 2026-09-14T17:04:00Z: /)
        expect(note).to.match(/silence as absence/)
        expect(note).to.match(/DOGE_INDEXER_API_URL \(and DOGE_INDEXER_API_KEY\)/)
        expect(note).to.match(/xchain-node update xchain-indexer bitcoin testnet/)
    })

    it('a barrier past its grace window gets the mirror line, and a decoder halt points at the decoder', function () {
        const barrier = describeIndexerStallNote('litecoin', 'mainnet', { reason: 'match_sync_barrier', word: 'match_sync_barrier', since: null })
        expect(barrier).to.match(/^litecoin\/mainnet xchain-indexer is STALLED \(match_sync_barrier\): a hub-mirror barrier/)
        expect(barrier).to.match(/xchain-node logs xchain-indexer litecoin mainnet/)
        const decoder = describeIndexerStallNote('bitcoin', 'mainnet', { reason: 'decoder_reorg_halt: decoder wrote a REORG_HALT marker', word: 'decoder_reorg_halt', since: null })
        expect(decoder).to.match(/see the decoder's line/)
    })
})

// The tracker's surface carries `halted` and `halt_reason` after an
// unrecoverable reorg. The flag is in memory, /status answers 503, and no
// restart clears it; the docker healthcheck failing is all `ps` showed.
describe('ps: tracker HALTED surface', function () {

    const DRAINED = "Can't delete a block from 'last blocks': list is empty (reorg exceeds tracked window). This index cannot be "
        + "walked back onto the node's chain and has to be rebuilt. Under xchain-node run `xchain-node reset xchain-utxo-tracker "
        + "<coin> <network>`, which drops the volume and takes the bulk-sync path; standalone, stop the tracker, empty its data "
        + "directory and restart it."

    it('reduces a halted payload, folding the reason to one line', function () {
        const r = reduceTrackerHalt({ status: 'halted', halted: true, halt_reason: 'unrecoverable reorg\n  (rolled back past   the recovery window)' })
        expect(r).to.deep.equal({ halted: true, reason: 'unrecoverable reorg' })
        expect(reduceTrackerHalt({ halted: true, halt_reason: DRAINED }).reason).to.equal(DRAINED)
    })

    it('reads an older image with no halted field, a string flag and a running tracker as not halted', function () {
        expect(reduceTrackerHalt({ status: 'healthy' }).halted).to.equal(false)
        expect(reduceTrackerHalt({ halted: 'true' }).halted).to.equal(false)
        expect(reduceTrackerHalt({ halted: false, halt_reason: null })).to.deep.equal({ halted: false, reason: null })
        expect(reduceTrackerHalt(null)).to.equal(null)
    })

    it('the note says no restart clears it, quotes the reason and names the reset once', function () {
        const note = describeTrackerHaltNote('bitcoin', 'testnet', { halted: true, reason: 'unrecoverable reorg (rolled back past the recovery window)' })
        expect(note).to.match(/^bitcoin\/testnet xchain-utxo-tracker is HALTED and no restart clears it/)
        expect(note).to.match(/unrecoverable reorg \(rolled back past the recovery window\)/)
        expect(note.match(/xchain-node reset xchain-utxo-tracker bitcoin testnet/g)).to.have.lengthOf(1)
        const drained = describeTrackerHaltNote('bitcoin', 'testnet', { halted: true, reason: DRAINED })
        expect(drained.match(/xchain-node reset xchain-utxo-tracker/g)).to.have.lengthOf(1)
    })
})

// The same surface carries `node_unreachable` while the service's most recent
// call to its coin node failed. A decoder on a Pi sat five and a half days with
// 2099 timeouts and not one answer, restart count 0, "Up 4 days (healthy)":
// the healthcheck is right not to fail (a restart fixes nothing), so this is
// the only place an operator sees it, and it must not read as the IBD wait.
describe('ps: NODE UNREACHABLE surface', function () {

    it('reduces an unreachable payload to since, the last answer and the duration', function () {
        const r = reduceNodeUnreachable({ status: 'healthy', node_last_ok_at: null,
            node_unreachable: { since: '2026-09-01T16:47:00Z', last_ok_at: null, seconds: 476400 } })
        expect(r).to.deep.equal({ since: '2026-09-01T16:47:00Z', last_ok_at: null, seconds: 476400 })
        const after = reduceNodeUnreachable({ node_unreachable: { since: '2026-09-07T06:29:07Z', last_ok_at: '2026-09-07T06:29:07Z', seconds: 90.7 } })
        expect(after).to.deep.equal({ since: '2026-09-07T06:29:07Z', last_ok_at: '2026-09-07T06:29:07Z', seconds: 90 })
    })

    it('reads null, an absent field, an older image and a malformed object as reachable', function () {
        expect(reduceNodeUnreachable({ status: 'healthy', node_unreachable: null })).to.equal(null)
        expect(reduceNodeUnreachable({ status: 'healthy' })).to.equal(null)
        expect(reduceNodeUnreachable({ node_unreachable: true })).to.equal(null)
        expect(reduceNodeUnreachable({ node_unreachable: { seconds: 5 } })).to.equal(null)
        expect(reduceNodeUnreachable(null)).to.equal(null)
    })

    it('tolerates a missing or negative duration', function () {
        expect(reduceNodeUnreachable({ node_unreachable: { since: 'x' } }).seconds).to.equal(null)
        expect(reduceNodeUnreachable({ node_unreachable: { since: 'x', seconds: -1 } }).seconds).to.equal(null)
    })

    it('renders durations the way an operator scans them', function () {
        expect(describeDuration(45)).to.equal('45s')
        expect(describeDuration(125)).to.equal('2m')
        expect(describeDuration(7500)).to.equal('2h 05m')
        expect(describeDuration(476400)).to.equal('5d 12h')
        expect(describeDuration(null)).to.equal(null)
    })

    it('the note says never answered, for how long, that it is not the IBD wait, and where to look', function () {
        const note = describeNodeUnreachableNote('bitcoin', 'mainnet', 'xchain-decoder',
            { since: '2026-09-01T16:47:00Z', last_ok_at: null, seconds: 476400 })
        expect(note).to.match(/^bitcoin\/mainnet xchain-decoder cannot reach its coin node \(5d 12h, since 2026-09-01T16:47:00Z\)/)
        expect(note).to.match(/NEVER had an answer/)
        expect(note).to.match(/not the initial-block-download wait/)
        expect(note).to.match(/bitcoin mainnet node container is running and answering RPC/)
    })

    it('the note names the last answer when there was one', function () {
        const note = describeNodeUnreachableNote('dogecoin', 'mainnet', 'xchain-utxo-tracker',
            { since: '2026-09-07T06:29:07Z', last_ok_at: '2026-09-07T06:29:07Z', seconds: 90 })
        expect(note).to.match(/last answer was at 2026-09-07T06:29:07Z/)
        expect(note).to.not.match(/NEVER/)
    })
})

// The same surface carries `node_catching_up` while a decoder or tracker waits
// out a coin node still in initial block download below its own tip (a
// bootstrap restored next to a fresh node). Idle and healthy is what
// docker sees; the wait is what the operator needs to see.
describe('ps: WAITING FOR NODE surface', function () {

    it('reduces a waiting payload to the two heights and the start of the wait', function () {
        const r = reduceNodeCatchingUp({ status: 'healthy', node_catching_up: { node_height: 962304, stored_height: 964970, since: '2026-09-07T06:29:08Z' } })
        expect(r).to.deep.equal({ node_height: 962304, stored_height: 964970, since: '2026-09-07T06:29:08Z' })
    })

    it('reads null, an absent field, an older image and a malformed object as not waiting', function () {
        expect(reduceNodeCatchingUp({ status: 'healthy', node_catching_up: null })).to.equal(null)
        expect(reduceNodeCatchingUp({ status: 'healthy' })).to.equal(null)
        expect(reduceNodeCatchingUp({ node_catching_up: 'yes' })).to.equal(null)
        expect(reduceNodeCatchingUp({ node_catching_up: { since: 'x' } })).to.equal(null)
        expect(reduceNodeCatchingUp(null)).to.equal(null)
    })

    it('tolerates a missing stored height', function () {
        const r = reduceNodeCatchingUp({ node_catching_up: { node_height: 5 } })
        expect(r).to.deep.equal({ node_height: 5, stored_height: null, since: null })
    })

    it('the note names the service, both heights, the remaining gap and that it resolves itself', function () {
        const note = describeNodeCatchingUpNote('bitcoin', 'mainnet', 'xchain-decoder', { node_height: 962304, stored_height: 964970, since: '2026-09-07T06:29:08Z' })
        expect(note).to.match(/^bitcoin\/mainnet xchain-decoder is WAITING FOR NODE since 2026-09-07T06:29:08Z/)
        expect(note).to.match(/coin node is at 962304/)
        expect(note).to.match(/stored height 964970 \(2666 blocks to go\)/)
        expect(note).to.match(/continues on its own once the node passes it/)
        const bare = describeNodeCatchingUpNote('litecoin', 'testnet', 'xchain-utxo-tracker', { node_height: 5, stored_height: null, since: null })
        expect(bare).to.match(/^litecoin\/testnet xchain-utxo-tracker is WAITING FOR NODE: /)
        expect(bare).to.not.match(/blocks to go/)
    })
})

describe('ps: decoder REORG_HALT surface', function () {

    it('reduces a halted health payload', function () {
        const r = reduceDecoderReorgHalt({
            status: 'healthy', reorg_halted: true, reorg_halted_at: '2026-09-07T06:29:07Z',
            reorg_halt_reason: 'verifyReorg: reorg depth exceeds the dispenser safe-depth window'
        })
        expect(r).to.deep.equal({
            halted: true, at: '2026-09-07T06:29:07Z',
            reason: 'verifyReorg: reorg depth exceeds the dispenser safe-depth window',
            cleared_at: null, cleared_reason: null
        })
    })

    it('reads an older image with no reorg_halted field as not halted, and a cleared halt as not halted', function () {
        expect(reduceDecoderReorgHalt({ status: 'healthy' }).halted).to.equal(false)
        expect(reduceDecoderReorgHalt({ reorg_halted: 'true' }).halted).to.equal(false)
        const cleared = reduceDecoderReorgHalt({ reorg_halted: false, reorg_halt_cleared_at: '2026-09-08T10:00:00Z', reorg_halt_cleared_reason: 'zero dispensers' })
        expect(cleared.halted).to.equal(false)
        expect(cleared.cleared_at).to.equal('2026-09-08T10:00:00Z')
    })

    it('returns null for anything that is not a payload', function () {
        expect(reduceDecoderReorgHalt(null)).to.equal(null)
        expect(reduceDecoderReorgHalt('garbage')).to.equal(null)
    })

    it('the note names the coin, the meaning, the halt reason and both recoveries', function () {
        const note = describeReorgHaltNote('bitcoin', 'mainnet', { halted: true, at: '2026-09-07T06:29:07Z', reason: 'safe-depth window' })
        expect(note).to.match(/^bitcoin\/mainnet xchain-decoder carries a durable REORG_HALT marker since 2026-09-07T06:29:07Z/)
        expect(note).to.match(/will refuse the next reorg and stop/)
        expect(note).to.match(/safe-depth window/)
        expect(note).to.match(/full resync/)
        expect(note).to.match(/xchain-node clear-reorg-halt bitcoin mainnet --reason/)
    })
})
