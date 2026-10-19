'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    expect,
    installEnvironmentHooks,
    loadGate,
} = require('./support/bootstrap_health_gate')

describe('BootstrapHealthGate: train_activation_halt stall class', function () {

    installEnvironmentHooks()

    const stallReason = 'train_activation_halt: rule set 3 required at 900'
    const payload = (trainActivation) => Object.assign({
        status: 'healthy',
        lag: 3,
        degraded: true,
        stallClass: 'train_activation_halt',
        stallReason
    }, trainActivation === undefined ? {} : { train_activation: trainActivation })

    it('does not refuse the stall class by itself', function () {
        const { evaluateStatusPayload } = loadGate()
        const cases = [
            ['absent', undefined],
            ['pending', { status: 'pending' }],
            ['unevaluated', { status: 'unevaluated' }]
        ]

        for (const [label, trainActivation] of cases)
            expect(evaluateStatusPayload(payload(trainActivation)), label).to.deep.equal([])
    })

    it('refuses a halt exactly once through the train-activation leg', function () {
        const { evaluateStatusPayload } = loadGate()
        const reasons = evaluateStatusPayload(payload({
            status: 'halt',
            required_rule_set: '3',
            required_at_height: 900
        }))

        expect(reasons).to.have.lengthOf(1)
        expect(reasons[0]).to.match(/train-activation halt/)
        expect(reasons[0]).to.not.match(/WEDGED/)
    })
})
