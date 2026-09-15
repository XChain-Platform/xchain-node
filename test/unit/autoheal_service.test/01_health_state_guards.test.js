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

// An operator stopped this container while it was unhealthy: State.Status is
// 'exited' and Health.Status is frozen at the last value the probe read, well
// past the grace window. Docker keeps answering `docker inspect` for it.
function stoppedWithFrozenUnhealthy() {
    return inspectStatus('unhealthy', [logEntry(11 * 60000, 0), logEntry(10 * 60000, 1), logEntry(5 * 60000, 1), logEntry(60000, 1)], 'exited')
}

// Unhealthy, but the failing run only started 30s ago.
function unhealthyInsideGrace() {
    return inspectStatus('unhealthy', [logEntry(90000, 0), logEntry(30000, 1), logEntry(15000, 1)])
}

function makeStubs() {
    return {
        db: { getAllModuleContainers: sinon.stub().resolves([]), assertReady: sinon.stub() },
        getStatusFromContainer: sinon.stub(),
        restartContainer: sinon.stub().resolves(true)
    }
}

function loadService(stubs) {
    return proxyquire('../../../src/services/autoheal_service', {
        '../state': { db: stubs.db },
        './docker_service': {
            getStatusFromContainer: stubs.getStatusFromContainer,
            restartContainer: stubs.restartContainer
        },
        // Real descriptor table: asserts the actual opt-in flags too.
        './module_service': { SERVICE_HEALTHCHECK: require('../../../src/services/module_service').SERVICE_HEALTHCHECK }
    })
}

describe('AutohealService', () => {
    let stubs, service, stateDir, logStub

    beforeEach(() => {
        stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoheal-test-'))
        process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR = stateDir
        stubs = makeStubs()
        service = loadService(stubs)
        logStub = sinon.stub(console, 'log')
    })

    afterEach(() => {
        logStub.restore()
        delete process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR
        delete process.env.XCHAIN_NODE_AUTOHEAL_GRACE_MS
        delete process.env.XCHAIN_NODE_AUTOHEAL_COOLDOWN_MS
        fs.rmSync(stateDir, { recursive: true, force: true })
    })

    function registryRow(module, containerId) {
        return { module, coin: 'bitcoin', network: 'regtest', container_id: containerId }
    }

    it('does NOT restart while still inside the grace window', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'ccc')])
        stubs.getStatusFromContainer.resolves(unhealthyInsideGrace())

        const result = await service.runAutoheal({ now: NOW })

        expect(stubs.restartContainer.called).to.equal(false)
        expect(result.skipped[0].reason).to.equal('inside grace window')
    })

    it('does NOT restart a healthy container', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'ddd')])
        stubs.getStatusFromContainer.resolves(inspectStatus('healthy', [logEntry(30000, 0)]))

        const result = await service.runAutoheal({ now: NOW })

        expect(stubs.restartContainer.called).to.equal(false)
        expect(result.candidates).to.have.length(0)
    })

    // Docker freezes Health.Status when a container stops, so a container an
    // operator deliberately stopped while it was unhealthy still reads
    // `unhealthy` forever. Restarting on that reading STARTS the container the
    // operator just pulled out of rotation.
    it('does NOT restart a container an operator stopped, whose health is frozen at unhealthy', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'stp')])
        stubs.getStatusFromContainer.resolves(stoppedWithFrozenUnhealthy())

        const result = await service.runAutoheal({ now: NOW })

        expect(stubs.restartContainer.called).to.equal(false)
        expect(result.candidates).to.have.length(0)
        expect(result.skipped[0].reason).to.equal('not running (state: exited)')
    })
})
