'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The CLI's read-only mirror of the ROLLCALL arming heights, and its
// agreement with the indexer source it mirrors when that checkout is beside
// this one.

const fs   = require('fs')
const path = require('path')
const { expect } = require('chai')

const {
    ROLLCALL_ARMED_HEIGHT, ROLLCALL_ACCEPT_WINDOW_BLOCKS, ROLLCALL_PROOF_DELAY_BLOCKS,
    resolveRegtestArming, rollcallArmedHeight, describeCloseFormula
} = require('../../../src/services/rollcall_wiring/arming_heights')

describe('ROLLCALL arming mirror', function () {

    it('mainnet arms at genesis, testnet at 151200, regtest only from the venue variable', () => {
        expect(rollcallArmedHeight('mainnet', {})).to.equal(0)
        expect(rollcallArmedHeight('testnet', {})).to.equal(151200)
        expect(rollcallArmedHeight('regtest', {})).to.equal(null)
        expect(rollcallArmedHeight('regtest', { XC_ROLLCALL_REGTEST_ACTIVATION: '90' })).to.equal(90)
        expect(rollcallArmedHeight('nonesuch', {})).to.equal(null)
    })

    it('reads the regtest variable the way the indexer does, garbage included', () => {
        for (const armed of ['armed', 'GENESIS', ' on ', 'true', 'yes']) expect(resolveRegtestArming(armed)).to.equal(0)
        for (const inert of [undefined, null, '', 'off', 'inert', 'false', 'no', 'none', 'soon', '-1']) expect(resolveRegtestArming(inert)).to.equal(null)
        expect(resolveRegtestArming('120')).to.equal(120)
    })

    it('spells the close block the way the wedge is computed', () => {
        expect(describeCloseFormula('testnet')).to.equal('epoch + 144 + 36')
        expect(describeCloseFormula('regtest')).to.equal('epoch + 12 + 2')
        expect(describeCloseFormula('nonesuch')).to.equal(null)
    })
})

// The mirror is a copy of consensus constants the CLI only reads. With the
// sibling indexer checkout present, hold it to the source; a standalone deploy
// skips, and XCHAIN_REQUIRE_SIBLINGS=1 turns the skip into a failure.
describe('ROLLCALL arming mirror agrees with xchain-indexer/src/rollcall_activation.js', function () {
    const INDEXER_DIR      = process.env.XCHAIN_INDEXER_DIR || path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer')
    const SOURCE_FILE      = path.join(INDEXER_DIR, 'src', 'rollcall_activation.js')
    const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'
    let source = null

    before(function () {
        if (!fs.existsSync(SOURCE_FILE)) {
            if (REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + SOURCE_FILE + ' is absent')
            this.skip()
        }
        source = fs.readFileSync(SOURCE_FILE, 'utf8')
    })

    // Read the literals out of the source text rather than requiring the file:
    // it reads process.env at require time and prints on a garbage value.
    const literal = (name, network) => {
        const m = source.match(new RegExp(name + '\\s*=\\s*\\{[^}]*\\b' + network + ':\\s*(\\d+)'))
        return m ? parseInt(m[1], 10) : null
    }

    it('on the arming heights', () => {
        expect(literal('ROLLCALL_ACTIVATION', 'mainnet')).to.equal(ROLLCALL_ARMED_HEIGHT.mainnet)
        expect(literal('ROLLCALL_ACTIVATION', 'testnet')).to.equal(ROLLCALL_ARMED_HEIGHT.testnet)
    })

    it('on the accept window and the proof delay', () => {
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            expect(literal('ROLLCALL_ACCEPT_WINDOW_BLOCKS', network)).to.equal(ROLLCALL_ACCEPT_WINDOW_BLOCKS[network])
            expect(literal('ROLLCALL_PROOF_DELAY_BLOCKS', network)).to.equal(ROLLCALL_PROOF_DELAY_BLOCKS[network])
        }
    })
})
