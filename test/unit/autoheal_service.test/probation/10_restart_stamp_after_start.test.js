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
const RESTART_MS = 120000

function unhealthyPastGrace() {
    const entry = (agoMs, exitCode) => {
        const start = new Date(NOW - agoMs)
        return { Start: start.toISOString(), End: new Date(start.getTime() + 1000).toISOString(), ExitCode: exitCode, Output: 'x' }
    }
    return {
        State: {
            Status: 'running',
            Health: { Status: 'unhealthy', FailingStreak: 5, Log: [entry(11 * 60000, 0), entry(10 * 60000, 1), entry(5 * 60000, 1), entry(60000, 1)] }
        }
    }
}

describe('AutohealService restart stamp', () => {
    let clock, stateDir, logStub, service, stubs

    beforeEach(() => {
        stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoheal-test-'))
        process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR = stateDir
        clock = sinon.useFakeTimers({ now: NOW, toFake: ['Date'] })
        logStub = sinon.stub(console, 'log')
        stubs = {
            db: { getAllModuleContainers: sinon.stub().resolves([
                { module: 'xchain-indexer', coin: 'bitcoin', network: 'regtest', container_id: 'a1' },
                { module: 'xchain-indexer', coin: 'dogecoin', network: 'regtest', container_id: 'b1' }
            ]), assertReady: sinon.stub() },
            getStatusFromContainer: sinon.stub().callsFake(async () => unhealthyPastGrace()),
            // A slow drain: the stop consumes RESTART_MS of wall time.
            stopContainer: sinon.stub().callsFake(async () => {
                clock.tick(RESTART_MS)
                return { stopped: true, seconds: 120, killed: true, exitCode: 137 }
            }),
            startContainer: sinon.stub().resolves(true)
        }
        service = proxyquire('../../../../src/services/autoheal_service', {
            '../state': { db: stubs.db },
            './docker_service': {
                getStatusFromContainer: stubs.getStatusFromContainer,
                stopContainer: stubs.stopContainer,
                startContainer: stubs.startContainer,
                getContainerStopSettings: sinon.stub().resolves(null)
            },
            './module_service': { SERVICE_HEALTHCHECK: require('../../../../src/services/module_service').SERVICE_HEALTHCHECK }
        })
    })

    afterEach(() => {
        clock.restore()
        logStub.restore()
        delete process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR
        fs.rmSync(stateDir, { recursive: true, force: true })
    })

    const readState = () => JSON.parse(fs.readFileSync(path.join(stateDir, 'autoheal-state.json'), 'utf8'))

    it('stamps each restart after its own stop and start, not at pass start', async () => {
        await service.runAutoheal({ now: NOW })
        expect(stubs.startContainer.callCount).to.equal(2)

        const state = readState()
        expect(state.restarts.a1).to.be.at.least(NOW + RESTART_MS)
        expect(state.restarts.b1).to.be.at.least(NOW + 2 * RESTART_MS)
        expect(state.restarts.b1).to.be.greaterThan(state.restarts.a1)
    })

    it('runs the cooldown from the finished restart', async () => {
        await service.runAutoheal({ now: NOW })
        // 600s default cooldown: pass-start stamp would expire at NOW+600000.
        const throttled = await service.runAutoheal({ now: NOW + 650000 })
        expect(stubs.startContainer.callCount).to.equal(2)
        expect(throttled.skipped.map(s => s.reason)).to.include('inside restart cooldown')
    })
})
