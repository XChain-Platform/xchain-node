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

const StatusService = proxyquire('../../src/services/StatusService', {
    './DockerService':  { getStatusFromContainer: async () => { throw new Error('not used') } },
    './VersionService': {
        checkRemoteNodeVersion: async () => {}, getLocalNodeVersion: async () => '0', getContainerNodeVersion: async () => '0',
        getLocalModuleVersion: async () => '0', getContainerModuleVersion: async () => '0'
    }
})
const { reduceDecoderReorgHalt, describeReorgHaltNote, reduceNodeCatchingUp, describeNodeCatchingUpNote,
        reduceNodeUnreachable, describeNodeUnreachableNote, describeDuration } = StatusService

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
