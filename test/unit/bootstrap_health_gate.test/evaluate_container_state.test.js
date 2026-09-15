'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    expect,
    installEnvironmentHooks,
    loadGate,
} = require('./support/bootstrap_health_gate')

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('evaluateContainerState()', function () {

        it('treats unreadable inspect output as a refusal', function () {
            const gate = loadGate()
            expect(gate.evaluateContainerState('')).to.have.lengthOf(1)
        })

        it('accepts a stable running container with no healthcheck', function () {
            const gate = loadGate()
            expect(gate.evaluateContainerState('running|false|0|2026-01-01T00:00:00.000Z|none',
                { now: Date.parse('2026-07-27T00:00:00.000Z') })).to.deep.equal([])
        })
    })
})
