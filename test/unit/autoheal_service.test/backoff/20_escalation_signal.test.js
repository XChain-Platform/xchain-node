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

// A wedge two restarts did not clear is the "investigate" case the file header
// names as the escalation path, so it must reach something a timer can act on:
// a warn line on stderr and exit code 2, while a failed restart logs at error.

const fs         = require('fs')
const os         = require('os')
const path       = require('path')
const sinon      = require('sinon')
const { expect } = require('chai')
const { Command } = require('commander')
const proxyquire = require('proxyquire').noCallThru()

const NOW = Date.parse('2026-07-21T12:00:00Z')
const MIN = 60000

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
    const log = [logEntry(11 * MIN, 0), logEntry(10 * MIN, 1), logEntry(5 * MIN, 1), logEntry(MIN, 1)]
    return { State: { Status: 'running', Health: { Status: 'unhealthy', FailingStreak: 5, Log: log } } }
}

// Stubs both restart routes (a plain restart and a budgeted stop then start), so
// the escalation contract is pinned whichever one the service takes.
function makeStubs() {
    return {
        db: { getAllModuleContainers: sinon.stub().resolves([]), assertReady: sinon.stub() },
        getStatusFromContainer: sinon.stub(),
        restartContainer: sinon.stub().resolves(true),
        stopContainer: sinon.stub().resolves({ stopped: true, seconds: 1, killed: false, exitCode: 0 }),
        startContainer: sinon.stub().resolves(true)
    }
}

function loadService(stubs) {
    return proxyquire('../../../../src/services/autoheal_service', {
        '../state': { db: stubs.db },
        './docker_service': {
            getStatusFromContainer: stubs.getStatusFromContainer,
            restartContainer: stubs.restartContainer,
            stopContainer: stubs.stopContainer,
            startContainer: stubs.startContainer,
            getContainerStopSettings: sinon.stub().resolves(null)
        },
        './module_service': { SERVICE_HEALTHCHECK: require('../../../../src/services/module_service').SERVICE_HEALTHCHECK }
    })
}

// Each suite gets a fresh state dir, a wedged indexer row and silenced console sinks.
function escalationHarness() {
    const h = {}
    beforeEach(() => {
        h.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoheal-escalation-'))
        process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR = h.stateDir
        h.stubs = makeStubs()
        h.stubs.db.getAllModuleContainers.resolves([{ module: 'xchain-indexer', coin: 'bitcoin', network: 'regtest', container_id: 'esc1' }])
        h.stubs.getStatusFromContainer.resolves(unhealthyPastGrace())
        h.service = loadService(h.stubs)
        h.log = sinon.stub(console, 'log')
        h.warn = sinon.stub(console, 'warn')
        h.error = sinon.stub(console, 'error')
    })
    afterEach(() => {
        h.log.restore()
        h.warn.restore()
        h.error.restore()
        delete process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR
        fs.rmSync(h.stateDir, { recursive: true, force: true })
    })
    return h
}

// Restart #1 at NOW and #2 after the base cooldown, leaving attempts at 2.
async function twoRestartsThatDidNotClear(h) {
    const first = await h.service.runAutoheal({ now: NOW })
    const second = await h.service.runAutoheal({ now: NOW + 11 * MIN })
    expect(first.restarted.length + second.restarted.length).to.equal(2)
    expect(first.escalated.length + second.escalated.length).to.equal(0)
}

function warnedInvestigate(h) {
    return h.warn.getCalls().some(c => /investigate/.test(String(c.args[0])))
}

describe('AutohealService escalation', () => {
    const h = escalationHarness()

    it('escalates a wedge that outlived two restarts at warn and exit code 2', async () => {
        await twoRestartsThatDidNotClear(h)
        const throttled = await h.service.runAutoheal({ now: NOW + 22 * MIN })
        expect(throttled.skipped[0].reason).to.equal('inside restart cooldown')
        expect(throttled.escalated).to.have.length(1)
        expect(throttled.escalated[0]).to.include({ containerId: 'esc1', attempts: 2 })
        expect(warnedInvestigate(h)).to.be.true
        expect(h.service.autohealExitCode(throttled)).to.equal(2)
    })

    it('keeps the first restart cooldown an info line that does not escalate', async () => {
        await h.service.runAutoheal({ now: NOW })
        const first = await h.service.runAutoheal({ now: NOW + 5 * MIN })
        expect(first.skipped[0].reason).to.equal('inside restart cooldown')
        expect(first.escalated).to.deep.equal([])
        expect(h.warn.called).to.be.false
        expect(h.log.getCalls().some(c => /investigate/.test(String(c.args[0])))).to.be.true
        expect(h.service.autohealExitCode(first)).to.equal(0)
    })

    it('escalates on a restart #3 pass too, not only on a cooldown skip', async () => {
        await twoRestartsThatDidNotClear(h)
        const resumed = await h.service.runAutoheal({ now: NOW + 32 * MIN })
        expect(resumed.restarted).to.have.length(1)
        expect(resumed.escalated).to.have.length(1)
        expect(warnedInvestigate(h)).to.be.true
        expect(h.service.autohealExitCode(resumed)).to.equal(2)
    })

    it('reports the escalation on a dry run without restarting', async () => {
        await twoRestartsThatDidNotClear(h)
        const dry = await h.service.runAutoheal({ now: NOW + 32 * MIN, dryRun: true })
        expect(dry.restarted).to.deep.equal([])
        expect(dry.candidates).to.have.length(1)
        expect(dry.escalated).to.have.length(1)
    })
})

describe('AutohealService escalation', () => {
    const h = escalationHarness()

    it('logs a failed restart at error and exits 1', async () => {
        h.stubs.restartContainer.rejects(new Error('daemon gone'))
        h.stubs.startContainer.rejects(new Error('daemon gone'))
        const result = await h.service.runAutoheal({ now: NOW })
        expect(result.failed).to.have.length(1)
        expect(h.error.getCalls().some(c => /FAILED to restart/.test(String(c.args[0])))).to.be.true
        expect(h.service.autohealExitCode(result)).to.equal(1)
    })

    it('ranks a failed restart over an escalation in the exit code', () => {
        const { autohealExitCode } = h.service
        expect(autohealExitCode({ failed: [{}], escalated: [{}] })).to.equal(1)
        expect(autohealExitCode({ failed: [], escalated: [{}] })).to.equal(2)
        expect(autohealExitCode({ failed: [], escalated: [] })).to.equal(0)
    })

    it('exits the autoheal command with the escalation code', async () => {
        const { registerLifecycleCommands } = require('../../../../src/cli/options')
        const program = new Command().exitOverride()
        const result = { candidates: [], restarted: [], failed: [], skipped: [], escalated: [{ attempts: 2 }] }
        const loadModule = () => ({ runAutoheal: async () => result, autohealExitCode: h.service.autohealExitCode })
        registerLifecycleCommands(program, { loadModule })
        const exit = sinon.stub(process, 'exit')
        try {
            await program.parseAsync(['node', 'xchain-node', 'autoheal'])
            expect(exit.calledOnceWith(2)).to.be.true
        } finally {
            exit.restore()
        }
    })

    it('passes explicit resume-stopped intent to the autoheal service', async () => {
        const { registerLifecycleCommands } = require('../../../../src/cli/options')
        const program = new Command().exitOverride()
        const result = { candidates: [], restarted: [], failed: [], skipped: [], escalated: [] }
        let received
        const loadModule = () => ({
            runAutoheal: async options => { received = options; return result },
            autohealExitCode: h.service.autohealExitCode
        })
        registerLifecycleCommands(program, { loadModule })
        const exit = sinon.stub(process, 'exit')
        try {
            await program.parseAsync(['node', 'xchain-node', 'autoheal', '--resume-stopped'])
            expect(received).to.deep.equal({ dryRun: false, resumeStopped: true })
            expect(exit.calledOnceWith(0)).to.be.true
        } finally {
            exit.restore()
        }
    })
})
