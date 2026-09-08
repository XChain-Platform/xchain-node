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
const { reduceDecoderReorgHalt, describeReorgHaltNote } = StatusService

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
