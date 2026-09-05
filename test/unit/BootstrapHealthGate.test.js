'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The bootstrap publisher must refuse an unhealthy source.
//
// The publisher dumped whatever state the service was in, and because a published
// archive is the NEWEST file in the served directory it becomes the default choice
// for every restore path (`bootstrap restore --latest` selects it by construction).
// That is how a litecoin/mainnet decoder archive containing a live REORG_HALT row
// became the fleet's newest "good" decoder bootstrap. These tests pin the refusals.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { XChainService } = require('../../src/config/constants')

const COIN    = 'litecoin'
const NETWORK = 'mainnet'
const SVC_CONTAINER = 'c'.repeat(64)
const DB_CONTAINER  = 'd'.repeat(64)
const DECODER_DB = 'xchain_ltc_mainnet_decoder'
const INDEXER_DB = 'xchain_ltc_mainnet_indexer'

// A container that is up, stable, and passing its healthcheck.
function healthyInspect({ started = '2026-01-01T00:00:00.000Z' } = {}) {
    return `running|false|0|${started}|healthy\n`
}

// The external-DB helper answers per query by default (both marker tables
// present, no marker rows), the same clean-database shape the docker runner
// fakes. A test that wants the "helper answered with nothing" shape - a
// mis-parsed client option, a driver that returned no rows - passes
// nativeResolves: '' and gets that for every call.
function nativeHelperStub(nativeResolves) {
    if (nativeResolves !== null) return sinon.stub().resolves(nativeResolves)
    return sinon.stub().callsFake(async (cfg, sql) =>
        (/information_schema\.TABLES/.test(sql) ? '1\t1' : '0'))
}

function loadGate({ external = false, nativeResolves = null } = {}) {
    return proxyquire('../../src/services/BootstrapHealthGate', {
        '../config/constants': {
            XChainService,
            EXTERNAL_DB: external
        },
        '../state': { db: { getModuleContainer: sinon.stub().resolves(SVC_CONTAINER) } },
        './ConfigService': {
            getDefaultConfig: sinon.stub().resolves({
                DECODER_API_PORT: 3002,
                INDEXER_API_PORT: 3004,
                UTXO_TRACKER_API_PORT: 3001
            }),
            // Module-aware, because gating an indexer must probe TWO databases and a
            // test cannot express "decoder dirty, indexer clean" while both share a name.
            getModuleDatabaseName: sinon.stub().callsFake(m =>
                (m === XChainService.XCHAIN_INDEXER ? INDEXER_DB : DECODER_DB))
        },
        './DatabaseService': {
            getDatabaseContainerId:      sinon.stub().resolves(DB_CONTAINER),
            askMariadbRootPassword:      sinon.stub().resolves('rootpass'),
            getExternalDbConfig:         sinon.stub().resolves({ host: 'h', port: 3306, root_user: 'root', root_password: 'p' }),
            executeNativeMariaDbCommand: nativeHelperStub(nativeResolves)
        },
        '../utils/dockerMariadb': {
            dockerMariadbArgs: (id, args) => ['exec', '-e', 'MYSQL_PWD', id, ...args],
            mariadbEnv:        () => ({})
        }
    })
}

// Build a `runner` (execFileAsync stand-in) driven by a small scenario object,
// so each test states only what it changes.
function makeRunner({
    inspect = healthyInspect(),
    // Models the rich JSON-RPC `health` payload, the first surface probeServiceStatus
    // tries; it publishes reorg_halt_checked_at beside reorg_halted. A null
    // timestamp means no marker probe ever completed, so it is not a "not halted".
    status  = { status: 'healthy', lag_blocks: 0, reorg_halted: false, reorg_halt_checked_at: 1756000000000 },
    tables  = '1\t1',
    reorgHaltRows = '0',
    syncHaltRows  = '0',
    inspectThrows = null,
    statusThrows  = null,
    sqlThrows     = null,
    // Answers for the PAIRED DECODER database an indexer gate probes second. Left
    // null, that database answers exactly as the gated one does; set it to express
    // the scenario the gate exists for and a single-database fake cannot reach:
    // decoder dirty, indexer clean. Accepts { tables, reorgHaltRows, syncHaltRows,
    // throws }.
    decoder       = null
} = {}) {
    return sinon.stub().callsFake(async (cmd, args) => {
        if (args[0] === 'inspect') {
            if (inspectThrows) throw inspectThrows
            return { stdout: inspect }
        }
        // docker exec ... wget (service health probe)
        if (args.includes('wget')) {
            if (statusThrows) throw statusThrows
            return { stdout: JSON.stringify({ jsonrpc: '2.0', id: 1, result: status }) }
        }
        // docker exec ... mariadb -BN -e <sql>. lastIndexOf, because the docker
        // invocation carries its own `-e MYSQL_PWD` ahead of the client's `-e <sql>`.
        const sql = args[args.lastIndexOf('-e') + 1] || ''
        if (sqlThrows) throw sqlThrows
        const up = (decoder && sql.includes(DECODER_DB)) ? decoder : null
        if (up && up.throws) throw up.throws
        const pick = (key, fallback) => (up && up[key] !== undefined) ? up[key] : fallback
        if (/information_schema\.TABLES/.test(sql)) return { stdout: pick('tables', tables) }
        if (/REORG_HALT/.test(sql)) return { stdout: pick('reorgHaltRows', reorgHaltRows) }
        if (/sync_halt/.test(sql)) return { stdout: pick('syncHaltRows', syncHaltRows) }
        return { stdout: '' }
    })
}

function callGate(gate, { module = XChainService.XCHAIN_DECODER, runner, container = SVC_CONTAINER, now } = {}) {
    return gate.assertBootstrapSourceHealthy(COIN, NETWORK, module, {
        runner,
        getModuleContainer: sinon.stub().resolves(container),
        now: now || Date.parse('2026-07-27T00:00:00.000Z')
    })
}

async function refusal(promise) {
    try {
        await promise
    } catch (err) {
        return err
    }
    throw new Error('expected the gate to refuse, but it passed')
}

describe('BootstrapHealthGate', function () {

    let savedSkip, savedMaxLag
    beforeEach(function () {
        savedSkip   = process.env.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE
        savedMaxLag = process.env.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS
        delete process.env.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE
        delete process.env.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS
    })
    afterEach(function () {
        if (savedSkip === undefined) delete process.env.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE
        else process.env.XCHAIN_NODE_BOOTSTRAP_SKIP_HEALTH_GATE = savedSkip
        if (savedMaxLag === undefined) delete process.env.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS
        else process.env.XCHAIN_NODE_BOOTSTRAP_MAX_LAG_BLOCKS = savedMaxLag
    })

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
    })

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

    describe('evaluateStatusPayload()', function () {

        it('treats an empty payload as a refusal, not a pass', function () {
            const gate = loadGate()
            expect(gate.evaluateStatusPayload(null)).to.have.lengthOf(1)
            expect(gate.evaluateStatusPayload('nonsense')).to.have.lengthOf(1)
        })

        it('refuses an indexer frozen behind a halted decoder', function () {
            const gate = loadGate()
            const reasons = gate.evaluateStatusPayload({ status: 'healthy', lag: 0, decoderReorgHalted: true })
            expect(reasons.join(' ')).to.match(/upstream decoder carries a durable REORG_HALT/)
        })

        // The decoder's marker probe is fail-soft: a DB fault keeps the last known
        // state, which starts at false with checked_at null. So "never managed to
        // look" and "looked, clean" publish the identical boolean, and only the
        // timestamp tells them apart.
        it('REFUSES a decoder that reports not-halted having never completed a probe', function () {
            const gate = loadGate()
            const reasons = gate.evaluateStatusPayload(
                { status: 'healthy', lag_blocks: 0, reorg_halted: false, reorg_halt_checked_at: null })
            expect(reasons).to.have.lengthOf(1)
            expect(reasons[0]).to.match(/never completed a REORG_HALT marker probe/)
        })

        it('passes the same decoder once a probe has actually completed', function () {
            const gate = loadGate()
            expect(gate.evaluateStatusPayload(
                { status: 'healthy', lag_blocks: 0, reorg_halted: false, reorg_halt_checked_at: 1756000000000 }
            )).to.deep.equal([])
        })

        // The indexer publishes no companion timestamp for decoderReorgHalted, so the
        // proof rule must not reach it: keying on the wrong field would refuse every
        // indexer bootstrap in the fleet.
        it('does not demand a probe timestamp from an indexer payload', function () {
            const gate = loadGate()
            expect(gate.evaluateStatusPayload({ status: 'healthy', lag: 0, decoderReorgHalted: false }))
                .to.deep.equal([])
        })

        it('REFUSES an indexer reporting its block counter wedged', function () {
            const gate = loadGate()
            const reasons = gate.evaluateStatusPayload(
                { status: 'healthy', lag: 3, stallClass: 'wedged', stallReason: 'vm_executor_host_fault' })
            expect(reasons).to.have.lengthOf(1)
            expect(reasons[0]).to.match(/WEDGED/)
            expect(reasons[0]).to.match(/vm_executor_host_fault/)
        })

        // The negative control that keeps the wedge check from becoming a fleet-wide
        // refusal: on testnet4 the future-stamped-block wait is the PERMANENT steady
        // state, and it carries degraded:true with a named stallReason the whole time.
        it('passes the healthy future-block wait and an in-grace barrier defer', function () {
            const gate = loadGate()
            expect(gate.evaluateStatusPayload({
                status: 'healthy', lag: 6, stallClass: 'future_block_wait', degraded: true,
                stallReason: 'price_sync_barrier', waitingOnFutureBlock: true
            })).to.deep.equal([])
            expect(gate.evaluateStatusPayload({
                status: 'healthy', lag: 3, stallClass: 'barrier_defer', degraded: true,
                stallReason: 'match_barrier'
            })).to.deep.equal([])
            expect(gate.evaluateStatusPayload({ status: 'healthy', lag: 0, stallClass: 'none' }))
                .to.deep.equal([])
        })

        it('refuses when the node tip is stale, since the lag is then unknowable', function () {
            const gate = loadGate()
            const reasons = gate.evaluateStatusPayload({ status: 'healthy', lag: 0, node_height_stale: true })
            expect(reasons.join(' ')).to.match(/cannot see the node tip/)
        })

        it('passes a healthy payload whose lag is zero', function () {
            const gate = loadGate()
            expect(gate.evaluateStatusPayload({ status: 'ok', db: true, lag: 0 })).to.deep.equal([])
        })

        it('REFUSES a payload with no lag field at all: position unverifiable is not caught-up', function () {
            const gate = loadGate()
            const reasons = gate.evaluateStatusPayload({ status: 'ok', db: true })
            expect(reasons).to.have.lengthOf(1)
            expect(reasons[0]).to.match(/did not report how far behind it is/)
        })

        it('REFUSES a negative lag: the committed tip sits above the node tip (orphaned view)', function () {
            const gate = loadGate()
            const reasons = gate.evaluateStatusPayload({ status: 'healthy', lag: -100, synced: false })
            expect(reasons).to.have.lengthOf(1)
            expect(reasons[0]).to.match(/negative lag \(-100\)/)
            expect(reasons[0]).to.not.match(/blocks behind/)
            expect(gate.evaluateStatusPayload({ status: 'healthy', lag_blocks: -1 }).join(' ')).to.match(/negative lag_blocks/)
        })

        it('formats a block-fetch desync object instead of printing [object Object]', function () {
            const gate = loadGate()
            const reasons = gate.evaluateStatusPayload({
                status: 'healthy', lag: 0,
                block_fetch_desync: { height: 5342110, failures: 20, lastError: 'Block not found', detectedAt: Date.now() }
            })
            expect(reasons).to.have.lengthOf(1)
            expect(reasons[0]).to.match(/height 5342110/)
            expect(reasons[0]).to.match(/20 consecutive failed fetches/)
            expect(reasons[0]).to.match(/last error: Block not found/)
            expect(reasons[0]).to.not.match(/\[object Object\]/)
            expect(gate.evaluateStatusPayload({ lag: 0, block_fetch_desync: 'node pruned' }).join(' ')).to.match(/desync \(node pruned\)/)
            expect(gate.evaluateStatusPayload({ lag: 0, block_fetch_desync: { other: 1 } }).join(' ')).to.match(/\{"other":1\}/)
        })
    })

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

// The gate has to actually be wired into `bootstrap create`, or none of the
// above matters. Loaded with the gate REAL and everything else stubbed, so a
// future refactor that drops the call fails here.
describe('makeBootstrap() consults the source health gate', function () {

    function loadServiceWithGate(gateStub) {
        return proxyquire('../../src/services/BootstrapService', {
            '../state': { db: { getModuleContainer: sinon.stub().resolves(SVC_CONTAINER) } },
            './ConfigService': {
                getDefaultConfig: sinon.stub().resolves({}),
                getModuleDatabaseName: sinon.stub().returns('db'),
                getUtxoTrackerVolumeName: sinon.stub().returns('vol')
            },
            './DockerService':   { stopContainer: sinon.stub().resolves(), startContainer: sinon.stub().resolves() },
            './DatabaseService': {
                getDatabaseContainerId: sinon.stub().resolves(DB_CONTAINER),
                ensureDatabasePool: sinon.stub().resolves(),
                askMariadbRootPassword: sinon.stub().resolves('pw')
            },
            './BootstrapHealthGate': { assertBootstrapSourceHealthy: gateStub }
        })
    }

    it('aborts the create when the gate refuses', async function () {
        const gateStub = sinon.stub().rejects(new Error('Refusing to create a bootstrap from litecoin/mainnet xchain-decoder'))
        const svc = loadServiceWithGate(gateStub)
        let err = null
        try { await svc.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER) } catch (e) { err = e }
        expect(err, 'the create must not proceed past a refusal').to.not.equal(null)
        expect(err.message).to.match(/Refusing to create a bootstrap/)
        expect(gateStub.calledOnceWithExactly(COIN, NETWORK, XChainService.XCHAIN_DECODER)).to.equal(true)
    })

    it('gates the utxo-tracker BEFORE stopping its container, so a refusal costs no downtime', async function () {
        const gateStub = sinon.stub().rejects(new Error('Refusing to create a bootstrap'))
        const stopContainer = sinon.stub().resolves()
        const svc = proxyquire('../../src/services/BootstrapService', {
            '../state': { db: { getModuleContainer: sinon.stub().resolves(SVC_CONTAINER) } },
            './ConfigService': {
                getDefaultConfig: sinon.stub().resolves({ UTXO_TRACKER_BOOTSTRAP_VOLUME: '/tmp/x' }),
                getModuleDatabaseName: sinon.stub().returns('db'),
                getUtxoTrackerVolumeName: sinon.stub().returns('vol')
            },
            './DockerService':   { stopContainer, startContainer: sinon.stub().resolves() },
            './DatabaseService': {
                getDatabaseContainerId: sinon.stub().resolves(DB_CONTAINER),
                ensureDatabasePool: sinon.stub().resolves(),
                askMariadbRootPassword: sinon.stub().resolves('pw')
            },
            './BootstrapHealthGate': { assertBootstrapSourceHealthy: gateStub }
        })
        try { await svc.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER) } catch (_) { /* expected */ }
        expect(stopContainer.called, 'the tracker must not be stopped for a create the gate refuses').to.equal(false)
    })

    it('still rejects an unsupported module before consulting the gate', async function () {
        const gateStub = sinon.stub().resolves({ skipped: false, reasons: [] })
        const svc = loadServiceWithGate(gateStub)
        let err = null
        try { await svc.makeBootstrap(COIN, NETWORK, 'xchain-unknown') } catch (e) { err = e }
        expect(err.message).to.match(/Unsupported module/)
        expect(gateStub.called).to.equal(false)
    })
})
