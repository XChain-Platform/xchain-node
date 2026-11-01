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

const fs         = require('fs')
const os         = require('os')
const path       = require('path')
const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const NOW = Date.parse('2026-07-21T12:00:00Z')

// Health.Log entry helper: a probe that started `agoMs` before NOW.
function logEntry(agoMs, exitCode) {
    const start = new Date(NOW - agoMs)
    return {
        Start: start.toISOString(),
        End: new Date(start.getTime() + 1000).toISOString(),
        ExitCode: exitCode,
        Output: exitCode === 0 ? 'ok' : 'wget: server returned error'
    }
}

// docker-inspect shape for a container in a given health state. `runState` is
// State.Status and defaults to 'running'; pass 'exited' to model what Docker
// reports for a STOPPED container, whose Health.Status stays frozen at whatever
// it read the moment the container went down.
function inspectStatus(healthStatus, log, runState) {
    return {
        State: {
            Status: runState || 'running',
            Health: { Status: healthStatus, FailingStreak: healthStatus === 'unhealthy' ? 5 : 0, Log: log }
        }
    }
}

// Continuously unhealthy for ~10 minutes (well past the 2min default grace).
function unhealthyPastGrace() {
    return inspectStatus('unhealthy', [logEntry(11 * 60000, 0), logEntry(10 * 60000, 1), logEntry(5 * 60000, 1), logEntry(60000, 1)])
}

function makeStubs() {
    return {
        db: { getAllModuleContainers: sinon.stub().resolves([]), assertReady: sinon.stub() },
        getStatusFromContainer: sinon.stub(),
        stopContainer: sinon.stub().resolves({ stopped: true, seconds: 1, killed: false, exitCode: 0 }),
        startContainer: sinon.stub().resolves(true)
    }
}

function loadService(stubs) {
    return proxyquire('../../../src/services/autoheal_service', {
        '../state': { db: stubs.db },
        './docker_service': {
            getStatusFromContainer: stubs.getStatusFromContainer,
            stopContainer: stubs.stopContainer,
            startContainer: stubs.startContainer,
            getContainerStopSettings: sinon.stub().resolves(null)
        },
        // Real descriptor table: asserts the actual opt-in flags too.
        './module_service': { SERVICE_HEALTHCHECK: require('../../../src/services/module_service').SERVICE_HEALTHCHECK }
    })
}

function restartErrorHarness() {
    const h = {}
    beforeEach(() => {
        h.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoheal-test-'))
        process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR = h.stateDir
        h.stubs = makeStubs()
        h.service = loadService(h.stubs)
        h.logStub = sinon.stub(console, 'log')
    })
    afterEach(() => {
        h.logStub.restore()
        delete process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR
        delete process.env.XCHAIN_NODE_AUTOHEAL_GRACE_MS
        delete process.env.XCHAIN_NODE_AUTOHEAL_COOLDOWN_MS
        fs.rmSync(h.stateDir, { recursive: true, force: true })
    })
    return h
}

function registryRow(module, containerId) {
    return { module, coin: 'bitcoin', network: 'regtest', container_id: containerId }
}

describe('AutohealService', () => {
    const h = restartErrorHarness()

    it('records a failed restart without aborting the pass and reports it', async () => {
        h.stubs.db.getAllModuleContainers.resolves([
            registryRow('xchain-indexer', 'iii'),
            { module: 'xchain-decoder', coin: 'litecoin', network: 'regtest', container_id: 'jjj' }
        ])
        h.stubs.getStatusFromContainer.resolves(unhealthyPastGrace())
        h.stubs.stopContainer.withArgs('iii').rejects(new Error('docker daemon gone'))
        h.stubs.stopContainer.withArgs('jjj').resolves({ stopped: true, seconds: 1, killed: false, exitCode: 0 })

        const result = await h.service.runAutoheal({ now: NOW })

        expect(result.failed).to.have.length(1)
        expect(result.failed[0].containerId).to.equal('iii')
        expect(result.restarted).to.have.length(1)
        expect(result.restarted[0].containerId).to.equal('jjj')
    })

    it('skips a container that cannot be inspected instead of failing the pass', async () => {
        h.stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'kkk')])
        h.stubs.getStatusFromContainer.rejects(new Error('No such container'))

        const result = await h.service.runAutoheal({ now: NOW })

        expect(result.skipped[0].reason).to.equal('inspect failed')
        expect(result.failed).to.have.length(0)
    })
})

describe('AutohealService', () => {
    const h = restartErrorHarness()

    it('retries only the start after a failed restart left the container stopped', async () => {
        h.stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'left-down')])
        h.stubs.getStatusFromContainer.onFirstCall().resolves(unhealthyPastGrace())
        h.stubs.getStatusFromContainer.onSecondCall().resolves(inspectStatus('unhealthy', [], 'exited'))
        h.stubs.startContainer.onFirstCall().rejects(new Error('port is already allocated'))
        h.stubs.startContainer.onSecondCall().resolves(true)

        const failed = await h.service.runAutoheal({ now: NOW })
        const stateAfterFailure = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'autoheal-state.json'), 'utf8'))
        const recovered = await h.service.runAutoheal({ now: NOW + 1000, resumeStopped: true })

        expect(failed.failed).to.have.length(1)
        expect(stateAfterFailure.stoppedByAutoheal['left-down']).to.equal(true)
        expect(h.stubs.stopContainer.calledOnce).to.equal(true)
        expect(h.stubs.startContainer.callCount).to.equal(2)
        expect(recovered.restarted[0].containerId).to.equal('left-down')
        const finalState = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'autoheal-state.json'), 'utf8'))
        expect(finalState.stoppedByAutoheal).to.not.have.property('left-down')
    })

    it('escalates a left-down container without overriding operator intent', async () => {
        h.stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'left-down')])
        h.stubs.getStatusFromContainer.onFirstCall().resolves(unhealthyPastGrace())
        h.stubs.getStatusFromContainer.onSecondCall().resolves(inspectStatus('unhealthy', [], 'exited'))
        h.stubs.startContainer.rejects(new Error('port is already allocated'))

        await h.service.runAutoheal({ now: NOW })
        const unattended = await h.service.runAutoheal({ now: NOW + 1000 })
        const state = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'autoheal-state.json'), 'utf8'))

        expect(h.stubs.stopContainer.calledOnce).to.equal(true)
        expect(h.stubs.startContainer.calledOnce).to.equal(true)
        expect(unattended.escalated[0].containerId).to.equal('left-down')
        expect(h.service.autohealExitCode(unattended)).to.equal(2)
        expect(state.stoppedByAutoheal['left-down']).to.equal(true)
    })
})
