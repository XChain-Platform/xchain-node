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



        // The indexer tracks reorgs by a decoder event id, and the decoder never
        // deletes those rows, so wiping the decoder alone restarts the ids under a
        // cursor pointing past them and the indexer aborts RE-1. The pair is only
        // coherent when both move together, so a one-sided reset is refused.

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {
        describe('the coupled decoder/indexer pair', function () {

            it('refuses a decoder-only reset while an indexer is installed', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)

                const result = await ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true)

                expect(result).to.be.false
                // Refused BEFORE anything destructive, not partway through.
                expect(stubs.resetDatabases.called).to.be.false
                expect(stubs.stopContainer.called).to.be.false
            })

            it('names the joint form in the refusal, so the remedy is runnable', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const logged = []
                const log = sinon.stub(console, 'log').callsFake((...a) => logged.push(a.join(' ')))
                try {
                    const ops = loadOperations(stubs)
                    await ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true)
                } finally {
                    log.restore()
                }
                const text = logged.join('\n')
                expect(text).to.contain('--with-indexer')
                expect(text).to.contain('bitcoin mainnet')
                expect(text).to.contain('No data was touched')
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
        describe('the coupled decoder/indexer pair', function () {

            it('resets both halves together when the joint form is used', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true, true)
                await clock.tickAsync(6000)
                clock.restore()

                expect(await promise).to.be.true
                const modules = stubs.resetDatabases.firstCall.args[2]
                expect(modules).to.have.members(['xchain-decoder', 'xchain-indexer'])
                // A wiped indexer restarts its push generations, so the hub fence has
                // to be cleared on this path or the chain's price rail dies silently.
                expect(stubs.clearHubPriceIngestWatermark.called).to.be.true
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
        describe('the coupled decoder/indexer pair', function () {

            it('allows a decoder-only reset when no indexer is installed to strand', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                // The coupling guard is strictly enforced: the "absent" answer must
                // come from the strict stub rather than the swallowing catch-all.
                stubs.db.getModuleContainerStrict.callsFake(async (module) =>
                    module === 'xchain-indexer' ? null : 'container-id-123')
                stubs.db.getModuleContainer.callsFake(async (module) =>
                    module === 'xchain-indexer' ? null : 'container-id-123')
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true)
                await clock.tickAsync(6000)
                clock.restore()

                expect(await promise).to.be.true
                expect(stubs.resetDatabases.firstCall.args[2]).to.deep.equal(['xchain-decoder'])
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
        describe('the coupled decoder/indexer pair', function () {

            // A registry read that FAILED is not evidence the indexer is absent: the
            // swallowing read this replaced answered null on any SQL error, so a blip
            // let a decoder-only reset DROP the decoder database while an installed
            // indexer kept its dangling decoder-event cursor after removal.
            it('aborts the decoder-only reset when the indexer registry row cannot be read', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.db.getModuleContainerStrict.callsFake(async (module) => {
                    if (module === 'xchain-indexer') throw new Error('ER_LOCK_WAIT_TIMEOUT')
                    return 'container-id-123'
                })
                // The swallowing read answers "absent" for the indexer, which is exactly
                // what the old guard believed: with the pre-fix source this test runs the
                // whole reset and resetDatabases fires. That is the negative control.
                stubs.db.getModuleContainer.callsFake(async (module) =>
                    module === 'xchain-indexer' ? null : 'container-id-123')
                const logged = []
                const log = sinon.stub(console, 'log').callsFake((...a) => logged.push(a.join(' ')))
                let result
                try {
                    const ops = loadOperations(stubs)
                    result = await ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true)
                } finally {
                    log.restore()
                }

                expect(result).to.be.false
                // The guard consulted the STRICT read. A decoder-only reset never puts
                // the indexer in modulesToStop, so nothing else in this path asks for
                // that row: this check runs because the guard enforces strict reads.
                expect(stubs.db.getModuleContainerStrict.calledWith('xchain-indexer', 'bitcoin', 'mainnet')).to.be.true
                // Refused BEFORE anything destructive, and before anything was stopped.
                expect(stubs.resetDatabases.called).to.be.false
                expect(stubs.stopContainer.called).to.be.false
                const text = logged.join('\n')
                expect(text).to.contain('cannot read the xchain-indexer registry row')
                expect(text).to.contain('ER_LOCK_WAIT_TIMEOUT')
                expect(text).to.contain('No data was touched')
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
        describe('the coupled decoder/indexer pair', function () {

            // Asymmetric by design: the indexer re-derives from an intact decoder,
            // which is an ordinary reindex and must stay available.
            it('still allows an indexer-only reset', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('xchain-indexer', 'bitcoin', 'mainnet', true)
                await clock.tickAsync(6000)
                clock.restore()

                expect(await promise).to.be.true
                expect(stubs.resetDatabases.firstCall.args[2]).to.deep.equal(['xchain-indexer'])
            })

            it('leaves `reset all` alone, which already moves both', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('all', 'bitcoin', 'mainnet', true)
                await clock.tickAsync(6000)
                clock.restore()

                expect(await promise).to.be.true
                expect(stubs.resetDatabases.firstCall.args[2]).to.have.members(['xchain-decoder', 'xchain-indexer'])
            })
        })
    })
})
