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
const sbs = require('../../src/services/StopBudgetService')

describe('StopBudgetService', function () {
    let logStub, warnStub
    beforeEach(function () {
        logStub  = sinon.stub(console, 'log')
        warnStub = sinon.stub(console, 'warn')
    })
    afterEach(function () {
        logStub.restore()
        warnStub.restore()
    })

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
            const { nodeStopTimeoutSeconds } = require('../../src/services/NodeService')
            expect(sbs.moduleStopTimeoutSeconds('node', {})).to.equal(nodeStopTimeoutSeconds())
        })
    })

    describe('stopTimeoutArgs()', function () {
        it('stamps the same budget on the container so a plain docker stop honours it', function () {
            expect(sbs.stopTimeoutArgs('xchain-decoder', {})).to.deep.equal(['--stop-timeout', String(sbs.MODULE_STOP_TIMEOUT_SECONDS['xchain-decoder'])])
        })
    })

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

        it('says nothing when there was nothing to stop', async function () {
            const stop = sinon.stub().resolves({ stopped: false, seconds: 0, killed: false })
            await sbs.stopModuleContainer(stop, 'xchain-encoder', 'bitcoin', 'mainnet', 'gone', {})
            expect(logStub.called).to.be.false
            expect(warnStub.called).to.be.false
        })
    })
})
