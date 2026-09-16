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



        // The stop loop resolves each target through the swallowing getModuleContainer,
        // which returns null for both SQL errors and genuine misses. After the
        // reachability precheck passes, a registry blip makes a RUNNING indexer
        // look absent: the loop skips stopping it while resetDatabases drops its
        // database underneath, and the command reports success. A read that FAILED
        // is not evidence of absence.


            // Every `docker run --rm -v <host>:/data` this reset issued.
            function wipeRuns(execFileStub) {
                return execFileStub.getCalls()
                    .filter(c => c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
            }
describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {
        describe('the registry read that decides what to stop', function () {

            it('aborts before any wipe when a target row cannot be read', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.db.getModuleContainerStrict.callsFake(async (module) => {
                    if (module === 'xchain-utxo-tracker') throw new Error('ER_LOCK_WAIT_TIMEOUT')
                    return 'container-id-123'
                })
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                expect(wipeRuns(stubs.execFile)).to.be.empty
                const output = lines.join('\n')
                expect(output).to.include('cannot read the xchain-utxo-tracker registry row')
                expect(output).to.include('ER_LOCK_WAIT_TIMEOUT')
                expect(output).to.include('No data was touched.')
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
        describe('the registry read that decides what to stop', function () {

            it('reports a module the rollback cannot resolve as still down', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                // node resolves and stops, the tracker read fails, and the
                // rollback's own read fails the same way.
                stubs.db.getModuleContainerStrict.onCall(0).resolves('container-id-123')
                stubs.db.getModuleContainerStrict.rejects(new Error('registry unreachable'))
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.startContainer.called).to.be.false
                expect(lines.join('\n')).to.include('STILL DOWN, start by hand: node')
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
        describe('the registry read that decides what to stop', function () {

            // A successful read with no row is still an ordinary "not installed".
            it('still skips a module that is genuinely absent from the registry', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.db.getModuleContainerStrict.callsFake(async (module) =>
                    module === 'xchain-regtest-miner' ? null : 'container-id-123')
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('all', 'bitcoin', 'mainnet', true)
                await clock.tickAsync(6000)
                clock.restore()
                expect(await promise).to.be.true
                expect(stubs.resetDatabases.calledOnce).to.be.true
            })
        })
    })
})
