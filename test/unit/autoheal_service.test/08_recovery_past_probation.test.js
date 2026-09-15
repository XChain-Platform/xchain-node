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

// Health.Log entry helper keyed to an ABSOLUTE start time, for fixtures whose
// probes sit around a pass timestamp other than NOW.
function recordedProbe(atMs, exitCode) {
    const start = new Date(atMs)
    return {
        Start: start.toISOString(),
        End: new Date(atMs + 1000).toISOString(),
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

    // A recovery-then-relapse that falls entirely between two passes reseeds the
    // episode onset, and the attempt count has to reset with it: a NEW episode that
    // inherits the old one's doubled cooldown sits at the ceiling, six hours of
    // suppression after the probes have proved the wedge cleared.
    it('drops the earned backoff when retained probes show a recovery past the restart probation', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'rec1')])
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())

        await service.runAutoheal({ now: NOW })                      // restart #1
        await service.runAutoheal({ now: NOW + 11 * 60000 })         // restart #2 -> next wait doubles
        expect(stubs.restartContainer.callCount).to.equal(2)

        // A pass 7 minutes after restart #2, far outside the 150s probation, then a
        // fresh failing run: the container recovered and relapsed between passes.
        const t3 = NOW + 22 * 60000
        stubs.getStatusFromContainer.resolves(inspectStatus('unhealthy', [
            recordedProbe(NOW + 18 * 60000, 0),
            recordedProbe(NOW + 21 * 60000, 1),
            recordedProbe(t3 - 15000, 1),
            recordedProbe(t3, 1)
        ]))
        const reseeded = await service.runAutoheal({ now: t3 })
        expect(reseeded.skipped[0].reason).to.equal('inside grace window')

        const cleared = JSON.parse(fs.readFileSync(path.join(stateDir, 'autoheal-state.json'), 'utf8'))
        expect(cleared.restartCount, 'a proven recovery ends the episode the backoff belonged to')
            .to.not.have.property('rec1')

        // 14 minutes after restart #2: past the BASE cooldown, inside the doubled
        // one. With the count dropped the new episode is restarted; had it survived,
        // the 20-minute window would still be blocking.
        stubs.getStatusFromContainer.resolves(unhealthyRingBuffer(NOW + 25 * 60000))
        const resumed = await service.runAutoheal({ now: NOW + 25 * 60000 })
        expect(resumed.restarted, 'the new episode must start at the base cooldown').to.have.length(1)
        expect(stubs.restartContainer.callCount).to.equal(3)
    })
})
