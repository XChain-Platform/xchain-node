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

    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('evaluateStatusPayload()', function () {

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

    })
})

describe('BootstrapHealthGate', function () {

    installEnvironmentHooks()

    describe('evaluateStatusPayload()', function () {

        // Number('') / Number(' ') / Number(false) / Number([]) are all 0, so a
        // coerce-then-isFinite check read each of these as "0 blocks behind" and
        // certified an unknown position as caught up. A gate whose contract is
        // fail-closed parsing has to refuse the shape before it compares it.
        it('REFUSES a lag that is not a number, rather than coercing it to zero', function () {
            const gate = loadGate()
            for (const bad of ['', '   ', false, true, [], [0], {}, 'soon', '12abc', NaN, Infinity]) {
                const reasons = gate.evaluateStatusPayload({ status: 'healthy', lag_blocks: bad })
                expect(reasons, `lag_blocks=${JSON.stringify(bad)}`).to.have.lengthOf(1)
                expect(reasons[0], `lag_blocks=${JSON.stringify(bad)}`).to.match(/unreadable lag_blocks/)
            }
            // A refusal must NAME what it refused; raw interpolation renders [] as
            // an empty string and {} as [object Object].
            expect(gate.evaluateStatusPayload({ lag_blocks: [] })[0]).to.not.match(/\[object Object\]|\(\)/)
        })

        it('still accepts the two shapes a producer legitimately emits', function () {
            const gate = loadGate()
            expect(gate.evaluateStatusPayload({ status: 'ok', db: true, lag_blocks: 0 })).to.deep.equal([])
            expect(gate.evaluateStatusPayload({ status: 'ok', db: true, lag_blocks: 3 })).to.deep.equal([])
            expect(gate.evaluateStatusPayload({ status: 'ok', db: true, lag_blocks: '3' })).to.deep.equal([])
            expect(gate.evaluateStatusPayload({ status: 'ok', db: true, lag_blocks: ' 3 ' })).to.deep.equal([])
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
})
