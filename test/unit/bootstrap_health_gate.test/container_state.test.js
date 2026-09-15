'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    XChainService,
    callGate,
    expect,
    installEnvironmentHooks,
    loadGate,
    makeRunner,
    refusal,
    sinon
} = require('./support/bootstrap_health_gate')

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('container state', function () {

        it('REFUSES when no container is registered', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner(), container: null }))
            expect(err.message).to.match(/no xchain-decoder container is registered/)
        })

        it('REFUSES a stopped container', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ inspect: 'exited|false|4|2026-01-01T00:00:00.000Z|none' }) }))
            expect(err.message).to.match(/not running \(state: exited\)/)
        })

        it('REFUSES a restarting (crash-looping) container', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ inspect: 'running|true|9|2026-07-27T00:00:00.000Z|starting' }) }))
            expect(err.message).to.match(/restarting \(crash loop\)/)
        })

        it('REFUSES a container that restarted moments ago', async function () {
            const gate = loadGate()
            const inspect = 'running|false|7|2026-07-26T23:59:00.000Z|healthy'
            const err = await refusal(callGate(gate, { runner: makeRunner({ inspect }) }))
            expect(err.message).to.match(/restarted 7 time\(s\)/)
        })

        it('accepts a container that restarted long ago and has been stable since', async function () {
            const gate = loadGate()
            const inspect = 'running|false|7|2026-01-01T00:00:00.000Z|healthy'
            const res = await callGate(gate, { runner: makeRunner({ inspect }) })
            expect(res.skipped).to.equal(false)
        })

    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('container state', function () {

        it('REFUSES when docker reports the healthcheck unhealthy', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ inspect: 'running|false|0|2026-01-01T00:00:00.000Z|unhealthy' }) }))
            expect(err.message).to.match(/HEALTHCHECK as unhealthy/)
        })

        it('REFUSES when docker inspect cannot be run', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ inspectThrows: new Error('no such object') }) }))
            expect(err.message).to.match(/could not inspect/)
        })

        // Every test above mocks the runner, so none of them can see a template that
        // docker itself rejects. `{{.State.RestartCount}}` is such a template: State
        // exposes Status/Running/Restarting/StartedAt/Health, and RestartCount is a
        // TOP-LEVEL sibling, so docker exits 1 with "map has no entry for key" and the
        // gate lands in the catch above, refusing publication from a healthy source.
        // Asserting the format string is the only way a mocked suite catches that.
        it('reads RestartCount from the top level, not from .State (docker rejects the latter)', async function () {
            const gate = loadGate()
            const runner = makeRunner()
            await callGate(gate, { runner })

            const inspectCall = runner.getCalls().find(c => (c.args[1] || [])[0] === 'inspect')
            const format = inspectCall.args[1][inspectCall.args[1].indexOf('--format') + 1]
            expect(format).to.contain('{{.RestartCount}}')
            expect(format).to.not.contain('.State.RestartCount')
        })
    })
})
