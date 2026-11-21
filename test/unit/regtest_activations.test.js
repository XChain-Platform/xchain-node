'use strict'

const { expect } = require('chai')
const { parseRegtestActivations } = require('../../src/utils/regtest_activations')

describe('regtest activation input', function () {
    it('accepts space-separated activation heights', function () {
        expect(parseRegtestActivations(
            'XC_EXECUTE_NATIVE_METERED_GAS_REGTEST_ACTIVATION=1 XC_FUTURE_GATE_REGTEST_ACTIVATION=0'
        )).to.deep.equal([
            ['XC_EXECUTE_NATIVE_METERED_GAS_REGTEST_ACTIVATION', '1'],
            ['XC_FUTURE_GATE_REGTEST_ACTIVATION', '0']
        ])
    })

    it('refuses a key outside the regtest activation namespace', function () {
        expect(() => parseRegtestActivations('XC_EXECUTE_NATIVE_METERED_GAS_ACTIVATION=1'))
            .to.throw('invalid regtest activation key')
    })

    it('refuses a value that is not a non-negative integer', function () {
        expect(() => parseRegtestActivations('XC_EXECUTE_NATIVE_METERED_GAS_REGTEST_ACTIVATION=-1'))
            .to.throw('expected a non-negative integer')
    })

    it('treats empty input as a no-op', function () {
        expect(parseRegtestActivations('')).to.deep.equal([])
        expect(parseRegtestActivations('   ')).to.deep.equal([])
    })
})
