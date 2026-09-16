'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { sinon, expect, makeStubs, loadOperations, registerLifecycleHooks, requireFromUnit } = require('./helpers/harness')



        // A reset rebuilds a store on a NEW lineage, so every bootstrap
        // already published for that combo describes the old one and restoring
        // it puts a fresh install on a chain this box no longer agrees with.
        // Nothing forced a republish, and no age check caught it because the
        // wrong archive was hours old. The reset itself has to arm the marker.

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {
        describe('marks the reindexed combos for a forced bootstrap republish', function () {

            it('marks the tracker combo when the tracker volume is wiped', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                expect(await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'testnet', true)).to.be.true

                expect(stubs.republishLedger.recordReindex.calledOnce).to.be.true
                const [modules, coin, network, opts] = stubs.republishLedger.recordReindex.firstCall.args
                expect(modules).to.deep.equal(['xchain-utxo-tracker'])
                expect(coin).to.equal('bitcoin')
                expect(network).to.equal('testnet')
                expect(opts.reason).to.include('reset xchain-utxo-tracker')
            })

            // A re-genesis is run as `reset all`, and that is where all three
            // derived archives really do go stale.
            it('marks all three on a reset all', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('all', 'bitcoin', 'testnet', true)
                await clock.tickAsync(6000)   // past the decoder/indexer bounce delay
                clock.restore()
                expect(await promise).to.be.true

                expect(stubs.republishLedger.recordReindex.calledOnce).to.be.true
                expect(stubs.republishLedger.recordReindex.firstCall.args[0])
                    .to.deep.equal(['xchain-utxo-tracker', 'xchain-decoder', 'xchain-indexer'])
            })
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {
        describe('marks the reindexed combos for a forced bootstrap republish', function () {

            // A node-only reset resyncs the same chain and leaves every derived
            // store untouched, so warning about three combos there would be
            // noise on an ordinary resync.
            it('marks nothing for a node-only reset', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                expect(await ops.resetModules('node', 'bitcoin', 'testnet', true)).to.be.true
                expect(stubs.republishLedger.recordReindex.called).to.be.false
            })

            // Nothing was wiped on an aborted reset, so the published archives
            // are still the right lineage: arming here would force a pointless
            // tracker republish (which costs downtime) on every refused reset.
            it('marks nothing when the reset aborts before any wipe', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                // The decoder/indexer pair is only coherent when both move
                // together, so a decoder-only reset with the indexer installed
                // is refused before anything is touched.
                const ops = loadOperations(stubs)
                expect(await ops.resetModules('xchain-decoder', 'bitcoin', 'testnet', true)).to.be.false
                expect(stubs.republishLedger.recordReindex.called).to.be.false
            })
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {
        describe('marks the reindexed combos for a forced bootstrap republish', function () {

            // The wipes already happened by the time this runs, so a ledger
            // failure must never abort the restart pass and leave the stack down.
            it('does not abort the reset when the ledger cannot be written', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.republishLedger.recordReindex.throws(new Error('read-only home'))
                const ops = loadOperations(stubs)
                expect(await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'testnet', true)).to.be.true
                expect(stubs.startContainer.called).to.be.true
            })
        })
    })
})
