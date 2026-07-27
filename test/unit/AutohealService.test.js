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

// docker-inspect shape for a container in a given health state.
function inspectStatus(healthStatus, log) {
    return {
        State: {
            Status: 'running',
            Health: { Status: healthStatus, FailingStreak: healthStatus === 'unhealthy' ? 5 : 0, Log: log }
        }
    }
}

// Continuously unhealthy for ~10 minutes (well past the 2min default grace).
function unhealthyPastGrace() {
    return inspectStatus('unhealthy', [logEntry(11 * 60000, 0), logEntry(10 * 60000, 1), logEntry(5 * 60000, 1), logEntry(60000, 1)])
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
    return proxyquire('../../src/services/AutohealService', {
        '../state': { db: stubs.db },
        './DockerService': {
            getStatusFromContainer: stubs.getStatusFromContainer,
            restartContainer: stubs.restartContainer
        },
        // Real descriptor table: asserts the actual opt-in flags too.
        './ModuleService': { SERVICE_HEALTHCHECK: require('../../src/services/ModuleService').SERVICE_HEALTHCHECK }
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

    // : an unconfigured store answers [] rather than erroring, so autoheal
    // would sweep zero candidates and report a clean run while every unhealthy
    // container stayed down. A watchdog that cannot read its registry must say so.
    it('refuses to run against an unconfigured module registry', async () => {
        stubs.db.assertReady.throws(new Error('MariaDbStore is not connected'))

        let err = null
        try { await service.runAutoheal({ now: NOW }) } catch (e) { err = e }

        expect(err, 'autoheal must not report a clean sweep it never performed').to.not.equal(null)
        expect(err.message).to.match(/not connected/)
        expect(stubs.db.getAllModuleContainers.called).to.equal(false)
    })

    it('restarts an unhealthy container whose service opted in (autoheal: true)', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'aaa')])
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())

        const result = await service.runAutoheal({ now: NOW })

        expect(stubs.restartContainer.calledOnceWith('aaa')).to.equal(true)
        expect(result.restarted).to.have.length(1)
        expect(result.failed).to.have.length(0)
    })

    it('does NOT restart an unhealthy container whose service is not opted in (utxo-tracker)', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-utxo-tracker', 'bbb')])
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())

        const result = await service.runAutoheal({ now: NOW })

        expect(stubs.restartContainer.called).to.equal(false)
        expect(result.candidates).to.have.length(0)
    })

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

    it('does NOT restart the same container twice within the cooldown window', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'eee')])
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())

        const first = await service.runAutoheal({ now: NOW })
        expect(first.restarted).to.have.length(1)

        // Second pass 3 minutes later, container still unhealthy: cooldown
        // (default 10min) must block the repeat restart.
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())
        const second = await service.runAutoheal({ now: NOW + 3 * 60000 })

        expect(stubs.restartContainer.callCount).to.equal(1)
        expect(second.skipped[0].reason).to.equal('inside restart cooldown')
    })

    it('restarts again once the cooldown window has elapsed', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'fff')])
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())

        await service.runAutoheal({ now: NOW })
        const later = await service.runAutoheal({ now: NOW + 11 * 60000 })

        expect(stubs.restartContainer.callCount).to.equal(2)
        expect(later.restarted).to.have.length(1)
    })

    it('--dry-run reports candidates without restarting or arming the cooldown', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'ggg')])
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())

        const dry = await service.runAutoheal({ dryRun: true, now: NOW })
        expect(dry.candidates).to.have.length(1)
        expect(dry.restarted).to.have.length(0)
        expect(stubs.restartContainer.called).to.equal(false)

        // A real pass right after must still restart (dry run wrote no state).
        const real = await service.runAutoheal({ now: NOW })
        expect(real.restarted).to.have.length(1)
    })

    it('skips (does not restart) when the health log gives no timing evidence', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'hhh')])
        stubs.getStatusFromContainer.resolves(inspectStatus('unhealthy', []))

        const result = await service.runAutoheal({ now: NOW })

        expect(stubs.restartContainer.called).to.equal(false)
        expect(result.skipped[0].reason).to.match(/no failing probe log/)
    })

    it('records a failed restart without aborting the pass and reports it', async () => {
        stubs.db.getAllModuleContainers.resolves([
            registryRow('xchain-indexer', 'iii'),
            { module: 'xchain-decoder', coin: 'litecoin', network: 'regtest', container_id: 'jjj' }
        ])
        stubs.getStatusFromContainer.resolves(unhealthyPastGrace())
        stubs.restartContainer.withArgs('iii').rejects(new Error('docker daemon gone'))
        stubs.restartContainer.withArgs('jjj').resolves(true)

        const result = await service.runAutoheal({ now: NOW })

        expect(result.failed).to.have.length(1)
        expect(result.failed[0].containerId).to.equal('iii')
        expect(result.restarted).to.have.length(1)
        expect(result.restarted[0].containerId).to.equal('jjj')
    })

    it('skips a container that cannot be inspected instead of failing the pass', async () => {
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'kkk')])
        stubs.getStatusFromContainer.rejects(new Error('No such container'))

        const result = await service.runAutoheal({ now: NOW })

        expect(result.skipped[0].reason).to.equal('inspect failed')
        expect(result.failed).to.have.length(0)
    })

    it('honors XCHAIN_NODE_AUTOHEAL_GRACE_MS override', async () => {
        process.env.XCHAIN_NODE_AUTOHEAL_GRACE_MS = '10000' // 10s grace
        stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'lll')])
        stubs.getStatusFromContainer.resolves(unhealthyInsideGrace()) // unhealthy for ~30s

        const result = await service.runAutoheal({ now: NOW })
        expect(result.restarted).to.have.length(1)
    })

    describe('getUnhealthySinceMs', () => {
        it('returns the start of the trailing failing run', () => {
            const health = unhealthyPastGrace().State.Health
            expect(service.getUnhealthySinceMs(health)).to.equal(NOW - 10 * 60000)
        })

        it('returns null when the newest probe passed', () => {
            const health = inspectStatus('healthy', [logEntry(30000, 1), logEntry(15000, 0)]).State.Health
            expect(service.getUnhealthySinceMs(health)).to.equal(null)
        })

        it('returns null on an empty log', () => {
            expect(service.getUnhealthySinceMs({ Log: [] })).to.equal(null)
        })
    })

    describe('SERVICE_HEALTHCHECK opt-in flags', () => {
        const { SERVICE_HEALTHCHECK } = require('../../src/services/ModuleService')

        it('xchain-utxo-tracker is never opted in (deliberate stable-halt design)', () => {
            expect(SERVICE_HEALTHCHECK['xchain-utxo-tracker'].autoheal).to.equal(undefined)
        })

        it('xchain-indexer is opted in', () => {
            expect(SERVICE_HEALTHCHECK['xchain-indexer'].autoheal).to.equal(true)
        })
    })
})
