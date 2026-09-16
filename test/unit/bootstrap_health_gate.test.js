'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

//  leg 2: the bootstrap publisher must refuse an unhealthy source.
//
// The publisher dumped whatever state the service was in, and because a published
// archive is the NEWEST file in the served directory it becomes the default choice
// for every restore path (`bootstrap restore --latest` selects it by construction).
// That is how a litecoin/mainnet decoder archive containing a live REORG_HALT row
// became the fleet's newest "good" decoder bootstrap. These tests pin the refusals.


const {
    DECODER_DB,
    INDEXER_DB,
    XChainService,
    callGate,
    expect,
    installEnvironmentHooks,
    loadGate,
    makeRunner,
    refusal,
    sinon
} = require('./bootstrap_health_gate.test/support/bootstrap_health_gate')
describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    it('XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE=1 bypasses the gate (loudly)', async function () {
        process.env.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE = '1'
        const gate = loadGate()
        const warn = sinon.stub(console, 'log')
        try {
            const res = await callGate(gate, { runner: makeRunner({ reorgHaltRows: '1' }) })
            expect(res.skipped).to.equal(true)
            expect(warn.getCalls().map(c => String(c.args[0])).join(' ')).to.match(/WITHOUT verifying/)
        } finally {
            warn.restore()
        }
    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('durable halt markers', function () {

        it('REFUSES a decoder whose database carries a REORG_HALT row', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ reorgHaltRows: '1' }) }))
            expect(err.name).to.equal('BootstrapSourceUnhealthyError')
            expect(err.message).to.match(/REORG_HALT/)
            expect(err.message).to.match(/full resync from a known-good snapshot/)
            // The message must name the artifact hazard, not just the symptom.
            expect(err.message).to.match(/publishing an unverified one is worse than publishing nothing/)
        })

        it('REFUSES a database carrying an uncleared xchain-sync divergence halt', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ syncHaltRows: '3' }) }))
            expect(err.message).to.match(/sync_halt with cleared_at IS NULL/)
        })

        it('passes a decoder with no marker rows', async function () {
            const gate = loadGate()
            const res = await callGate(gate, { runner: makeRunner() })
            expect(res.skipped).to.equal(false)
        })

    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('durable halt markers', function () {

        it('skips the sync_halt query on a schema that has no sync_halt table', async function () {
            const gate = loadGate()
            const runner = makeRunner({ tables: '1\t0' })
            await callGate(gate, { runner })
            const sqls = runner.getCalls().map(c => (c.args[1] || []).join(' '))
            expect(sqls.some(s => /FROM `[^`]+`\.sync_halt/.test(s))).to.equal(false)
        })

        // The header contract says a probe that cannot be PARSED is a refusal too,
        // not only one that throws. Each of these parses to NaN, loses every
        // `> 0` comparison, and reads as "healthy, no halt markers" without it.
        it('REFUSES when the marker-table probe returns nothing (unreadable, not clean)', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ tables: '' }) }))
            expect(err.message).to.match(/marker-table probe[\s\S]*returned unreadable output/)
        })

        it('REFUSES when the marker-table probe returns non-numeric output', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ tables: 'x\ty' }) }))
            expect(err.message).to.match(/marker-table probe[\s\S]*returned unreadable output/)
        })

        // PARTIAL tokens are the shape parseInt hides: it reads a prefix and drops
        // the rest, so '0garbage' would arrive as a clean 0. A 0 there reads as
        // "no marker table" and SKIPS the sync_halt probe, so an unreadable answer
        // must be refused rather than buy itself a pass on the very next check.
        it('REFUSES when a marker-table token is a partial number, and does not skip sync_halt', async function () {
            const gate = loadGate()
            const runner = makeRunner({ tables: '1\t0garbage' })
            const err = await refusal(callGate(gate, { runner }))
            expect(err.message).to.match(/marker-table probe[\s\S]*returned unreadable output/)
            const sqls = runner.getCalls().map(c => (c.args[1] || []).join(' '))
            expect(sqls.some(s => /FROM `[^`]+`\.sync_halt/.test(s))).to.equal(false)
            expect(sqls.some(s => /FROM `[^`]+`\.events/.test(s))).to.equal(false)
        })

        // TABLE_SCHEMA + TABLE_NAME is unique in information_schema.TABLES, so a
        // table-existence count above 1 is not an answer to the question asked.
        it('REFUSES a marker-table count outside 0..1', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ tables: '1\t2' }) }))
            expect(err.message).to.match(/marker-table probe[\s\S]*returned unreadable output/)
        })

        it('REFUSES when the marker-table probe returns the wrong number of tokens', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ tables: '1' }) }))
            expect(err.message).to.match(/marker-table probe[\s\S]*returned unreadable output/)
        })

    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('durable halt markers', function () {

        // A COUNT(*) is never negative and never has a suffix. Both survive
        // parseInt + Number.isFinite and then lose the `> 0` test, so an unreadable
        // marker count is refused, never certified as carrying no halt marker.
        it('REFUSES a REORG_HALT count that is a partial number', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ reorgHaltRows: '0garbage' }) }))
            expect(err.message).to.match(/REORG_HALT marker probe returned unreadable output/)
        })

        it('REFUSES a negative REORG_HALT count', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ reorgHaltRows: '-1' }) }))
            expect(err.message).to.match(/REORG_HALT marker probe returned unreadable output/)
        })

        it('REFUSES a sync_halt count that is a partial number', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ syncHaltRows: '2 rows' }) }))
            expect(err.message).to.match(/sync_halt marker probe returned unreadable output/)
        })

        // A decoder/indexer always provisions `events`; a probe that cannot see it
        // is not looking at the database that is about to be dumped.
        it('REFUSES a MariaDB source whose schema reports no events table', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ tables: '0\t1' }) }))
            expect(err.message).to.match(/reports no events table/)
        })

        it('REFUSES when the REORG_HALT count itself is unreadable', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ reorgHaltRows: '' }) }))
            expect(err.message).to.match(/REORG_HALT marker probe returned unreadable output/)
        })

        it('REFUSES when the sync_halt count itself is unreadable', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ syncHaltRows: 'nope' }) }))
            expect(err.message).to.match(/sync_halt marker probe returned unreadable output/)
        })

    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('durable halt markers', function () {

        // External-DB mode reads the markers over the native driver rather than
        // docker exec. An empty answer there (the shape a mis-parsed client option
        // string produced) must refuse, not certify the archive.
        it('REFUSES in external-DB mode when the native probe answers with nothing', async function () {
            const gate = loadGate({ external: true, nativeResolves: '' })
            const err = await refusal(callGate(gate, { runner: makeRunner() }))
            expect(err.message).to.match(/could not read the halt markers/)
            expect(err.message).to.match(/returned unreadable output/)
        })

        it('REFUSES when the marker query itself fails (fail closed, never assume clean)', async function () {
            const gate = loadGate()
            const err = await refusal(callGate(gate, { runner: makeRunner({ sqlThrows: new Error('access denied') }) }))
            expect(err.message).to.match(/could not read the halt markers/)
        })

        // An indexer's own events table only ever carries code='REORG'; the REORG_HALT
        // row lives solely in the paired decoder database. Probing only the gated
        // module's own database therefore asked a question that could not come back
        // yes, and the gate's one image-independent backstop had no reach at all here.
        it('REFUSES an indexer whose PAIRED DECODER database carries a REORG_HALT row', async function () {
            const gate = loadGate()
            const runner = makeRunner({
                status:  { status: 'healthy', lag: 0, decoderReorgHalted: false },
                decoder: { reorgHaltRows: '1' }
            })
            const err = await refusal(callGate(gate, { module: XChainService.XCHAIN_INDEXER, runner }))
            expect(err.message).to.match(new RegExp(`paired decoder database ${DECODER_DB} carries a durable REORG_HALT`))
            expect(err.message).to.match(/frozen behind a decoder that aborted mid-rollback/)
        })

        it('REFUSES an indexer whose paired decoder database carries an uncleared sync halt', async function () {
            const gate = loadGate()
            const runner = makeRunner({
                status:  { status: 'healthy', lag: 0, decoderReorgHalted: false },
                decoder: { syncHaltRows: '2' }
            })
            const err = await refusal(callGate(gate, { module: XChainService.XCHAIN_INDEXER, runner }))
            expect(err.message).to.match(/paired decoder database[\s\S]*uncleared[\s\S]*sync_halt/)
        })

    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('durable halt markers', function () {

        // Fail closed on the UPSTREAM probe too: "the decoder database is not there"
        // must not arrive as "the decoder has no halt marker".
        it('REFUSES an indexer when the paired decoder database is absent', async function () {
            const gate = loadGate()
            const runner = makeRunner({
                status:  { status: 'healthy', lag: 0, decoderReorgHalted: false },
                decoder: { tables: '0\t0' }
            })
            const err = await refusal(callGate(gate, { module: XChainService.XCHAIN_INDEXER, runner }))
            expect(err.message).to.match(/paired decoder database[\s\S]*could not be probed/)
            expect(err.message).to.match(/reports no events table/)
        })

        it('REFUSES an indexer when the paired decoder probe throws', async function () {
            const gate = loadGate()
            const runner = makeRunner({
                status:  { status: 'healthy', lag: 0, decoderReorgHalted: false },
                decoder: { throws: new Error('access denied') }
            })
            const err = await refusal(callGate(gate, { module: XChainService.XCHAIN_INDEXER, runner }))
            expect(err.message).to.match(/paired decoder database[\s\S]*could not be probed[\s\S]*access denied/)
        })

        it('passes an indexer when BOTH its own and the decoder database are clean', async function () {
            const gate = loadGate()
            const runner = makeRunner({ status: { status: 'healthy', lag: 0, decoderReorgHalted: false } })
            const res = await callGate(gate, { module: XChainService.XCHAIN_INDEXER, runner })
            expect(res.skipped).to.equal(false)
            const sqls = runner.getCalls().map(c => (c.args[1] || []).join(' '))
            expect(sqls.some(s => s.includes(INDEXER_DB))).to.equal(true)
            expect(sqls.some(s => s.includes(DECODER_DB))).to.equal(true)
        })

    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('durable halt markers', function () {

        // The dump is taken with --single-transaction, so the archive IS the snapshot
        // at the moment mariadb-dump started. Both gate readings look at LIVE rows, so
        // a halt raised after the pre-flight reading and cleared before the post-dump
        // one is captured in the bytes that ship while both readings report clean.
        // The marker tables are append-only and id-ordered, so a MAX(id) taken at the
        // pre-flight reading bounds the window and makes that halt answerable.
        describe('dump-window watermark', function () {

            it('hands the caller a watermark for both marker tables', async function () {
                const gate = loadGate()
                const res = await callGate(gate, { runner: makeRunner({ eventsWatermark: '412', syncHaltWatermark: '7' }) })
                expect(res.watermark.own).to.deep.equal({ events: 412, syncHalt: 7 })
                expect(res.watermark.upstream).to.equal(null)
            })

            it('reports a null sync_halt watermark when the table does not exist', async function () {
                const gate = loadGate()
                const res = await callGate(gate, { runner: makeRunner({ tables: '1\t0', eventsWatermark: '9' }) })
                expect(res.watermark.own).to.deep.equal({ events: 9, syncHalt: null })
            })

            it('passes when nothing was raised inside the window', async function () {
                const gate = loadGate()
                const res = await callGate(gate, {
                    runner: makeRunner(), since: { own: { events: 100, syncHalt: 50 }, upstream: null }
                })
                expect(res.skipped).to.equal(false)
            })

        })
    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('durable halt markers', function () {

        describe('dump-window watermark', function () {

            // The reported race: live counts are clean at BOTH readings, because the
            // halt was cleared before the second one, yet a REORG_HALT row sits above
            // the pre-flight watermark.
            it('REFUSES a halt raised and cleared while the dump was streaming', async function () {
                const gate = loadGate()
                const runner = makeRunner({ reorgHaltRows: '0', syncHaltRows: '0', reorgHaltWindowRows: '1' })
                const err = await refusal(callGate(gate, {
                    runner, since: { own: { events: 100, syncHalt: 50 }, upstream: null }
                }))
                expect(err.name).to.equal('BootstrapSourceUnhealthyError')
                expect(err.message).to.match(/raised while the dump was streaming/)
                expect(err.message).to.match(/Re-run the publish/)
            })

            it('REFUSES a sync_halt raised inside the window even though it is cleared now', async function () {
                const gate = loadGate()
                const err = await refusal(callGate(gate, {
                    runner: makeRunner({ syncHaltRows: '0', syncHaltWindowRows: '2' }),
                    since:  { own: { events: 100, syncHalt: 50 }, upstream: null }
                }))
                expect(err.message).to.match(/divergence halt .* was raised while the dump was streaming/)
            })

        })
    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('durable halt markers', function () {

        describe('dump-window watermark', function () {

            // A sequence that went backwards means the table was recreated or a
            // different database was probed, so the window cannot be read at all.
            // "Could not tell" is a refusal here, as everywhere else in this gate.
            it('REFUSES when the id sequence went backwards', async function () {
                const gate = loadGate()
                const err = await refusal(callGate(gate, {
                    runner: makeRunner({ eventsWatermark: '5' }),
                    since:  { own: { events: 100, syncHalt: 50 }, upstream: null }
                }))
                expect(err.message).to.match(/could not tell whether a halt was raised/)
                expect(err.message).to.match(/\.events id sequence/)
            })

            it('REFUSES an unusable watermark rather than trusting it', async function () {
                const gate = loadGate()
                for (const bad of ['100', 1.5, -1]) {
                    const err = await refusal(callGate(gate, {
                        runner: makeRunner(), since: { own: { events: bad, syncHalt: 50 }, upstream: null }
                    }))
                    expect(err.message, JSON.stringify(bad)).to.match(/refusing an unusable .* watermark/)
                }
            })

            // The indexer case: the disqualifying REORG_HALT lives in the PAIRED
            // decoder database, so the window check has to reach it too.
            it('REFUSES a halt raised inside the window in the paired decoder database', async function () {
                const gate = loadGate()
                const err = await refusal(callGate(gate, {
                    module: XChainService.XCHAIN_INDEXER,
                    runner: makeRunner({ decoder: { reorgHaltWindowRows: '1' } }),
                    since:  { own: { events: 100, syncHalt: 50 }, upstream: { events: 100, syncHalt: 50 } }
                }))
                expect(err.message).to.match(/raised while the dump was streaming/)
            })
        })

    })
})