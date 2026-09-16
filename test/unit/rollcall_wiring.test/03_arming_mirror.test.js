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

// The mirror is a copy of consensus constants the CLI only reads. As of the
// indexer's registry push (2026-09-15) rollcall_activation.js is a shim
// (`copy('rollcall_activation.NAME')`) and the literals live in the SHARED
// gate registry rows spread across xchain-indexer/src/protocol_changes/
// shared_rows*.js, one `addGate('rollcall_activation.NAME', kind, {...})`
// call per constant. With the sibling indexer checkout present, hold this
// mirror to those rows; a standalone deploy skips, and
// XCHAIN_REQUIRE_SIBLINGS=1 turns every miss (absent dir, no shared_rows
// files, or a name no file carries) into a failure instead of a silent
// null-vs-null pass.
describe('ROLLCALL arming mirror agrees with xchain-indexer gate registry rows for rollcall_activation', function () {
    const INDEXER_DIR          = process.env.XCHAIN_INDEXER_DIR || path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer')
    const PROTOCOL_CHANGES_DIR = path.join(INDEXER_DIR, 'src', 'protocol_changes')
    const REQUIRE_SIBLINGS     = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'
    let source = null

    before(function () {
        if (!fs.existsSync(PROTOCOL_CHANGES_DIR)) {
            if (REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + PROTOCOL_CHANGES_DIR + ' is absent')
            this.skip()
            return
        }
        // The rows are spread over several parts (shared_rows.js, shared_rows_1.js,
        // ...); concatenate every part so a literal can live in any of them.
        const parts = fs.readdirSync(PROTOCOL_CHANGES_DIR).filter((f) => /^shared_rows.*\.js$/.test(f))
        if (parts.length === 0) {
            if (REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but no shared_rows*.js files under ' + PROTOCOL_CHANGES_DIR)
            this.skip()
            return
        }
        source = parts.map((f) => fs.readFileSync(path.join(PROTOCOL_CHANGES_DIR, f), 'utf8')).join('\n')
    })

    // Read the literals out of the source text rather than requiring the shim:
    // the registry resolves at require time and a mismatch there is exactly
    // what this test exists to catch, not something to route around.
    const literal = (name, network) => {
        const addGateRe = new RegExp("addGate\\('rollcall_activation\\." + name + "',")
        if (!addGateRe.test(source)) {
            if (REQUIRE_SIBLINGS) throw new Error("XCHAIN_REQUIRE_SIBLINGS=1 but no addGate('rollcall_activation." + name + "', ...) row was found under " + PROTOCOL_CHANGES_DIR)
            return null
        }
        const valueRe = new RegExp("addGate\\('rollcall_activation\\." + name + "',\\s*'[^']*',\\s*\\{[^}]*\\b" + network + ':\\s*(\\d+)')
        const m = source.match(valueRe)
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
