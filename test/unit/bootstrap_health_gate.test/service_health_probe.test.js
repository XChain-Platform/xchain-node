'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    XChainService,
    callGate,
    expect,
    healthyInspect,
    installEnvironmentHooks,
    loadGate,
    makeRunner,
    refusal,
    sinon
} = require('./support/bootstrap_health_gate')

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('service health probe', function () {

        it('REFUSES a decoder reporting its own latent REORG_HALT marker', async function () {
            const gate = loadGate()
            const status = { status: 'healthy', lag_blocks: 0, reorg_halted: true, reorg_halt_reason: 'over-deep rollback' }
            const err = await refusal(callGate(gate, { runner: makeRunner({ status }) }))
            expect(err.message).to.match(/durable REORG_HALT marker: over-deep rollback/)
        })

        it('REFUSES a service reporting unhealthy', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ status: { status: 'unhealthy', lag_blocks: 0 } }) }))
            expect(err.message).to.match(/reports status "unhealthy"/)
        })

        it('REFUSES a halted utxo-tracker', async function () {
            const gate = loadGate()
            const status = { status: 'halted', halted: true, halt_reason: 'unrecoverable reorg' }
            const err = await refusal(callGate(gate, { module: XChainService.XCHAIN_UTXO_TRACKER, runner: makeRunner({ status }) }))
            expect(err.message).to.match(/HALTED: unrecoverable reorg/)
        })

        it('REFUSES a service materially behind its tip', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ status: { status: 'healthy', lag_blocks: 5000 } }) }))
            expect(err.message).to.match(/5000 blocks behind/)
        })

        it('honours XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS', async function () {
            process.env.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS = '10000'
            const gate = loadGate()
            const res = await callGate(gate, { runner: makeRunner({ status: { status: 'healthy', lag_blocks: 5000 } }) })
            expect(res.skipped).to.equal(false)
        })

        it('REFUSES when the service cannot say how far behind it is', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ status: { status: 'healthy', lag_blocks: null } }) }))
            expect(err.message).to.match(/cannot report how far behind it is/)
        })

    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('service health probe', function () {

        it('REFUSES when the health probe cannot be run at all', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ statusThrows: new Error('exec failed') }) }))
            expect(err.message).to.match(/health probe failed/)
        })

        it('falls back to GET /status when the JSON-RPC route is unavailable', async function () {
            const gate = loadGate()
            const runner = sinon.stub().callsFake(async (cmd, args) => {
                if (args[0] === 'inspect') return { stdout: healthyInspect() }
                if (args.includes('wget')) {
                    const isRpc = args.some(a => String(a).startsWith('--post-data='))
                    if (isRpc) return { stdout: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'Method not found' } }) }
                    return { stdout: JSON.stringify({ status: 'healthy', db: true, running: true, lag_blocks: 2 }) }
                }
                // lastIndexOf, as in makeRunner: the docker invocation carries its
                // own `-e MYSQL_PWD` ahead of the client's `-e <sql>`. indexOf reads
                // MYSQL_PWD as the statement, which makes this fake answer the
                // marker probe with '0' and leaves the marker path unexercised.
                const sql = args[args.lastIndexOf('-e') + 1] || ''
                if (/information_schema\.TABLES/.test(sql)) return { stdout: '1\t1' }
                return { stdout: '0' }
            })
            const res = await callGate(gate, { runner })
            expect(res.skipped).to.equal(false)
        })

        it('reports EVERY reason, not just the first', async function () {
            const gate = loadGate()
            const runner = makeRunner({
                inspect: 'running|false|0|2026-01-01T00:00:00.000Z|unhealthy',
                status:  { status: 'unhealthy', lag_blocks: 900 },
                reorgHaltRows: '1'
            })
            const err = await refusal(callGate(gate, { runner }))
            expect(err.reasons.length).to.be.at.least(4)
        })
    })
})
