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

    // A recovery that falls entirely BETWEEN two passes is never seen by the
    // `!== unhealthy` branch, so the persisted onset survives it. The relapsed
    // episode then inherits the old episode's clock and is restarted inside its
    // own grace window. The retained probes carry the evidence: a pass newer
    // than the recorded onset.
    it('restarts the grace clock when retained probes show a recovery after the persisted onset', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'relapse')])

        stubs.getStatusFromContainer.resolves(unhealthyRingBuffer(NOW))
        const first = await service.runAutoheal({ now: NOW })
        expect(first.restarted).to.have.length(0)

        // Five minutes on. The container passed a probe 45s ago and has been
        // failing for 30s since: a NEW episode, well inside the 120s grace.
        const later = NOW + 5 * 60000
        stubs.getStatusFromContainer.resolves(inspectStatus('unhealthy', [
            recordedProbe(later - 45000, 0),
            recordedProbe(later - 30000, 1),
            recordedProbe(later - 15000, 1),
            recordedProbe(later, 1)
        ]))
        const second = await service.runAutoheal({ now: later })

        expect(stubs.restartContainer.called, 'a relapse must serve its own grace window').to.equal(false)
        expect(second.skipped[0].reason).to.equal('inside grace window')

        const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'autoheal-state.json'), 'utf8'))
        expect(state.unhealthySince.relapse, 'the onset must be reseeded to the new episode').to.equal(later - 30000)
    })
})
