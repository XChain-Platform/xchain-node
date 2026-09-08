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
const { reduceDecoderReorgHalt, describeReorgHaltNote, reduceNodeCatchingUp, describeNodeCatchingUpNote } = StatusService

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
