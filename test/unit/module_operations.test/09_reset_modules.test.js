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

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })


    // -------------------------------------------------------------------
    // resetModules
    // -------------------------------------------------------------------

        describe('resetModules()', function () {

        it('resets all services when service=all', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('all', 'bitcoin', 'mainnet', true)
            await clock.tickAsync(6000) // advance past 5000ms bounce delay
            clock.restore()
            const result = await promise
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.true
            expect(stubs.startContainer.called).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
        })

        it('only resets node data when service=node', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.true
            // No bounce candidates for node-only reset
        })

        it('stops and resets utxo-tracker when service=xchain-utxo-tracker', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {

        it('resets decoder: stops, resets DB, and bounces', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true, true)
            await clock.tickAsync(6000)
            clock.restore()
            const result = await promise
            expect(result).to.be.true
            expect(stubs.resetDatabases.calledOnce).to.be.true
            expect(stubs.restartContainer.called).to.be.true // bounce
        })

        // Wiping the indexer DB restarts its push_generations at 0, which the
        // hub's price ingest fence silently drops. The reset owns clearing the fence.
        // The MariaDB probe runs before any stop or wipe: when the container is gone
        // the test aborts early so no service stops and nothing writes to disk.
        it('aborts a missing-MariaDB reset without stopping anything', async function () {
            const stubs = makeStubs()
            stubs.getDatabaseContainerId.resolves(null)
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
            expect(result).to.be.false
            expect(stubs.stopContainer.called).to.be.false
            expect(stubs.resetDatabases.called).to.be.false
            expect(stubs.startContainer.called).to.be.false
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {

        // The stop loop treats individual docker failures as "not installed" which
        // lets wipes run while a daemon still holds the data store. Abort on any
        // real stop error and restart what this pass managed to stop.
        it('aborts before any wipe when a target fails to stop, and restarts what it stopped', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            // node stops, xchain-utxo-tracker refuses.
            stubs.stopContainer.onCall(1).rejects(
                new Error('Command failed: docker stop x\nError response from daemon: cannot stop container')
            )
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
            expect(result).to.be.false
            expect(stubs.resetDatabases.called).to.be.false
            expect(stubs.execFile.called).to.be.false          // no wipe ran
            expect(stubs.startContainer.calledOnce).to.be.true // node put back
        })

        it('still treats a "no such container" stop as a skip and completes the reset', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            stubs.stopContainer.rejects(
                new Error('Command failed: docker stop x\nError response from daemon: No such container: x')
            )
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
            expect(result).to.be.true
            expect(stubs.execFile.called).to.be.true // the volume wipe still ran
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {

        // stopContainer rejects a bare STRING when docker exits 0 without echoing
        // the id back, which is a real failure carrying no .message to match.
        it('aborts when stopContainer rejects a non-Error value', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            stubs.stopContainer.callsFake(() => Promise.reject('error trying to stop the docker container'))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
            expect(result).to.be.false
            expect(stubs.execFile.called).to.be.false
        })

        it('clears the hub price ingest fence when the indexer DB is reset', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('xchain-indexer', 'bitcoin', 'mainnet', true)
            await clock.tickAsync(6000)
            clock.restore()
            expect(await promise).to.be.true
            expect(stubs.clearHubPriceIngestWatermark.calledOnceWith('bitcoin', 'mainnet')).to.be.true
            // After the wipe and before the indexer is started again, so the first
            // push after the restart is not the one that gets dropped.
            expect(stubs.resetDatabases.calledBefore(stubs.clearHubPriceIngestWatermark)).to.be.true
            expect(stubs.clearHubPriceIngestWatermark.calledBefore(stubs.startContainer)).to.be.true
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {

        // A decoder-only reset is reachable only where no indexer is installed to
        // strand; with one present the pair guard refuses. The fence belongs to the
        // indexer's push generations, so an untouched indexer keeps its fence.
        it('leaves the fence alone on a decoder-only reset (that chain keeps pushing prices)', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            // The coupling guard reads strictly, so "no indexer installed" is the
            // strict stub's answer; both are set so the fixture states one thing.
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
            expect(stubs.clearHubPriceIngestWatermark.called).to.be.false
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {

        it('reports a fence-clear failure without aborting the restart pass', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            stubs.clearHubPriceIngestWatermark.rejects(new Error('hub DB unreachable'))
            const warn = sinon.stub(console, 'warn')
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('xchain-indexer', 'bitcoin', 'mainnet', true)
            await clock.tickAsync(6000)
            clock.restore()
            const result = await promise
            const lines = warn.getCalls().map(c => String(c.args[0])).join('\n')
            warn.restore()
            // The wipe already happened: leaving the stack stopped would be worse than
            // an uncleared fence, so this is loud but not fatal.
            expect(result).to.be.true
            expect(stubs.startContainer.called).to.be.true
            expect(lines).to.contain('price_ingest_watermarks')
            expect(lines).to.contain("source_chain = 'BTC'")
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {

        it('scopes the hand-run fence statement to the reset network, plus the legacy bucket', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            stubs.clearHubPriceIngestWatermark.rejects(new Error('hub DB unreachable'))
            const warn = sinon.stub(console, 'warn')
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('xchain-indexer', 'bitcoin', 'regtest', true)
            await clock.tickAsync(6000)
            clock.restore()
            await promise
            const lines = warn.getCalls().map(c => String(c.args[0])).join('\n')
            warn.restore()
            // A statement an operator pastes must not be the chain-keyed one: run on a
            // hub federating several networks it drops testnet's and mainnet's fence
            // for BTC as well, which is the exact defect the network column removed.
            expect(lines).to.contain(
                "DELETE FROM price_ingest_watermarks WHERE source_chain = 'BTC' AND network IN ('regtest', '');")
            expect(lines).to.not.contain("source_chain = 'BTC';")
        })

        it('resets node data when nodeDataPath exists', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(true) // nodeDataPath exists
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
            expect(result).to.be.true
            // execFile called for docker run --rm to clear data
            expect(stubs.execFile.called).to.be.true
            const call = stubs.execFile.firstCall
            expect(call.args[0]).to.equal('docker')
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {

        // A failed stopContainer blocks the entire operation. Wiping databases
        // while the service is still running would corrupt data, so the contract
        // is to abort before any wipe runs.
        it('does not continue past a failed stopContainer', async function () {
            const stubs = makeStubs()
            stubs.stopContainer.rejects(new Error('stop failed'))
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
            expect(result).to.be.false
            expect(stubs.execFile.called).to.be.false
        })

        // #3144: reset must fail loud on bad args rather than reporting success
        // after resetting nothing (an unknown service leaves every flag false).
        it('throws on an unknown service instead of a silent no-op success', async function () {
            const ops = loadOperations(makeStubs())
            let threw = null
            try { await ops.resetModules('xchain-encoder', 'bitcoin', 'mainnet', true) }
            catch (e) { threw = e }
            expect(threw, 'expected a thrown error for an unknown service').to.be.an('error')
            expect(threw.message).to.match(/unknown service/)
        })

        it('throws on an unknown coin', async function () {
            const ops = loadOperations(makeStubs())
            let threw = null
            try { await ops.resetModules('all', 'notacoin', 'mainnet', true) }
            catch (e) { threw = e }
            expect(threw, 'expected a thrown error for an unknown coin').to.be.an('error')
            expect(threw.message).to.match(/unknown coin/)
        })
    })
})

describe('moduleOperations', function () {
    let resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub
    registerLifecycleHooks(stubs => {
        ({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub } = stubs)
    })

    describe('resetModules()', function () {

        it('throws on an unknown network', async function () {
            const ops = loadOperations(makeStubs())
            let threw = null
            try { await ops.resetModules('all', 'bitcoin', 'stagenet', true) }
            catch (e) { threw = e }
            expect(threw, 'expected a thrown error for an unknown network').to.be.an('error')
            expect(threw.message).to.match(/unknown network/)
        })
    })
})
