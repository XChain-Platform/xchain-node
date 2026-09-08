'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Container memory limits. Nothing set --memory before, so every tracker sized
// itself for the whole host and N trackers on one box oversubscribed it. The
// orchestrator now hands each tracker its share; other modules stay uncapped
// unless the operator says otherwise.

const { expect } = require('chai')
const {
    memoryArgsFor, trackerMemoryLimitMb, countInstalledTrackers, moduleEnvKey,
    TRACKER_FLOOR_MB, TRACKER_CEILING_MB
} = require('../../src/services/MemoryLimitService')

const GiB = 1024 * 1024 * 1024
const TRACKER = 'xchain-utxo-tracker'

describe('MemoryLimitService', function () {

    describe('trackerMemoryLimitMb()', function () {
        it('gives one tracker half the host', function () {
            expect(trackerMemoryLimitMb({ hostBytes: 16 * GiB, trackerCount: 1 }).mb).to.equal(8192)
        })

        it('divides the half among the trackers on the host (the 16 GB three-chain case)', function () {
            const d = trackerMemoryLimitMb({ hostBytes: 16 * GiB, trackerCount: 3 })
            expect(d.mb).to.equal(2730)
            expect(d.floored).to.equal(false)
        })

        it('floors, and says so, when the host cannot afford its trackers', function () {
            const d = trackerMemoryLimitMb({ hostBytes: 4 * GiB, trackerCount: 3 })
            expect(d.mb).to.equal(TRACKER_FLOOR_MB)
            expect(d.floored).to.equal(true)
        })

        it('ceilings a huge host', function () {
            expect(trackerMemoryLimitMb({ hostBytes: 256 * GiB, trackerCount: 1 }).mb).to.equal(TRACKER_CEILING_MB)
        })

        it('treats a missing or zero count as one', function () {
            expect(trackerMemoryLimitMb({ hostBytes: 16 * GiB, trackerCount: 0 }).mb).to.equal(8192)
            expect(trackerMemoryLimitMb({ hostBytes: 16 * GiB }).mb).to.equal(8192)
        })
    })

    describe('memoryArgsFor()', function () {
        it('caps the tracker with --memory and an equal --memory-swap', function () {
            const r = memoryArgsFor(TRACKER, { hostBytes: 16 * GiB, trackerCount: 3, env: {} })
            expect(r.source).to.equal('derived')
            expect(r.args).to.deep.equal(['--memory', '2730m', '--memory-swap', '2730m'])
            expect(r.note).to.match(/memory limit for xchain-utxo-tracker: 2730 MB \(host 16384 MB, 50% shared by 3 trackers\)/)
        })

        it('leaves every other module uncapped by default', function () {
            for (const m of ['xchain-decoder', 'xchain-indexer', 'xchain-hub', 'xchain-explorer', 'xchain-encoder']) {
                const r = memoryArgsFor(m, { hostBytes: 16 * GiB, trackerCount: 3, env: {} })
                expect(r.args, m).to.deep.equal([])
                expect(r.source, m).to.equal('none')
                expect(r.note, m).to.equal(null)
            }
        })

        it('an explicit XCHAIN_NODE_MODULE_MEMORY_MB_<SERVICE> wins for any module', function () {
            const env = { XCHAIN_NODE_MODULE_MEMORY_MB_XCHAIN_DECODER: '1536', XCHAIN_NODE_MODULE_MEMORY_MB_XCHAIN_UTXO_TRACKER: '4096' }
            expect(memoryArgsFor('xchain-decoder', { hostBytes: 16 * GiB, env }).args).to.deep.equal(['--memory', '1536m', '--memory-swap', '1536m'])
            const t = memoryArgsFor(TRACKER, { hostBytes: 16 * GiB, trackerCount: 3, env })
            expect(t.source).to.equal('env')
            expect(t.args).to.deep.equal(['--memory', '4096m', '--memory-swap', '4096m'])
        })

        it('0 disables the derived tracker cap, and says so', function () {
            const r = memoryArgsFor(TRACKER, { hostBytes: 16 * GiB, trackerCount: 3, env: { XCHAIN_NODE_MODULE_MEMORY_MB_XCHAIN_UTXO_TRACKER: '0' } })
            expect(r.args).to.deep.equal([])
            expect(r.note).to.match(/=0: no memory limit/)
        })

        it('ignores an unparseable value rather than guessing, and names it', function () {
            const r = memoryArgsFor(TRACKER, { hostBytes: 16 * GiB, trackerCount: 1, env: { XCHAIN_NODE_MODULE_MEMORY_MB_XCHAIN_UTXO_TRACKER: '2g' } })
            expect(r.args).to.deep.equal([])
            expect(r.note).to.match(/"2g" is not a whole number of MB; ignored/)
        })

        it('warns in the note when the share is under the floor', function () {
            const r = memoryArgsFor(TRACKER, { hostBytes: 4 * GiB, trackerCount: 3, env: {} })
            expect(r.args).to.deep.equal(['--memory', TRACKER_FLOOR_MB + 'm', '--memory-swap', TRACKER_FLOOR_MB + 'm'])
            expect(r.note).to.match(/WARNING: the derived share \(682 MB\) is under the 1024 MB floor/)
        })

        it('derives the env key from the service name', function () {
            expect(moduleEnvKey('xchain-utxo-tracker')).to.equal('XCHAIN_NODE_MODULE_MEMORY_MB_XCHAIN_UTXO_TRACKER')
        })
    })

    describe('countInstalledTrackers()', function () {
        const rows = [
            { module: TRACKER, coin: 'bitcoin', network: 'mainnet' },
            { module: TRACKER, coin: 'litecoin', network: 'testnet' },
            { module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet' }
        ]

        it('counts the registered trackers plus the one being created', async function () {
            const db = { getAllModuleContainers: async () => rows }
            expect(await countInstalledTrackers(db, { coin: 'dogecoin', network: 'mainnet' })).to.equal(3)
        })

        it('does not double-count a tracker that is already registered (recreate)', async function () {
            const db = { getAllModuleContainers: async () => rows }
            expect(await countInstalledTrackers(db, { coin: 'bitcoin', network: 'mainnet' })).to.equal(2)
        })

        it('counts one when the registry cannot be read or the handle has no registry', async function () {
            expect(await countInstalledTrackers({ getAllModuleContainers: async () => { throw new Error('down') } }, { coin: 'bitcoin', network: 'mainnet' })).to.equal(1)
            expect(await countInstalledTrackers({}, { coin: 'bitcoin', network: 'mainnet' })).to.equal(1)
            expect(await countInstalledTrackers(null, { coin: 'bitcoin', network: 'mainnet' })).to.equal(1)
        })
    })
})
