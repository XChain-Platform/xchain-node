'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')
const {
    isValidRollbackGuardState,
    parseRollbackGuardRows
} = require('../../../src/services/bootstrap_health_gate/halt_markers')

const encoded = value => 'V' + Buffer.from(value, 'utf8').toString('hex').toUpperCase()

describe('rollback guard marker parser', function () {
    it('matches xchain-sync valid rollback streaks', function () {
        expect(isValidRollbackGuardState('{"peak":5,"low":3}')).to.equal(true)
        expect(isValidRollbackGuardState('{"peak":0,"low":0}')).to.equal(true)
    })

    it('rejects every incoherent or unreadable rollback streak shape', function () {
        const invalid = [
            '{"peak":3,"low":5}', '{"peak":-1,"low":0}', '{"peak":1.5,"low":0}',
            '{"peak":"5","low":3}', '{"low":0}', 'null', '5', '[]', '', ' ', 'not json'
        ]
        for (const value of invalid)
            expect(isValidRollbackGuardState(value), JSON.stringify(value)).to.equal(false)
    })

    it('counts invalid values while accepting valid and NULL rows', function () {
        const raw = '3\t' + encoded('{"peak":5,"low":3}') + ',N,' + encoded('not json')
        expect(parseRollbackGuardRows(raw, 'rollback guard probe')).to.equal(1)
    })

    it('refuses count mismatches, malformed tokens and wrong field counts', function () {
        for (const raw of ['2\t' + encoded('{"peak":1,"low":0}'), '1\tV0G', '0', '0\t\textra'])
            expect(() => parseRollbackGuardRows(raw, 'rollback guard probe'), raw)
                .to.throw(/returned unreadable output/)
    })
})
