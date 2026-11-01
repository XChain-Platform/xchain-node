'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The bootstrap gate's stallReasons comment lists every stallClass the indexer can
// publish, so a reader knows what a probe can see. The indexer defines the set; this
// drives its real classifier over every input shape and holds the comment to the result.

const fs = require('fs')
const path = require('path')
const { expect } = require('chai')

const INDEXER_DIR = path.join(__dirname, '../../../../xchain-indexer')
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'
const GATE_SOURCE = path.join(__dirname, '../../../src/services/bootstrap_health_gate/status_evaluation.js')

// Every class the indexer publishes today; the grid below must reach each one.
const EXPECTED = [
    'none', 'future_block_wait', 'bridge_proof_wait', 'train_activation_halt', 'price_landing_wait',
    'operator_action_hold', 'barrier_defer', 'wedged', 'upstream_halted', 'rollcall_proof_wait', 'rollcall_proof_stuck',
    'capability_proof_wait', 'capability_proof_stuck'
]

// Every class publishedStallClass(stallClassOf(...)) returns over the reason, commit-age,
// clear-instant, decoder-halt and hold-ceiling inputs that steer it.
function publishedClasses({ stallClassOf, publishedStallClass }) {
    const now = 1760000000000
    const graceMs = 120000
    const reasons = [null, 'bridge_proof_barrier', 'train_activation_halt: rule set 3 required at 900',
        'retroactive_replay_diverged', 'price_landing_barrier', 'price_sync_barrier',
        'rollcall_proof_unavailable', 'capability_proof_unavailable']
    const seen = new Set()
    for (const reason of reasons)
        for (const lastCommit of [null, now - 1000, now - 10 * 60000])
            for (const clearsAt of [null, now + 60000])
                for (const decoderReorgHalted of [false, true])
                    for (const ceilingExceeded of [false, true]) {
                        const base = stallClassOf(reason, lastCommit, graceMs, now, clearsAt, 300000, null)
                        seen.add(publishedStallClass(base, reason, { decoderReorgHalted, ceilingExceeded }))
                    }
    return [...seen].sort()
}

describe('BootstrapHealthGate: the published stall class set', function () {

    it('lists every class the indexer can publish in the stallReasons comment', function () {
        if (!fs.existsSync(INDEXER_DIR)) {
            if (REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-indexer is not checked out at ' + INDEXER_DIR)
            return this.skip()      // sibling repo not checked out
        }
        const classes = publishedClasses(require(path.join(INDEXER_DIR, 'src/XChainIndexer/stall_health.js')))
        expect(classes, 'a new class must be added here and to the stallReasons comment').to.deep.equal([...EXPECTED].sort())

        const source = fs.readFileSync(GATE_SOURCE, 'utf8')
        const start = source.indexOf('function stallReasons(')
        const end = source.indexOf("if (payload.stallClass === 'wedged')", start)
        expect(start, 'stallReasons not found').to.be.above(-1)
        expect(end, 'the wedged leg of stallReasons not found').to.be.above(start)
        const comment = source.slice(start, end)
        const missing = classes.filter(c => !comment.includes("'" + c + "'"))
        expect(missing, 'stall classes the stallReasons comment does not list').to.deep.equal([])
    })
})
