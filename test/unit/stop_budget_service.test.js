/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

// Pins the service stop budgets. Before these existed every CLI path took a
// service down with `docker kill` or a bare ten second `docker stop`, so the
// properties asserted here decide whether a decoder mid-rollback gets SIGTERM
// and a block boundary, or SIGKILL.

const { expect } = require('chai')
const sinon = require('sinon')
const sbs = require('../../src/services/stop_budget_service')

let logStub, warnStub

function prepareConsoleStubs() {
    logStub  = sinon.stub(console, 'log')
    warnStub = sinon.stub(console, 'warn')
}

function restoreConsoleStubs() {
    logStub.restore()
    warnStub.restore()
}

describe('StopBudgetService', function () {
    beforeEach(prepareConsoleStubs)
    afterEach(restoreConsoleStubs)

    describe('moduleStopTimeoutSeconds()', function () {
        it('gives the decoder and tracker more than docker\'s ten seconds, and the rest a default above it', function () {
            expect(sbs.moduleStopTimeoutSeconds('xchain-decoder', {})).to.be.greaterThan(10)
            expect(sbs.moduleStopTimeoutSeconds('xchain-utxo-tracker', {})).to.be.greaterThan(10)
            expect(sbs.moduleStopTimeoutSeconds('xchain-encoder', {})).to.equal(sbs.DEFAULT_MODULE_STOP_TIMEOUT_SECONDS)
            expect(sbs.DEFAULT_MODULE_STOP_TIMEOUT_SECONDS).to.be.greaterThan(10)
        })

        it('reads the per-service override by the derived variable name', function () {
            expect(sbs.moduleStopTimeoutEnvName('xchain-utxo-tracker')).to.equal('XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_UTXO_TRACKER')
            const env = { XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER: '300' }
            expect(sbs.moduleStopTimeoutSeconds('xchain-decoder', env)).to.equal(300)
            expect(sbs.moduleStopTimeoutSeconds('xchain-utxo-tracker', env)).to.equal(sbs.MODULE_STOP_TIMEOUT_SECONDS['xchain-utxo-tracker'])
        })

        it('ignores a value that is not a whole number of seconds, and says so', function () {
            const env = { XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER: 'two minutes' }
            expect(sbs.moduleStopTimeoutSeconds('xchain-decoder', env)).to.equal(sbs.MODULE_STOP_TIMEOUT_SECONDS['xchain-decoder'])
            expect(warnStub.args.some(a => /XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER=two minutes/.test(String(a[0])))).to.be.true
            expect(sbs.moduleStopTimeoutSeconds('xchain-decoder', { XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER: '0' }))
                .to.equal(sbs.MODULE_STOP_TIMEOUT_SECONDS['xchain-decoder'])
        })

        it('answers the coin node from its own resolver so `stop node` and `stop all` share one path', function () {
            const { nodeStopTimeoutSeconds } = require('../../src/services/node_service')
            expect(sbs.moduleStopTimeoutSeconds('node', {})).to.equal(nodeStopTimeoutSeconds())
        })
    })
})

describe('StopBudgetService', function () {
    beforeEach(prepareConsoleStubs)
    afterEach(restoreConsoleStubs)

    describe('stopTimeoutArgs()', function () {
        it('stamps the same budget on the container so a plain docker stop honours it', function () {
            expect(sbs.stopTimeoutArgs('xchain-decoder', {})).to.deep.equal(['--stop-timeout', String(sbs.MODULE_STOP_TIMEOUT_SECONDS['xchain-decoder'])])
        })
    })
})

describe('StopBudgetService', function () {
    beforeEach(prepareConsoleStubs)
    afterEach(restoreConsoleStubs)

    describe('stopModuleContainer()', function () {
        it('stops with the budget and reports a clean stop with the time it took', async function () {
            const stop = sinon.stub().resolves({ stopped: true, seconds: 7, killed: false })
            const outcome = await sbs.stopModuleContainer(stop, 'xchain-decoder', 'bitcoin', 'mainnet', 'abc123', {})
            expect(stop.calledOnceWith('abc123', sbs.MODULE_STOP_TIMEOUT_SECONDS['xchain-decoder'])).to.be.true
            expect(outcome.killed).to.be.false
            expect(outcome.budget).to.equal(sbs.MODULE_STOP_TIMEOUT_SECONDS['xchain-decoder'])
            expect(logStub.args.some(a => /Stopped xchain-decoder \(bitcoin mainnet\) cleanly in 7 s \(budget 120 s\)/.test(String(a[0])))).to.be.true
            expect(warnStub.called).to.be.false
        })

        it('warns when the service ran out of budget and was killed, naming the override', async function () {
            const stop = sinon.stub().resolves({ stopped: true, seconds: 120, killed: true })
            const outcome = await sbs.stopModuleContainer(stop, 'xchain-utxo-tracker', 'dogecoin', 'mainnet', 'abc123', {})
            expect(outcome.killed).to.be.true
            const warning = warnStub.args.map(a => String(a[0])).find(l => /was killed/.test(l))
            expect(warning).to.match(/xchain-utxo-tracker \(dogecoin mainnet\) did not exit within the 120 s budget/)
            expect(warning).to.match(/XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_UTXO_TRACKER/)
        })

        it('warns when the service exited non-zero inside the budget, naming its own drain timer', async function () {
            const stop = sinon.stub().resolves({ stopped: true, seconds: 100, killed: false, exitCode: 1 })
            const outcome = await sbs.stopModuleContainer(stop, 'xchain-decoder', 'bitcoin', 'mainnet', 'abc123', {})
            expect(outcome.killed).to.be.false
            const warning = warnStub.args.map(a => String(a[0])).find(l => /exited with code 1/.test(l))
            expect(warning).to.match(/xchain-decoder \(bitcoin mainnet\) exited with code 1 after 100 s, inside the 120 s budget/)
            expect(warning).to.match(/SHUTDOWN_TIMEOUT_MS/)
            expect(warning).to.match(/XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER gives that drain more time only once the container is recreated/)
            expect(logStub.args.some(a => /cleanly/.test(String(a[0])))).to.be.false
        })

        it('still reports a clean stop for exit 0 and for a drainless service ended by SIGTERM (143)', async function () {
            for (const exitCode of [0, 143, null]) {
                const stop = sinon.stub().resolves({ stopped: true, seconds: 3, killed: false, exitCode })
                await sbs.stopModuleContainer(stop, 'xchain-sdk', 'bitcoin', 'mainnet', 'abc123', {})
            }
            expect(logStub.args.filter(a => /Stopped xchain-sdk \(bitcoin mainnet\) cleanly in 3 s/.test(String(a[0])))).to.have.length(3)
            expect(warnStub.called).to.be.false
        })

        it('says nothing when there was nothing to stop', async function () {
            const stop = sinon.stub().resolves({ stopped: false, seconds: 0, killed: false })
            await sbs.stopModuleContainer(stop, 'xchain-encoder', 'bitcoin', 'mainnet', 'gone', {})
            expect(logStub.called).to.be.false
            expect(warnStub.called).to.be.false
        })
    })
})

// The node owns the drain: the service's own hard-exit timer is derived from
// the same budget docker kills at, so it always fires first.
describe('StopBudgetService', function () {
    beforeEach(prepareConsoleStubs)
    afterEach(restoreConsoleStubs)

    const DECODER_300 = { XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER: '300' }

    describe('moduleShutdownTimeoutMs()', function () {
        it('reproduces the decoder and tracker default of 100000 ms from the default 120 s budget', function () {
            expect(sbs.moduleShutdownTimeoutMs('xchain-decoder', {})).to.equal(100000)
            expect(sbs.moduleShutdownTimeoutMs('xchain-utxo-tracker', {})).to.equal(100000)
        })

        it('moves with an override in both directions and stays strictly under the budget', function () {
            expect(sbs.moduleShutdownTimeoutMs('xchain-decoder', DECODER_300)).to.equal(280000)
            const lowered = { XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER: '60' }
            expect(sbs.moduleShutdownTimeoutMs('xchain-decoder', lowered)).to.equal(40000)
            for (const seconds of ['1', '5', '20', '21', '39', '40', '41']) {
                const env = { XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER: seconds }
                const ms = sbs.moduleShutdownTimeoutMs('xchain-decoder', env)
                expect(ms, seconds).to.be.greaterThan(0).and.lessThan(parseInt(seconds, 10) * 1000)
            }
        })

        it('leaves a service on the plain default budget, and the coin node, to their own defaults', function () {
            expect(sbs.moduleShutdownTimeoutMs('xchain-explorer', {})).to.equal(null)
            expect(sbs.moduleShutdownTimeoutMs('node', {})).to.equal(null)
            const raised = { XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_EXPLORER: '90' }
            expect(sbs.moduleShutdownTimeoutMs('xchain-explorer', raised)).to.equal(70000)
        })
    })

    describe('shutdownTimeoutEnv()', function () {
        it('adds the derived value unless the module config sets its own', function () {
            expect(sbs.shutdownTimeoutEnv('xchain-decoder', {}, {})).to.deep.equal({ SHUTDOWN_TIMEOUT_MS: '100000' })
            expect(sbs.shutdownTimeoutEnv('xchain-decoder', { SHUTDOWN_TIMEOUT_MS: '45000' }, DECODER_300)).to.deep.equal({})
            expect(sbs.shutdownTimeoutEnv('xchain-decoder', { SHUTDOWN_TIMEOUT_MS: ' ' }, DECODER_300))
                .to.deep.equal({ SHUTDOWN_TIMEOUT_MS: '280000' })
            expect(sbs.shutdownTimeoutEnv('xchain-encoder', {}, {})).to.deep.equal({})
            expect(sbs.shutdownTimeoutEnv(null, {}, DECODER_300), 'a one-shot run').to.deep.equal({})
        })
    })
})

describe('StopBudgetService', function () {
    beforeEach(prepareConsoleStubs)
    afterEach(restoreConsoleStubs)

    const DECODER_300 = { XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER: '300' }
    const driftLine = () => warnStub.args.map(a => String(a[0])).find(l => /was created/.test(l))
    const cleanStop = () => sinon.stub().resolves({ stopped: true, seconds: 5, killed: false, exitCode: 0 })

    describe('stopModuleContainer() on a container that predates its budget', function () {
        it('warns before the stop when the container was stamped with another budget', async function () {
            const read = sinon.stub().resolves({ stopTimeout: 120, shutdownTimeoutMs: '100000' })
            const stop = cleanStop()
            await sbs.stopModuleContainer(stop, 'xchain-decoder', 'bitcoin', 'mainnet', 'abc123', DECODER_300, read)
            expect(read.calledOnceWith('abc123')).to.be.true
            expect(read.calledBefore(stop)).to.be.true
            expect(driftLine()).to.match(/xchain-decoder \(bitcoin mainnet\) was created under a 120 s stop budget/)
            expect(driftLine()).to.match(/XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER \(now 300 s\)/)
            expect(driftLine()).to.match(/xchain-node recreate/)
        })

        it('warns when an override is set but the container never got SHUTDOWN_TIMEOUT_MS', async function () {
            const read = sinon.stub().resolves({ stopTimeout: 300, shutdownTimeoutMs: null })
            await sbs.stopModuleContainer(cleanStop(), 'xchain-decoder', 'bitcoin', 'mainnet', 'abc123', DECODER_300, read)
            expect(driftLine()).to.match(/was created before the node forwarded SHUTDOWN_TIMEOUT_MS/)
        })

        it('stays quiet for a container that matches its budget, at the default or recreated', async function () {
            const atDefault = sinon.stub().resolves({ stopTimeout: 120, shutdownTimeoutMs: null })
            await sbs.stopModuleContainer(cleanStop(), 'xchain-decoder', 'bitcoin', 'mainnet', 'a', {}, atDefault)
            const recreated = sinon.stub().resolves({ stopTimeout: 300, shutdownTimeoutMs: '280000' })
            await sbs.stopModuleContainer(cleanStop(), 'xchain-decoder', 'bitcoin', 'mainnet', 'b', DECODER_300, recreated)
            const unreadable = sinon.stub().rejects(new Error('docker gone'))
            await sbs.stopModuleContainer(cleanStop(), 'xchain-decoder', 'bitcoin', 'mainnet', 'c', DECODER_300, unreadable)
            expect(warnStub.called).to.be.false
        })

        it('stays quiet for a default-budget service that never carried a forwarded drain', async function () {
            const read = sinon.stub().resolves({ stopTimeout: null, shutdownTimeoutMs: null })
            await sbs.stopModuleContainer(cleanStop(), 'xchain-explorer', 'bitcoin', 'mainnet', 'abc123', {}, read)
            expect(warnStub.called).to.be.false
        })

        it('warns when an override was dropped but the container still carries the drain it derived', async function () {
            const read = sinon.stub().resolves({ stopTimeout: 90, shutdownTimeoutMs: '70000' })
            await sbs.stopModuleContainer(cleanStop(), 'xchain-explorer', 'bitcoin', 'mainnet', 'abc123', {}, read)
            expect(driftLine()).to.match(/xchain-explorer \(bitcoin mainnet\) was created under a 90 s stop budget/)
            expect(driftLine()).to.match(/\(now 30 s\)/)
        })

        it('never reads the coin node, whose budget is a flush and not a drain', async function () {
            const read = sinon.stub().resolves({ stopTimeout: 1, shutdownTimeoutMs: '1' })
            await sbs.stopModuleContainer(cleanStop(), 'node', 'bitcoin', 'mainnet', 'abc123', {}, read)
            expect(read.called).to.be.false
        })
    })
})
