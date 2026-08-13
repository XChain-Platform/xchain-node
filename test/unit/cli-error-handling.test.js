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

const sinon      = require('sinon')
const { expect } = require('chai')
const path       = require('path')
const proxyquire = require('proxyquire')

const { installUnhandledRejectionHandler } = require('../../src/cli')

const CLI_PATH = path.join(__dirname, '..', '..', 'src', 'cli')

// Builds the `update` command's action handler with moduleOperations stubbed,
// so the exit code the CLI chooses can be observed without a live stack.
function loadUpdateAction(updateModulesStub) {
    const { Command } = require('commander')
    const captured = new Command()
    const cli = proxyquire(CLI_PATH, {
        'commander': { Command: function () { captured.parse = sinon.stub(); return captured } },
        './precheck': { preCheck: sinon.stub().resolves() },
        './state': { setVerbose: sinon.stub(), db: {} },
        './utils/commandLock': { acquireCommandLock: sinon.stub().returns(function release() {}) },
        './services/TelemetryService': { maybeReportTelemetry: sinon.stub().resolves() },
        './services/ConfigService': {
            filterCommandParameters: sinon.stub().returns({ bitcoin: { regtest: ['xchain-indexer'] } }),
            resolveArgs: sinon.stub().returns({ service: 'xchain-indexer', chain: 'bitcoin', network: 'regtest', branch: 'master' })
        },
        './operations/moduleOperations': {
            installModules: sinon.stub().resolves(),
            updateModules: updateModulesStub,
            uninstallModules: sinon.stub().resolves(),
            recreateModules: sinon.stub().resolves(),
            logModules: sinon.stub().resolves(),
            monitorModules: sinon.stub().resolves(),
            restartModules: sinon.stub().resolves(),
            stopModules: sinon.stub().resolves(),
            startModules: sinon.stub().resolves(),
            execModules: sinon.stub().resolves(),
            shellModule: sinon.stub().resolves(),
            runE2ETest: sinon.stub().resolves({ logFile: '', exitCode: 0 }),
            resetModules: sinon.stub().resolves(),
            listServedBootstrapCombos: sinon.stub().resolves([])
        },
        './services/StatusService': { getStatus: sinon.stub().resolves(), statusChanged: sinon.stub().resolves() }
    })
    cli.parseCommand()
    return captured
}

// The row this covers: `update` printed a refusal / did nothing and still left
// the shell with a success code, so every `&& echo ok`, CI step and deploy
// script concluded the redeploy had landed.
describe('CLI `update` exit code', function () {

    let exitStub, errorStub

    beforeEach(function () {
        exitStub  = sinon.stub(process, 'exit')
        errorStub = sinon.stub(console, 'error')
    })

    afterEach(function () { sinon.restore() })

    async function runUpdate(program) {
        await program.parseAsync(['update', 'xchain-indexer', 'bitcoin', 'regtest', 'master'], { from: 'user' })
    }

    it('exits NON-ZERO when the update throws (skew-guard refusal)', async function () {
        const refusal = new Error('update refused: xchain-indexer requires hub >= 2.2.0')
        const program = loadUpdateAction(sinon.stub().rejects(refusal))
        await runUpdate(program)
        expect(errorStub.calledWithMatch(/update failed: update refused/)).to.be.true
        expect(exitStub.calledWith(1)).to.be.true
        expect(exitStub.calledWith(0)).to.be.false
    })

    it('exits NON-ZERO when the update changed nothing (silent no-op redeploy)', async function () {
        const program = loadUpdateAction(sinon.stub().resolves({
            updated: [],
            skipped: [{ module: 'xchain-indexer', coin: 'bitcoin', network: 'regtest', reason: 'not-installed' }]
        }))
        await runUpdate(program)
        expect(errorStub.calledWithMatch(/nothing was updated/)).to.be.true
        expect(errorStub.calledWithMatch(/not-installed/)).to.be.true
        expect(exitStub.calledWith(1)).to.be.true
        expect(exitStub.calledWith(0)).to.be.false
    })

    it('exits ZERO when a module was actually updated', async function () {
        const program = loadUpdateAction(sinon.stub().resolves({
            updated: [{ module: 'xchain-indexer', coin: 'bitcoin', network: 'regtest' }],
            skipped: []
        }))
        await runUpdate(program)
        expect(exitStub.calledWith(0)).to.be.true
        expect(exitStub.calledWith(1)).to.be.false
    })
})

// A failed `update` used to reach the operator as an ERR_UNHANDLED_REJECTION
// stack, because commander's parse() is synchronous and several services reject
// with a plain string. The backstop must turn that into a readable line and a
// non-zero exit.
describe('CLI unhandled-rejection backstop', function () {

    let installed, exitStub, errorStub

    beforeEach(function () {
        const before = process.listeners('unhandledRejection')
        installUnhandledRejectionHandler()
        installed = process.listeners('unhandledRejection').filter((l) => !before.includes(l))
        exitStub  = sinon.stub(process, 'exit')
        errorStub = sinon.stub(console, 'error')
    })

    afterEach(function () {
        for (const listener of installed) process.removeListener('unhandledRejection', listener)
        sinon.restore()
    })

    it('registers exactly one handler', function () {
        expect(installed).to.have.lengthOf(1)
    })

    it('prints a string reason readably and exits non-zero', function () {
        installed[0]("Error cloning project: branch 'feature-mainnet-hotfix' not found for module 'xchain-hub'")
        expect(errorStub.calledOnce).to.be.true
        const line = errorStub.firstCall.args[0]
        expect(line).to.include('command failed')
        expect(line).to.include("branch 'feature-mainnet-hotfix' not found")
        expect(line).to.not.include('[object Object]')
        expect(exitStub.calledWith(1)).to.be.true
    })

    it('keeps the stack when the reason is a real Error', function () {
        const err = new Error('genuine bug')
        installed[0](err)
        expect(errorStub.firstCall.args[0]).to.include('genuine bug')
        expect(errorStub.firstCall.args[0]).to.include('cli-error-handling.test.js')
        expect(exitStub.calledWith(1)).to.be.true
    })
})
