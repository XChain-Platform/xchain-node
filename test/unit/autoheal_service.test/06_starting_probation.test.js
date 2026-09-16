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

    // `docker restart` puts the container into Docker's `starting` probation for the
    // descriptor's start period plus its retry budget, so a pass landing in that
    // window sees a status that is not 'unhealthy' and would read it as recovery,
    // wiping the very counter the restart it had just issued earned. A wedge no
    // restart clears then sat at the BASE cooldown forever.
    it('keeps the earned backoff when a restarted container is still in Docker starting probation', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'bo3')])
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())

        await service.runAutoheal({ now: NOW })                      // restart #1
        await service.runAutoheal({ now: NOW + 11 * 60000 })         // restart #2 -> next wait doubles
        expect(stubs.restartContainer.callCount).to.equal(2)

        // A minute after restart #2: Docker still reports `starting`.
        stubs.getStatusFromContainer.resolves(inspectStatus('starting', [logEntry(15000, 1)]))
        await service.runAutoheal({ now: NOW + 12 * 60000 })

        const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'autoheal-state.json'), 'utf8'))
        expect(state.restartCount.bo3, 'probation is not recovery; the backoff must survive it').to.equal(2)
        expect(state.unhealthySince, 'a restarted container still earns a fresh grace window').to.not.have.property('bo3')

        // Wedge returns 11 minutes after restart #2. The doubled 20-minute window is
        // still open, so nothing restarts; with the counter wiped it would have.
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())
        const throttled = await service.runAutoheal({ now: NOW + 22 * 60000 })
        expect(stubs.restartContainer.callCount).to.equal(2)
        expect(throttled.skipped[0].reason).to.equal('inside restart cooldown')
    })
})
