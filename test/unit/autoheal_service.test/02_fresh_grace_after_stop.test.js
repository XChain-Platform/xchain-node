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

    // The grace clock must not keep running while the container is down: a
    // container started again after an operator stop gets a full grace window to
    // come back, not an instant restart off a clock from before the stop.
    it('drops the episode onset while a container is stopped, so a restarted one gets a fresh grace window', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'stp2')])

        // Pass 1: unhealthy and running, inside grace - the onset gets recorded.
        stubs.getStatusFromContainer.resolves(unhealthyInsideGrace())
        await service.runAutoheal({ now: NOW })

        // Pass 2: the operator has stopped it; health stays frozen at unhealthy.
        stubs.getStatusFromContainer.resolves(stoppedWithFrozenUnhealthy())
        await service.runAutoheal({ now: NOW + 60000 })

        // Pass 3, an hour later: running again, and unhealthy from a probe that
        // only started failing 30s ago. With the pre-stop onset still on file
        // this reads as an hour-long episode and restarts immediately.
        const at = NOW + 60 * 60000
        const freshFailure = {
            Start: new Date(at - 30000).toISOString(),
            End: new Date(at - 29000).toISOString(),
            ExitCode: 1,
            Output: 'wget: server returned error'
        }
        stubs.getStatusFromContainer.resolves(inspectStatus('unhealthy', [freshFailure]))
        const third = await service.runAutoheal({ now: at })

        expect(stubs.restartContainer.called).to.equal(false)
        expect(third.skipped[0].reason).to.equal('inside grace window')
    })
})
