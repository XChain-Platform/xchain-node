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

    // A container a restart never fixes must not be restarted once per fixed
    // cooldown forever: that is pure churn, and the file's own header states it
    // must not be flapped indefinitely. Each restart that does not clear the
    // wedge doubles the next wait.
    it('doubles the cooldown for each restart that does not clear the wedge', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'bo1')])
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())

        await service.runAutoheal({ now: NOW })                      // restart #1
        await service.runAutoheal({ now: NOW + 11 * 60000 })         // restart #2, base cooldown
        expect(stubs.restartContainer.callCount).to.equal(2)

        // 11 minutes after restart #2 clears the BASE cooldown but not the doubled
        // one, so the old fixed-window behavior would have restarted here.
        const throttled = await service.runAutoheal({ now: NOW + 22 * 60000 })
        expect(stubs.restartContainer.callCount).to.equal(2)
        expect(throttled.skipped[0].reason).to.equal('inside restart cooldown')

        // 21 minutes after restart #2 clears the doubled window.
        const resumed = await service.runAutoheal({ now: NOW + 32 * 60000 })
        expect(stubs.restartContainer.callCount).to.equal(3)
        expect(resumed.restarted).to.have.length(1)

        const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'autoheal-state.json'), 'utf8'))
        expect(state.restartCount.bo1).to.equal(3)
    })
})
