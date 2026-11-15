/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Autoheal: a pass that cannot inspect Docker says so (error log, exit 3).
 ********************************************************************/

const { expect } = require('chai')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()
const fs = require('fs')
const os = require('os')
const path = require('path')

const NOW = Date.parse('2026-01-01T12:00:00Z')
const DAEMON_DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
const NO_PERMISSION = 'permission denied while trying to connect to the Docker daemon socket'

// execFile's callback form puts docker's stderr after a `Command failed:` header.
function execError(stderr) {
    const err = new Error(`Command failed: docker inspect abc\n${stderr}\n`)
    err.stderr = stderr + '\n'
    return err
}

function healthyStatus() {
    return { State: { Status: 'running', Health: { Status: 'healthy', FailingStreak: 0, Log: [] } } }
}

function loadService(stubs) {
    return proxyquire('../../../src/services/autoheal_service', {
        '../state': { db: stubs.db },
        './docker_service': {
            getStatusFromContainer: stubs.getStatusFromContainer,
            stopContainer: sinon.stub().resolves({ stopped: true, seconds: 1, killed: false, exitCode: 0 }),
            startContainer: sinon.stub().resolves(true),
            getContainerStopSettings: sinon.stub().resolves(null)
        },
        './module_service': { SERVICE_HEALTHCHECK: require('../../../src/services/module_service').SERVICE_HEALTHCHECK }
    })
}

const TITLE = 'AutohealService inspect failures'

// Shared per-test state; every describe below registers the same hooks.
const ctx = {}

function useInspectFixture() {
    beforeEach(() => {
        ctx.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoheal-inspect-'))
        process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR = ctx.stateDir
        ctx.stubs = {
            db: { getAllModuleContainers: sinon.stub().resolves([]), assertReady: sinon.stub() },
            getStatusFromContainer: sinon.stub()
        }
        ctx.stubs.db.getAllModuleContainers.resolves([
            { module: 'xchain-indexer', coin: 'bitcoin', network: 'regtest', container_id: 'iii' },
            { module: 'xchain-decoder', coin: 'litecoin', network: 'regtest', container_id: 'ddd' }
        ])
        ctx.service = loadService(ctx.stubs)
        ctx.log = sinon.stub(console, 'log')
        ctx.error = sinon.stub(console, 'error')
    })
    afterEach(() => {
        ctx.log.restore()
        ctx.error.restore()
        delete process.env.XCHAIN_NODE_AUTOHEAL_STATE_DIR
        fs.rmSync(ctx.stateDir, { recursive: true, force: true })
    })
}

const logged = (stub, pattern) => stub.getCalls().some(c => pattern.test(String(c.args[0])))

describe(TITLE, () => {
    useInspectFixture()

    it('exits 3 and never reports nothing to do when the Docker daemon is unreachable', async () => {
        ctx.stubs.getStatusFromContainer.rejects(execError(DAEMON_DOWN))

        const result = await ctx.service.runAutoheal({ now: NOW })

        expect(result.inspectErrors).to.have.length(2)
        expect(result.inspectErrors[0].error).to.equal(DAEMON_DOWN)
        expect(result.failed).to.have.length(0)
        expect(ctx.service.autohealExitCode(result)).to.equal(3)
        expect(logged(ctx.error, /cannot inspect indexer|cannot inspect xchain-indexer/)).to.be.true
        expect(logged(ctx.error, /could not inspect 2 opted-in container/)).to.be.true
        expect(logged(ctx.log, /nothing to do/)).to.be.false
    })

    it('exits 3 for one socket permission error while another container inspects fine', async () => {
        ctx.stubs.getStatusFromContainer.withArgs('iii').rejects(execError(NO_PERMISSION))
        ctx.stubs.getStatusFromContainer.withArgs('ddd').resolves(healthyStatus())

        const result = await ctx.service.runAutoheal({ now: NOW })

        expect(result.inspectErrors).to.have.length(1)
        expect(result.inspectErrors[0].containerId).to.equal('iii')
        expect(result.skipped[0].reason).to.equal(`inspect error: ${NO_PERMISSION}`)
        expect(ctx.service.autohealExitCode(result)).to.equal(3)
    })

    it('keeps a container Docker reports gone a quiet skip that exits 0', async () => {
        ctx.stubs.getStatusFromContainer.rejects(execError('Error: No such object: iii'))

        const result = await ctx.service.runAutoheal({ now: NOW })

        expect(result.inspectErrors).to.have.length(0)
        expect(result.skipped).to.have.length(2)
        expect(result.skipped[0].reason).to.equal('inspect failed')
        expect(ctx.service.autohealExitCode(result)).to.equal(0)
        expect(ctx.error.called).to.be.false
        expect(logged(ctx.log, /nothing to do/)).to.be.true
    })
})

describe(TITLE, () => {
    useInspectFixture()

    it('ranks a failed restart and an escalation over an inspect failure in the exit code', () => {
        const { autohealExitCode } = ctx.service
        expect(autohealExitCode({ failed: [{}], escalated: [], inspectErrors: [{}] })).to.equal(1)
        expect(autohealExitCode({ failed: [], escalated: [{}], inspectErrors: [{}] })).to.equal(2)
        expect(autohealExitCode({ failed: [], escalated: [], inspectErrors: [{}] })).to.equal(3)
        expect(autohealExitCode({ failed: [], escalated: [] })).to.equal(0)
    })

    it('treats a timeout or any other rejection as a failure, not a gone container', async () => {
        ctx.stubs.getStatusFromContainer.rejects(Object.assign(new Error('Command failed: docker inspect iii'), { killed: true, signal: 'SIGTERM' }))

        const result = await ctx.service.runAutoheal({ now: NOW })

        expect(result.inspectErrors).to.have.length(2)
        expect(ctx.service.autohealExitCode(result)).to.equal(3)
    })
})
