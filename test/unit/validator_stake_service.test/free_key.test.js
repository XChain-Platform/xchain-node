'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The free-key rules the stake CLI mirrors from the indexer, and the reuse
// gate heights' agreement with the indexer row they copy.

const fs   = require('fs')
const path = require('path')
const { expect } = require('chai')

const {
    STAKE_KEY_REUSE_ACTIVATION, stakeKeyReuseHeight, stakeRowsHoldingKey,
    delegationRowsHoldingKey, sumAmounts, readDelegationsByPubkey
} = require('../../../src/services/validator_stake_service/free_key')

describe('validator stake free-key rules', function () {

    it('resolves the reuse gate COIN:network first, then the bare network', () => {
        expect(stakeKeyReuseHeight('testnet', 'BTC')).to.equal(156000)
        expect(stakeKeyReuseHeight('testnet', 'LTC')).to.equal(4897000)
        expect(stakeKeyReuseHeight('regtest', 'BTC')).to.equal(0)
        expect(stakeKeyReuseHeight('mainnet', 'BTC')).to.equal(null)
        expect(stakeKeyReuseHeight('testnet', 'XYZ')).to.equal(null)
        expect(stakeKeyReuseHeight('constructor', null)).to.equal(null)
    })

    it('before the gate every valid row holds the key, withdrawn or not', () => {
        const rows = [{ deactivation_block: '10' }, { deactivation_block: null }]
        expect(stakeRowsHoldingKey(rows, { reuseActive: false, landBlock: 99999, cooldownBlocks: 1000 })).to.have.length(2)
    })

    it('after the gate a row releases the key at deactivation_block + cooldown, not a block before', () => {
        const opts = (landBlock) => ({ reuseActive: true, landBlock, cooldownBlocks: 1000 })
        const rows = [{ deactivation_block: '5000' }]
        expect(stakeRowsHoldingKey(rows, opts(5999))).to.have.length(1)
        expect(stakeRowsHoldingKey(rows, opts(6000))).to.have.length(0)
        expect(stakeRowsHoldingKey([{ deactivation_block: null }], opts(1e9))).to.have.length(1)
        expect(stakeRowsHoldingKey([{ deactivation_block: 'junk' }], opts(1e9)), 'unreadable holds').to.have.length(1)
    })

    it('a delegation holds the key until its deactivation block has passed', () => {
        const d = (deactivation_block, status = 'valid') => [{ status, deactivation_block }]
        expect(delegationRowsHoldingKey(d(null), 10)).to.have.length(1)
        expect(delegationRowsHoldingKey(d('11'), 10)).to.have.length(1)
        expect(delegationRowsHoldingKey(d('10'), 10)).to.have.length(0)
        expect(delegationRowsHoldingKey(d('10'), null), 'no tip means the refusing side').to.have.length(1)
        expect(delegationRowsHoldingKey(d(null, 'invalid: x'), 10)).to.have.length(0)
    })

    it('sums amounts exactly in 1e-8 units and refuses to guess on a malformed one', () => {
        expect(sumAmounts([{ amount: '0.1' }, { amount: '0.2' }])).to.equal('0.3')
        expect(sumAmounts([{ amount: '12345678.12345678' }, { amount: '87654321.87654321' }])).to.equal('99999999.99999999')
        expect(sumAmounts([{ amount: '0.00000001' }])).to.equal('0.00000001')
        expect(sumAmounts([{ amount: '900000000.00000001' }, { amount: '0.00000001' }])).to.equal('900000000.00000002')
        expect(sumAmounts([{ amount: '25000' }, { amount: '1e3' }])).to.equal(null)
    })

    it('pages the pubkey lookup to the end and refuses a response with no row list', async () => {
        const pubkey = 'ab'.repeat(32)
        const page = (n) => Array.from({ length: n }, (_, i) => ({ status: 'valid', signing_pubkey: pubkey, action_index: String(i) }))
        const calls = []
        const sdk = { explorer: { getDelegations: async (q, t, o) => {
            calls.push(o.page)
            return o.page === 1 ? { total: 101, data: page(100) } : { total: 101, data: page(1) }
        } } }
        expect(await readDelegationsByPubkey(sdk, pubkey)).to.have.length(101)
        expect(calls).to.deep.equal([1, 2])
        const bad = { explorer: { getDelegations: async () => ({ error: 'no route' }) } }
        let err = null
        try { await readDelegationsByPubkey(bad, pubkey) } catch (e) { err = e }
        expect(err && err.message).to.include('no row list')
    })
})

// The heights are a copy of consensus data the CLI only reads. With the
// sibling indexer checkout present, hold the copy to the indexer's
// stake_key_reuse_activation row; a standalone deploy skips, and
// XCHAIN_REQUIRE_SIBLINGS=1 turns every miss into a failure.
describe('stake_key_reuse_activation mirror agrees with the xchain-indexer gate row', function () {
    const INDEXER_DIR          = process.env.XCHAIN_INDEXER_DIR || path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer')
    const PROTOCOL_CHANGES_DIR = path.join(INDEXER_DIR, 'src', 'protocol_changes')
    const REQUIRE_SIBLINGS     = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'
    const ROW = "addGate('stake_key_reuse_activation.STAKE_KEY_REUSE_ACTIVATION'"
    let body = null

    before(function () {
        const miss = (why) => {
            if (REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + why)
            this.skip()
        }
        if (!fs.existsSync(PROTOCOL_CHANGES_DIR)) return miss(PROTOCOL_CHANGES_DIR + ' is absent')
        // Find the row in whichever part file carries it, so a file split does not skip the check.
        const src = fs.readdirSync(PROTOCOL_CHANGES_DIR).filter(f => f.endsWith('.js'))
            .map(f => fs.readFileSync(path.join(PROTOCOL_CHANGES_DIR, f), 'utf8'))
            .find(s => s.includes(ROW))
        if (!src) return miss('no ' + ROW + ", ...) row was found under " + PROTOCOL_CHANGES_DIR)
        const start = src.indexOf('{', src.indexOf(ROW))
        body = src.slice(start + 1, src.indexOf('}', start))
    })

    // Read the literals from the source text: requiring the registry would resolve it,
    // and a mismatch there is exactly what this test exists to catch.
    function indexerRow() {
        const row = {}
        for (const line of body.split('\n')) {
            const m = /^\s*'?([A-Za-z]+(?::[a-z]+)?)'?\s*:\s*(null|\d+)\s*,?/.exec(line)
            if (m) row[m[1]] = m[2] === 'null' ? null : parseInt(m[2], 10)
        }
        return row
    }

    it('carries every key and height the indexer row carries, and nothing else', () => {
        const row = indexerRow()
        expect(Object.keys(row), 'parsed no keys from the indexer row').to.have.length.above(0)
        expect(row).to.deep.equal({ ...STAKE_KEY_REUSE_ACTIVATION })
    })
})
