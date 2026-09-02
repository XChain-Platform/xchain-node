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
//
// `rollback` is declared but unimplemented. The row this covers is not the
// missing implementation, it is that reaching for it during an incident cost an
// operator ~10 minutes (measured 2026-08-30, repairing a regtest indexer): the
// preAction hook ran the full Docker/MariaDB/hub precheck and took the mutating
// lock before the action could say anything, and the action then set
// process.exitCode instead of exiting, so the process stayed alive on open
// handles. Printed nothing, returned nothing: it read as a hang. These cases pin
// the incident-path contract - no precheck, no lock, guidance on stderr, exit 1.

const sinon      = require('sinon')
const { expect } = require('chai')
const path       = require('path')
const proxyquire = require('proxyquire')

const CLI_PATH = path.join(__dirname, '..', '..', 'src', 'cli')

// Builds the CLI with every side-effecting collaborator stubbed, and hands the
// stubs back so a test can assert which ones the command DID NOT touch.
function loadCli() {
    const { Command } = require('commander')
    const captured = new Command()
    const stubs = {
        preCheck:           sinon.stub().resolves(),
        acquireCommandLock: sinon.stub().returns(function release() {}),
        maybeReportTelemetry: sinon.stub().resolves()
    }
    const cli = proxyquire(CLI_PATH, {
        'commander': { Command: function () { captured.parse = sinon.stub(); return captured } },
        './precheck': { preCheck: stubs.preCheck },
        './state': { setVerbose: sinon.stub(), db: {} },
        './utils/commandLock': { acquireCommandLock: stubs.acquireCommandLock },
        './services/TelemetryService': { maybeReportTelemetry: stubs.maybeReportTelemetry },
        './services/ConfigService': {
            filterCommandParameters: sinon.stub().returns({ bitcoin: { regtest: ['xchain-indexer'] } }),
            resolveArgs: sinon.stub().returns({ service: 'xchain-indexer', chain: 'bitcoin', network: 'regtest', branch: 'master' })
        },
        './operations/moduleOperations': {
            installModules: sinon.stub().resolves(),
            updateModules: sinon.stub().resolves({ updated: [], skipped: [] }),
            uninstallModules: sinon.stub().resolves({ uninstalled: [], skipped: [] }),
            recreateModules: sinon.stub().resolves({ recreated: [], skipped: [] }),
            logModules: sinon.stub().resolves(),
            monitorModules: sinon.stub().resolves(),
            restartModules: sinon.stub().resolves(),
            stopModules: sinon.stub().resolves(),
            startModules: sinon.stub().resolves(),
            execModules: sinon.stub().resolves(),
            shellModule: sinon.stub().resolves(),
            runE2ETest: sinon.stub().resolves({ logFile: '', exitCode: 0 }),
            resetModules: sinon.stub().resolves(true),
            listServedBootstrapCombos: sinon.stub().resolves([])
        },
        './services/StatusService': { getStatus: sinon.stub().resolves(), statusChanged: sinon.stub().resolves() }
    })
    cli.parseCommand()
    return { program: captured, stubs }
}

describe('CLI `rollback` incident-path behaviour', function () {

    let exitStub, errorStub

    beforeEach(function () {
        exitStub  = sinon.stub(process, 'exit')
        errorStub = sinon.stub(console, 'error')
    })

    afterEach(function () { sinon.restore() })

    async function runRollback(program) {
        await program.parseAsync(['rollback', '4200', 'xchain-indexer', 'bitcoin', 'regtest'], { from: 'user' })
    }

    it('exits NON-ZERO instead of leaving the process alive on open handles', async function () {
        const { program } = loadCli()
        await runRollback(program)
        expect(exitStub.calledWith(1)).to.be.true
        expect(exitStub.calledWith(0)).to.be.false
    })

    it('says it did nothing, so no operator reads the refusal as a completed rollback', async function () {
        const { program } = loadCli()
        await runRollback(program)
        expect(errorStub.calledWithMatch(/not yet implemented/)).to.be.true
        expect(errorStub.calledWithMatch(/nothing was rolled back/)).to.be.true
    })

    it('names the reset-and-restore recovery path as runnable commands', async function () {
        const { program } = loadCli()
        await runRollback(program)
        const printed = errorStub.getCalls().map(c => c.args.join(' ')).join('\n')
        expect(printed).to.match(/xchain-node reset xchain-indexer bitcoin regtest/)
        expect(printed).to.match(/xchain-node bootstrap restore xchain-indexer bitcoin regtest/)
    })

    it('echoes the operator\'s own arguments back, so the guidance is copy-pasteable', async function () {
        const { program } = loadCli()
        await program.parseAsync(['rollback', '917', 'xchain-decoder', 'litecoin', 'testnet'], { from: 'user' })
        const printed = errorStub.getCalls().map(c => c.args.join(' ')).join('\n')
        expect(printed).to.match(/block 917/)
        expect(printed).to.match(/xchain-node reset xchain-decoder litecoin testnet/)
        expect(printed).to.match(/xchain-node bootstrap restore xchain-decoder litecoin testnet/)
    })

    // The two waits that made it look like a hang. preCheck provisions the
    // database container, hub module and module registry before any action runs;
    // on a real node that is minutes, and it fails outright when Docker is down,
    // which is exactly the state an operator reaches for `rollback` in.
    it('does NOT run the Docker/MariaDB precheck for a command that provisions nothing', async function () {
        const { program, stubs } = loadCli()
        await runRollback(program)
        expect(stubs.preCheck.called).to.be.false
    })

    it('does NOT take the mutating command lock, so it cannot queue behind a deploy', async function () {
        const { program, stubs } = loadCli()
        await runRollback(program)
        expect(stubs.acquireCommandLock.called).to.be.false
    })

    // Guard the guard: the same loader must still show a real mutating command
    // going through both, or the two assertions above would pass on a CLI whose
    // hook never runs at all.
    it('leaves the precheck and the lock in place for a command that does provision', async function () {
        const { program, stubs } = loadCli()
        await program.parseAsync(['reset', 'xchain-indexer', 'bitcoin', 'regtest', '--yes'], { from: 'user' })
        expect(stubs.preCheck.called).to.be.true
        expect(stubs.acquireCommandLock.called).to.be.true
    })
})
