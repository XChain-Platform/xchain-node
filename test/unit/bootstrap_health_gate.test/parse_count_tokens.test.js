'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, loadGate } = require('./support/bootstrap_health_gate')

// The parser the marker probes share. Pinned directly as well as through the
// gate: under a bare parseInt every one of these strings reads as a healthy number.
describe('parseCountTokens()', function () {

    const parse = (raw, opts) => loadGate().parseCountTokens(raw, opts)

    it('accepts whole nonnegative integers', function () {
        expect(parse('0',  { expected: 1, what: 'p' })).to.deep.equal([0])
        expect(parse('42\n', { expected: 1, what: 'p' })).to.deep.equal([42])
        expect(parse('1\t0', { expected: 2, max: 1, what: 'p' })).to.deep.equal([1, 0])
    })

    it('refuses partial tokens, signs, decimals and exponents', function () {
        for (const raw of ['0garbage', '-1', '1.5', '1e3', 'NaN', '+1', '0x1']) {
            expect(() => parse(raw, { expected: 1, what: 'p' }), raw)
                .to.throw(/returned unreadable output/)
        }
    })

    it('refuses empty and whitespace-only output', function () {
        expect(() => parse('',    { expected: 1, what: 'p' })).to.throw(/unreadable output/)
        expect(() => parse('   ', { expected: 1, what: 'p' })).to.throw(/unreadable output/)
        expect(() => parse(null,  { expected: 1, what: 'p' })).to.throw(/unreadable output/)
    })

    it('refuses the wrong token count in either direction', function () {
        expect(() => parse('1 2', { expected: 1, what: 'p' })).to.throw(/unreadable output/)
        expect(() => parse('2',   { expected: 2, what: 'p' })).to.throw(/unreadable output/)
    })

    it('refuses a value above max when one is given, and ignores max when it is not', function () {
        expect(() => parse('2', { expected: 1, max: 1, what: 'p' })).to.throw(/unreadable output/)
        expect(parse('2', { expected: 1, what: 'p' })).to.deep.equal([2])
    })

    it('quotes the offending output in the refusal so the operator can see it', function () {
        expect(() => parse('0garbage', { expected: 1, what: 'REORG_HALT marker probe' }))
            .to.throw(/the REORG_HALT marker probe returned unreadable output: "0garbage"/)
    })
})
