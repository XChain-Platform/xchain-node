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

describe('BootstrapHealthGate rollback guard markers', function () {

    installEnvironmentHooks()

    const encoded = value => 'V' + Buffer.from(value, 'utf8').toString('hex').toUpperCase()

    it('REFUSES an invalid rollback guard row in the gated database', async function () {
        const gate = loadGate()
        const runner = makeRunner({ rollbackGuardRows: '1\t' + encoded('{"peak":1,"low":2}') })
        const err = await refusal(callGate(gate, { runner }))
        expect(err.message).to.match(/database carries an invalid xchain-sync rollback_guard row/)
    })

    it('REFUSES an invalid rollback guard row in the paired decoder database', async function () {
        const gate = loadGate()
        const runner = makeRunner({
            decoder: { rollbackGuardRows: '1\t' + encoded('not json') }
        })
        const err = await refusal(callGate(gate, { module: XChainService.XCHAIN_INDEXER, runner }))
        expect(err.message).to.match(/paired decoder database \S+ carries an invalid xchain-sync rollback_guard row/)
    })

    it('accepts valid and NULL rollback guard rows', async function () {
        const gate = loadGate()
        await callGate(gate, { runner: makeRunner({
            rollbackGuardRows: '2\t' + encoded('{"peak":5,"low":3}') + ',N'
        }) })
    })

    it('REFUSES unreadable rollback guard probe output', async function () {
        const gate = loadGate()
        const err = await refusal(callGate(gate, {
            runner: makeRunner({ rollbackGuardRows: '2\t' + encoded('{"peak":5,"low":3}') })
        }))
        expect(err.message).to.match(/rollback_guard probe[\s\S]*returned unreadable output/)
    })

    it('does not probe rollback guards when sync_state is absent', async function () {
        const gate = loadGate()
        const runner = makeRunner({ tables: '1\t1\t0', rollbackGuardRows: 'broken' })
        await callGate(gate, { runner })
        const sqls = runner.getCalls().map(c => (c.args[1] || []).join(' '))
        expect(sqls.some(sql => /rollback_guard/.test(sql))).to.equal(false)
    })
})

// xchain-sync parks a halt in sync_state when its sync_halt write fails, and
// restorePendingHalt re-installs it on any replica that restores the archive.
describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('durable halt markers', function () {

        it('REFUSES a database whose sync_state carries a halt_pending copy', async function () {
            const gate = loadGate()
            const runner = makeRunner({ pendingSyncHaltRows: '1' })
            const err = await refusal(callGate(gate, { runner }))
            expect(err.message).to.match(/the database carries an xchain-sync halt_pending copy in sync_state/)
        })

        it('REFUSES an indexer whose paired decoder database carries a halt_pending copy', async function () {
            const gate = loadGate()
            const runner = makeRunner({
                status:  { status: 'healthy', lag: 0, decoderReorgHalted: false },
                decoder: { pendingSyncHaltRows: '1' }
            })
            const err = await refusal(callGate(gate, { module: XChainService.XCHAIN_INDEXER, runner }))
            expect(err.message).to.match(/paired decoder database \S+ carries an xchain-sync halt_pending copy/)
        })

        it('REFUSES an unreadable halt_pending count', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ pendingSyncHaltRows: '1 row' }) }))
            expect(err.message).to.match(/sync_state halt_pending marker probe returned unreadable output/)
        })

        it('skips the sync_state query on a schema that has no sync_state table', async function () {
            const gate = loadGate()
            const runner = makeRunner({ tables: '1\t1\t0', pendingSyncHaltRows: '1' })
            await callGate(gate, { runner })
            const sqls = runner.getCalls().map(c => (c.args[1] || []).join(' '))
            expect(sqls.some(s => /FROM `[^`]+`\.sync_state/.test(s))).to.equal(false)
        })

        it('REFUSES a marker-table probe that still answers with two tokens', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ tables: '1\t1' }) }))
            expect(err.message).to.match(/marker-table probe[\s\S]*returned unreadable output/)
        })
    })
})

// The decoder reads a newest REORG_HALT_CLEARED row without an audited reason as a live
// halt, so the gate judges that row's bytes with the decoder's own rule.
describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    const hexOf = (text) => Buffer.from(text, 'utf8').toString('hex').toUpperCase()

    describe('durable halt markers: the newest clear row', function () {

        it('passes a newest clear row whose reason clear-reorg-halt would accept', async function () {
            const gate = loadGate()
            const runner = makeRunner({ newestClear: '1\t' + hexOf('{"reason":"range re-parsed and verified"}') })
            await callGate(gate, { runner })
        })

        it('REFUSES a newest clear row whose reason is short', async function () {
            const gate = loadGate()
            const runner = makeRunner({ newestClear: '1\t' + hexOf('{"reason":"oops"}') })
            const err = await refusal(callGate(gate, { runner }))
            expect(err.message).to.match(/newest REORG_HALT_CLEARED row with no audited reason/)
        })

        it('REFUSES a newest clear row with no payload at all', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ newestClear: '1\tNULL' }) }))
            expect(err.message).to.match(/durable REORG_HALT marker/)
        })

        it('REFUSES an indexer whose paired decoder database has an unaudited newest clear row', async function () {
            const gate = loadGate()
            const runner = makeRunner({
                status:  { status: 'healthy', lag: 0, decoderReorgHalted: false },
                decoder: { newestClear: '1\t' + hexOf('{"reason":"x"}') }
            })
            const err = await refusal(callGate(gate, { module: XChainService.XCHAIN_INDEXER, runner }))
            expect(err.message).to.match(/paired decoder database \S+ carries a durable REORG_HALT/)
        })

        it('REFUSES unreadable clear-probe output', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ newestClear: '0' }) }))
            expect(err.message).to.match(/REORG_HALT_CLEARED audit probe[\s\S]*returned unreadable output/)
        })
    })
})
