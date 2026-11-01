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

// Pins the restart path to the same stop budget as stop, update and reset. A bare
// `docker restart` gave an unstamped decoder docker's ten seconds and ignored a raised override.

const fs = require('fs')
const path = require('path')
const { expect } = require('chai')
const sinon = require('sinon')
const sbs = require('../../src/services/stop_budget_service')

const SRC_DIR = path.join(__dirname, '..', '..', 'src')
const DECODER_300 = { XCHAIN_NODE_MODULE_STOP_TIMEOUT_SECONDS_XCHAIN_DECODER: '300' }

let logStub, warnStub

function prepareConsoleStubs() {
    logStub  = sinon.stub(console, 'log')
    warnStub = sinon.stub(console, 'warn')
}

function restoreConsoleStubs() {
    logStub.restore()
    warnStub.restore()
}

// Return every .js file under a directory, relative to src/.
function listSourceFiles(dir) {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...listSourceFiles(full))
        else if (entry.name.endsWith('.js')) out.push(path.relative(SRC_DIR, full))
    }
    return out
}

describe('StopBudgetService restartModuleContainer()', function () {
    beforeEach(prepareConsoleStubs)
    afterEach(restoreConsoleStubs)

    it('stops an unstamped decoder with its 120 s budget, then starts it', async function () {
        const stop = sinon.stub().resolves({ stopped: true, seconds: 4, killed: false, exitCode: 0 })
        const start = sinon.stub().resolves(true)
        const read = sinon.stub().resolves({ stopTimeout: null, shutdownTimeoutMs: null })
        await sbs.restartModuleContainer(stop, start, 'xchain-decoder', 'bitcoin', 'mainnet', 'abc123', {}, read)
        expect(stop.calledOnceWith('abc123', 120)).to.equal(true)
        expect(start.calledOnceWith('abc123')).to.equal(true)
        expect(stop.calledBefore(start)).to.equal(true)
    })

    it('honours a raised override on a container stamped with the old budget', async function () {
        const stop = sinon.stub().resolves({ stopped: true, seconds: 4, killed: false, exitCode: 0 })
        const read = sinon.stub().resolves({ stopTimeout: 120, shutdownTimeoutMs: '100000' })
        await sbs.restartModuleContainer(stop, sinon.stub().resolves(true), 'xchain-decoder', 'bitcoin', 'mainnet',
            'abc123', DECODER_300, read)
        expect(stop.firstCall.args[1]).to.equal(300)
    })

    it('gives the coin node its own flush budget without reading service stop settings', async function () {
        const stop = sinon.stub().resolves({ stopped: true, seconds: 4, killed: false, exitCode: 0 })
        const read = sinon.stub().resolves(null)
        await sbs.restartModuleContainer(stop, sinon.stub().resolves(true), 'node', 'bitcoin', 'mainnet', 'n1', {}, read)
        expect(stop.firstCall.args[1]).to.equal(require('../../src/services/node_service').nodeStopTimeoutSeconds())
        expect(read.called).to.equal(false)
    })

    it('returns the stop outcome, so a restart that ended in a kill is visible', async function () {
        const stop = sinon.stub().resolves({ stopped: true, seconds: 120, killed: true, exitCode: 137 })
        const outcome = await sbs.restartModuleContainer(stop, sinon.stub().resolves(true), 'xchain-decoder', 'bitcoin',
            'mainnet', 'abc123', {}, null)
        expect(outcome.killed).to.equal(true)
        expect(outcome.budget).to.equal(120)
        expect(warnStub.args.some(a => /did not exit within the 120 s budget and was killed/.test(String(a[0])))).to.equal(true)
    })
})

describe('StopBudgetService restartModuleContainer() failures', function () {
    beforeEach(prepareConsoleStubs)
    afterEach(restoreConsoleStubs)

    it('says the service was stopped but did not start again when the start fails', async function () {
        const stop = sinon.stub().resolves({ stopped: true, seconds: 2, killed: false, exitCode: 0 })
        const start = sinon.stub().rejects(new Error('port is already allocated'))
        const err = await sbs.restartModuleContainer(stop, start, 'xchain-indexer', 'bitcoin', 'mainnet', 'i1', {}, null)
            .then(() => null, e => e)
        expect(err).to.be.an('error')
        expect(err.message).to.equal('xchain-indexer was stopped but failed to start again (port is already allocated)')
        expect(err.containerStopped).to.equal(true)
    })

    it('never starts a container whose stop failed, and passes docker\'s error through', async function () {
        const gone = new Error('Error response from daemon: No such container: i1')
        const stop = sinon.stub().rejects(gone)
        const start = sinon.stub().resolves(true)
        const err = await sbs.restartModuleContainer(stop, start, 'xchain-indexer', 'bitcoin', 'mainnet', 'i1', {}, null)
            .then(() => null, e => e)
        expect(err).to.equal(gone)
        expect(start.called).to.equal(false)
    })
})

describe('StopBudgetService restart callers', function () {
    it('leaves the unbudgeted docker restart primitive to the exited-hub restart alone', function () {
        const callers = listSourceFiles(SRC_DIR)
            .filter(rel => /\brestartContainer\(/.test(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')))
            .sort()
        expect(callers).to.deep.equal(['services/docker_service.js', 'services/hub_service.js'])
    })
})
