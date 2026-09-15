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

// What Docker ACTUALLY exposes for a long-wedged container: Health.Log is capped
// at 5 entries and every descriptor probes at 15s, so a container wedged for an
// hour still shows only the last ~60s, all failures, sliding forward with `at`.
// The unhealthyPastGrace fixture above (entries 11 minutes apart) is a shape a
// real 15s ring buffer can never produce, which is why it hid this bug.
function unhealthyRingBuffer(at) {
    return inspectStatus('unhealthy', [60000, 45000, 30000, 15000, 0].map(ms => {
        const start = new Date(at - ms)
        return {
            Start: start.toISOString(),
            End: new Date(start.getTime() + 1000).toISOString(),
            ExitCode: 1,
            Output: 'wget: server returned error'
        }
    }))
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

    // Docker keeps 5 Health.Log entries, the probes are 15s apart, so the
    // log-derived onset never gets more than ~60s back and slides forward
    // with every pass. Timing the 120s grace off it makes autoheal a permanent
    // no-op. The onset must be persisted on first sighting.
    it('restarts a container wedged past the grace window even though Health.Log only spans ~60s', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'ring')])

        // First pass: the whole ring buffer is already failing, but only ~60s of
        // it is visible, so the grace window is not crossed yet.
        stubs.getStatusFromContainer.resolves(unhealthyRingBuffer(NOW))
        const first = await service.runAutoheal({ now: NOW })
        expect(first.restarted).to.have.length(0)
        expect(first.skipped[0].reason).to.equal('inside grace window')

        // Three minutes later the container is still wedged. Docker's log still
        // shows only the last ~60s; the persisted onset is what crosses the grace.
        stubs.getStatusFromContainer.resolves(unhealthyRingBuffer(NOW + 3 * 60000))
        const second = await service.runAutoheal({ now: NOW + 3 * 60000 })
        expect(second.restarted, 'a sustained wedge must eventually be restarted').to.have.length(1)
        expect(stubs.restartContainer.calledOnceWith('ring')).to.equal(true)
    })
})
