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

function probe(atMs, exitCode) {
    const start = new Date(atMs)
    return {
        Start: start.toISOString(),
        End: new Date(atMs + 1000).toISOString(),
        ExitCode: exitCode,
        Output: exitCode === 0 ? 'ok' : 'wget: server returned error'
    }
}

function inspectStatus(healthStatus, log) {
    return {
        State: {
            Status: 'running',
            Health: { Status: healthStatus, FailingStreak: healthStatus === 'unhealthy' ? 5 : 0, Log: log }
        }
    }
}

// Continuously unhealthy for about ten minutes, well past the default grace.
function unhealthyPastGrace() {
    return inspectStatus('unhealthy', [11, 10, 5, 1].map((m, i) => probe(NOW - m * 60000, i === 0 ? 0 : 1)))
}

function unhealthyRingBuffer(at) {
    return inspectStatus('unhealthy', [60000, 45000, 30000, 15000, 0]
        .map(offset => probe(at - offset, 1)))
}

function registryRow(module, containerId) {
    return { module, coin: 'bitcoin', network: 'regtest', container_id: containerId }
}

// Fresh state directory and stubbed Docker per test; the returned object is filled in beforeEach.
function useAutoheal() {
    const ctx = {}
    beforeEach(() => {
        ctx.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoheal-progress-'))
        process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR = ctx.stateDir
        ctx.stubs = {
            db: { getAllModuleContainers: sinon.stub().resolves([]), assertReady: sinon.stub() },
            getStatusFromContainer: sinon.stub(),
            stopContainer: sinon.stub().resolves({ stopped: true, seconds: 1, killed: false, exitCode: 0 }),
            startContainer: sinon.stub().resolves(true)
        }
        ctx.service = proxyquire('../../../../src/services/autoheal_service', {
            '../state': { db: ctx.stubs.db },
            './docker_service': {
                getStatusFromContainer: ctx.stubs.getStatusFromContainer,
                stopContainer: ctx.stubs.stopContainer,
                startContainer: ctx.stubs.startContainer,
                getContainerStopSettings: sinon.stub().resolves(null)
            },
            './module_service': { SERVICE_HEALTHCHECK: require('../../../../src/services/module_service').SERVICE_HEALTHCHECK }
        })
        ctx.logStub = sinon.stub(console, 'log')
    })
    afterEach(() => {
        ctx.logStub.restore()
        delete process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR
        fs.rmSync(ctx.stateDir, { recursive: true, force: true })
    })
    return ctx
}

// Restart the container once, then run a pass whose newest passing probe sits past probation.
async function restartThenProbe(ctx, module, payload, id = 'progress1') {
    ctx.stubs.db.getAllModuleContainers.resolves([registryRow(module, id)])
    ctx.stubs.getStatusFromContainer.resolves(unhealthyPastGrace())
    await ctx.service.runAutoheal({ now: NOW })
    ctx.stubs.getStatusFromContainer.resolves(inspectStatus('healthy', [probe(NOW + 4 * 60000, 0)]))
    const readIndexerStatus = sinon.stub().resolves(payload)
    const result = await ctx.service.runAutoheal({ now: NOW + 5 * 60000, readIndexerStatus })
    const state = JSON.parse(fs.readFileSync(path.join(ctx.stateDir, 'autoheal-state.json'), 'utf8'))
    return { id, result, state, readIndexerStatus }
}

describe('Autoheal indexer progress after a restart', () => {
    const ctx = useAutoheal()

    it('escalates a healthy indexer that made no progress after its restart', async () => {
        const h = await restartThenProbe(ctx, 'xchain-indexer', {
            ready: false, lastBlockCommittedAt: null,
            stallReason: 'sync_barrier', notReadyReasons: ['no_recent_commit'],
        })
        expect(h.result.restarted).to.deep.equal([])
        expect(h.result.escalated).to.deep.equal([{
            module: 'xchain-indexer', coin: 'bitcoin', network: 'regtest', containerId: h.id, attempts: 1,
        }])
        expect(h.state.restartCount[h.id]).to.equal(1)
        expect(ctx.stubs.startContainer.callCount, 'escalation must not restart again').to.equal(1)
        expect(ctx.service.autohealExitCode(h.result)).to.equal(2)
    })

    it('clears the count when an indexer committed after its restart', async () => {
        const h = await restartThenProbe(ctx, 'xchain-indexer', {
            ready: false, lastBlockCommittedAt: NOW + 4 * 60000, stallReason: 'sync_barrier',
        })
        expect(h.result.escalated).to.deep.equal([])
        expect(h.state.restartCount).to.not.have.property(h.id)
    })

    it('clears the count for a ready indexer and for an older payload', async () => {
        const ready = await restartThenProbe(ctx, 'xchain-indexer', { ready: true, lastBlockCommittedAt: null }, 'ready1')
        expect(ready.state.restartCount).to.not.have.property(ready.id)
        const fallback = await restartThenProbe(ctx, 'xchain-indexer', { isSynced: true }, 'fallback1')
        expect(fallback.state.restartCount).to.not.have.property(fallback.id)
    })

    it('keeps the count without escalating when the indexer body is unreadable', async () => {
        const h = await restartThenProbe(ctx, 'xchain-indexer', null)
        expect(h.result.escalated).to.deep.equal([])
        expect(h.state.restartCount[h.id]).to.equal(1)
        expect(ctx.service.autohealExitCode(h.result)).to.equal(0)
    })

    it('keeps reseeded indexer history without progress and preserves cooldown escalation', async () => {
        const id = 'relapsed1'
        const stateFile = path.join(ctx.stateDir, 'autoheal-state.json')
        fs.writeFileSync(stateFile, JSON.stringify({
            restarts: { [id]: NOW },
            unhealthySince: { [id]: NOW - 10 * 60000 },
            restartCount: { [id]: 3 },
            stoppedByAutoheal: {}
        }))
        ctx.stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', id)])
        const reseedAt = NOW + 22 * 60000
        ctx.stubs.getStatusFromContainer.resolves(inspectStatus('unhealthy', [
            probe(NOW + 18 * 60000, 0), probe(NOW + 21 * 60000, 1), probe(reseedAt, 1)
        ]))
        const readIndexerStatus = sinon.stub().resolves(null)
        await ctx.service.runAutoheal({ now: reseedAt, readIndexerStatus })
        const retained = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        expect(retained.restartCount[id]).to.equal(3)
        expect(readIndexerStatus.calledOnce).to.equal(true)

        const cooldownAt = NOW + 32 * 60000
        ctx.stubs.getStatusFromContainer.resolves(unhealthyRingBuffer(cooldownAt))
        const result = await ctx.service.runAutoheal({ now: cooldownAt, readIndexerStatus })
        expect(result.skipped.some(entry => entry.reason === 'inside restart cooldown')).to.equal(true)
        expect(result.escalated).to.deep.equal([{
            module: 'xchain-indexer', coin: 'bitcoin', network: 'regtest', containerId: id, attempts: 3
        }])
        expect(ctx.stubs.startContainer.called).to.equal(false)
        expect(ctx.service.autohealExitCode(result)).to.equal(2)
    })
})

describe('Autoheal indexer status reads', () => {
    const ctx = useAutoheal()

    it('does not read a status body for another module', async () => {
        const h = await restartThenProbe(ctx, 'xchain-decoder', null, 'decoder1')
        expect(h.readIndexerStatus.called).to.equal(false)
        expect(h.state.restartCount).to.not.have.property(h.id)
    })

    it('does not read an indexer status body inside restart probation', async () => {
        ctx.stubs.db.getAllModuleContainers.resolves([registryRow('xchain-indexer', 'probation1')])
        ctx.stubs.getStatusFromContainer.resolves(unhealthyPastGrace())
        await ctx.service.runAutoheal({ now: NOW })
        ctx.stubs.getStatusFromContainer.resolves(inspectStatus('healthy', [probe(NOW + 30000, 0)]))
        const readIndexerStatus = sinon.stub().resolves({ ready: false, lastBlockCommittedAt: null })
        await ctx.service.runAutoheal({ now: NOW + 60000, readIndexerStatus })
        expect(readIndexerStatus.called).to.equal(false)
    })

    it('classifies indexer recovery evidence without treating an unreadable body as recovered', () => {
        const classify = ctx.service.classifyIndexerRecovery
        expect(classify(null, NOW)).to.equal('unknown')
        expect(classify({ isSynced: true }, NOW)).to.equal('fallback')
        expect(classify({ ready: false, lastBlockCommittedAt: null }, NOW)).to.equal('stuck')
        expect(classify({ ready: true, stallReason: null }, NOW)).to.equal('recovered')
        expect(classify({ ready: true, stallReason: 'sync_barrier' }, NOW)).to.equal('unknown')
        expect(classify({ ready: false, lastBlockCommittedAt: NOW + 1 }, NOW)).to.equal('recovered')
        expect(classify({ ready: false, lastBlockCommittedAt: new Date(NOW - 1).toISOString() }, NOW)).to.equal('stuck')
    })

    it('reads the indexer status route on the configured API port', async () => {
        const probeReadinessSurface = sinon.stub().resolves({ ready: true })
        const getDefaultConfig = sinon.stub().resolves({ INDEXER_API_PORT: 8282 })
        const recovery = proxyquire('../../../../src/services/autoheal_service/indexer_recovery.js', {
            '../config_service': { getDefaultConfig },
            '../bootstrap_health_gate': { probeReadinessSurface, MODULE_API_PORT_KEY: { 'xchain-indexer': 'INDEXER_API_PORT' } }
        })
        const candidate = { module: 'xchain-indexer', coin: 'bitcoin', network: 'regtest', containerId: 'c1' }
        expect(await recovery.defaultReadIndexerStatus(candidate)).to.deep.equal({ ready: true })
        expect(getDefaultConfig.calledWith('xchain-indexer', 'bitcoin', 'regtest')).to.equal(true)
        expect(probeReadinessSurface.firstCall.args.slice(0, 3)).to.deep.equal(['c1', 8282, '/status'])
        getDefaultConfig.resolves({})
        expect(await recovery.defaultReadIndexerStatus(candidate)).to.equal(null)
    })
})
