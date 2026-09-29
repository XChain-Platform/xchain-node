'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    INDEXER_DB,
    XChainService,
    callGate,
    expect,
    installEnvironmentHooks,
    loadGate,
    makeRunner,
    refusal
} = require('./support/bootstrap_health_gate')

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('durable halt markers', function () {

        it('gating a decoder queries no second database', async function () {
            const gate = loadGate()
            const runner = makeRunner()
            await callGate(gate, { runner })
            const sqls = runner.getCalls().map(c => (c.args[1] || []).join(' '))
            expect(sqls.some(s => s.includes(INDEXER_DB))).to.equal(false)
        })

        it('does not run marker queries for the utxo-tracker (LevelDB, no such table)', async function () {
            const gate = loadGate()
            const runner = makeRunner({ status: { status: 'ok', lag: 0 } })
            await callGate(gate, { module: XChainService.XCHAIN_UTXO_TRACKER, runner })
            const sqls = runner.getCalls().map(c => (c.args[1] || []).join(' '))
            expect(sqls.some(s => /FROM `[^`]+`\.events/.test(s))).to.equal(false)
        })

        // xchain-sync provisions and writes sync_halt in an indexer replica's own
        // database, so the gate's own-database probe is live for an indexer, not dead code.
        it('REFUSES an indexer whose OWN database carries an uncleared sync halt', async function () {
            const gate = loadGate()
            const runner = makeRunner({
                status:  { status: 'healthy', lag: 0, decoderReorgHalted: false },
                syncHaltRows: '1',
                decoder: { syncHaltRows: '0' }
            })
            const err = await refusal(callGate(gate, { module: XChainService.XCHAIN_INDEXER, runner }))
            expect(err.message).to.match(/the database carries an uncleared xchain-sync divergence halt/)
            expect(err.message).to.not.match(/paired decoder database[\s\S]*sync_halt/)
        })
    })
})
