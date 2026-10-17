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

// Pins the autoheal restart to the service's stop budget. A bare `docker restart` gave an
// unstamped decoder docker's ten seconds, which SIGKILLs a drain waiting for a block boundary.

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

// Continuously unhealthy for ~10 minutes (well past the 2min default grace).
function unhealthyPastGrace() {
    return {
        State: {
            Status: 'running',
            Health: {
                Status: 'unhealthy',
                FailingStreak: 5,
                Log: [logEntry(11 * 60000, 0), logEntry(10 * 60000, 1), logEntry(5 * 60000, 1), logEntry(60000, 1)]
            }
        }
    }
}

function makeStubs() {
    return {
        db: { getAllModuleContainers: sinon.stub().resolves([]), assertReady: sinon.stub() },
        getStatusFromContainer: sinon.stub(),
        stopContainer: sinon.stub().resolves({ stopped: true, seconds: 1, killed: false, exitCode: 0 }),
        startContainer: sinon.stub().resolves(true),
        // An unstamped container: created before the stop budgets existed
        getContainerStopSettings: sinon.stub().resolves({ stopTimeout: null, shutdownTimeoutMs: null })
    }
}

function loadService(stubs) {
    return proxyquire('../../../src/services/autoheal_service', {
        '../state': { db: stubs.db },
        './docker_service': {
            getStatusFromContainer: stubs.getStatusFromContainer,
            stopContainer: stubs.stopContainer,
            startContainer: stubs.startContainer,
            getContainerStopSettings: stubs.getContainerStopSettings
        },
        './module_service': { SERVICE_HEALTHCHECK: require('../../../src/services/module_service').SERVICE_HEALTHCHECK }
    })
}

describe('AutohealService', () => {
    let stubs, service, stateDir, logStub, warnStub

    beforeEach(() => {
        stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoheal-test-'))
        process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR = stateDir
        stubs = makeStubs()
        service = loadService(stubs)
        logStub = sinon.stub(console, 'log')
        warnStub = sinon.stub(console, 'warn')
    })

    afterEach(() => {
        logStub.restore()
        warnStub.restore()
        delete process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR
        fs.rmSync(stateDir, { recursive: true, force: true })
    })

    it('restarts an unstamped decoder with its 120 s stop budget, then starts it', async () => {
        stubs.db.getAllModuleContainers.resolves([
            { module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet', container_id: 'dec1' }
        ])
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())

        const result = await service.runAutoheal({ now: NOW })

        expect(result.restarted).to.have.length(1)
        expect(stubs.stopContainer.calledOnceWith('dec1', 120)).to.equal(true)
        expect(stubs.startContainer.calledOnceWith('dec1')).to.equal(true)
        expect(stubs.stopContainer.calledBefore(stubs.startContainer)).to.equal(true)
    })

    it('reports a restart whose start failed after the stop, naming the stopped service', async () => {
        stubs.db.getAllModuleContainers.resolves([
            { module: 'xchain-indexer', coin: 'bitcoin', network: 'mainnet', container_id: 'idx1' }
        ])
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())
        stubs.startContainer.rejects(new Error('port is already allocated'))

        const result = await service.runAutoheal({ now: NOW })

        expect(result.restarted).to.have.length(0)
        expect(result.failed).to.have.length(1)
        expect(result.failed[0].reason).to.match(/xchain-indexer was stopped but failed to start again/)
    })
})
