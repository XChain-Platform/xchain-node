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
// Pins which commands keep the command lock through their action. A command
// that writes state a concurrent deploy reads must hold it to exit; a command
// that only reads hands it back once preCheck is done.

const sinon       = require('sinon')
const { expect }  = require('chai')
const { Command } = require('commander')

const { installDispatch } = require('../../../src/cli/dispatch')

const SIGNALS = ['exit', 'SIGINT', 'SIGTERM']

// Build a real Commander tree with do-nothing actions, so the hook sees the
// same parent/child shape the shipped CLI gives it.
function buildProgram(deps) {
    const program = new Command()
    program.exitOverride()
    program.option('--verbose').option('--no-telemetry')
    installDispatch(program, deps)
    for (const name of ['install', 'update', 'reset', 'bootstrap', 'ps', 'logs', 'exec', 'shell'])
        program.command(name).allowUnknownOption().argument('[args...]').action(deps.action)
    program.command('clear-reorg-halt').argument('<chain>').argument('<network>')
        .option('--reason <text>').option('--dry-run').action(deps.action)
    const validator = program.command('validator').action(deps.action)
    validator.command('init').option('--force').option('--force-wallets').action(deps.action)
    validator.command('stake').option('--broadcast').action(deps.action)
    validator.command('unstake').option('--broadcast').action(deps.action)
    validator.command('status').action(deps.action)
    validator.command('drift').action(deps.action)
    return program
}

function makeDeps() {
    const release = sinon.stub()
    return {
        release,
        config: {},
        action: sinon.stub(),
        setVerbose: sinon.stub(),
        maybeSelfUpdateBeforeUpdate: sinon.stub().resolves(),
        redactSecrets: (s) => s,
        acquireCommandLock: sinon.stub().returns(release),
        preCheck: sinon.stub().resolves(),
        refForPreCheck: sinon.stub().returns(null),
        commandRepairsHub: sinon.stub().returns(false),
        maybeReportTelemetry: sinon.stub().resolves(),
        noticeNewerRelease: sinon.stub().resolves()
    }
}

let listenersBefore

// Drop the exit/signal handlers a hold-through lock registers, so no stub
// release outlives its test.
function snapshotListeners() {
    listenersBefore = {}
    for (const ev of SIGNALS) listenersBefore[ev] = process.listeners(ev)
}

function restoreListeners() {
    for (const ev of SIGNALS) {
        for (const fn of process.listeners(ev)) {
            if (!listenersBefore[ev].includes(fn)) process.removeListener(ev, fn)
        }
    }
    sinon.restore()
}

async function run(argv) {
    const deps = makeDeps()
    await buildProgram(deps).parseAsync(argv, { from: 'user' })
    return deps
}

describe('CLI dispatch: commands that hold the lock through their action', function () {
    beforeEach(snapshotListeners)
    afterEach(restoreListeners)

    for (const argv of [['install', 'xchain-hub'], ['update', 'xchain-hub'], ['reset', 'xchain-decoder'], ['bootstrap', 'restore']]) {
        it(`${argv[0]} keeps the lock and refuses a held one at once`, async function () {
            const deps = await run(argv)
            expect(deps.acquireCommandLock.calledOnceWith({ command: argv[0], waitMs: 0 })).to.be.true
            expect(deps.release.called).to.be.false
            expect(deps.action.calledOnce).to.be.true
        })
    }

    it('clear-reorg-halt keeps the lock through its database check and audited write', async function () {
        const deps = await run(['clear-reorg-halt', 'bitcoin', 'regtest', '--reason', 'known good replica'])
        expect(deps.acquireCommandLock.calledOnceWith({ command: 'clear-reorg-halt', waitMs: 0 })).to.be.true
        expect(deps.preCheck.calledOnce).to.be.true
        expect(deps.release.called).to.be.false
    })

    it('clear-reorg-halt --dry-run is serialized too, so its verdict cannot describe a DB mid-reset', async function () {
        const deps = await run(['clear-reorg-halt', 'bitcoin', 'regtest', '--dry-run'])
        expect(deps.acquireCommandLock.calledOnceWith({ command: 'clear-reorg-halt', waitMs: 0 })).to.be.true
        expect(deps.release.called).to.be.false
    })
})

describe('CLI dispatch: commands that hand the lock back after preCheck', function () {
    beforeEach(snapshotListeners)
    afterEach(restoreListeners)

    for (const name of ['ps', 'logs', 'exec', 'shell']) {
        it(`${name} releases the lock once preCheck returns`, async function () {
            const deps = await run([name])
            expect(deps.acquireCommandLock.calledOnceWith({ command: name, waitMs: 15000 })).to.be.true
            expect(deps.release.calledOnce).to.be.true
            expect(deps.release.calledAfter(deps.preCheck)).to.be.true
        })
    }
})

describe('CLI dispatch: validator subcommands', function () {
    beforeEach(snapshotListeners)
    afterEach(restoreListeners)

    for (const flags of [[], ['--force'], ['--force-wallets']]) {
        it(`${['validator init', ...flags].join(' ')} holds the lock to exit and still skips preCheck`, async function () {
            const deps = await run(['validator', 'init', ...flags])
            expect(deps.acquireCommandLock.calledOnceWith({ command: 'validator init', waitMs: 0 })).to.be.true
            expect(deps.release.called).to.be.false
            expect(deps.preCheck.called).to.be.false
            expect(deps.action.calledOnce).to.be.true
        })
    }

    it('validator init --force is refused, and never regenerates the key, while another run holds the lock', async function () {
        const exitStub = sinon.stub(process, 'exit')
        sinon.stub(console, 'error')
        const deps = makeDeps()
        const held = new Error('Another xchain-node instance (running "update") holds the command lock')
        held.code = 'ELOCKHELD'
        deps.acquireCommandLock = sinon.stub().throws(held)
        // Stand in for the real exit: a refused lock must end the run before the action.
        exitStub.callsFake((code) => { throw Object.assign(new Error('exit'), { exitCode: code }) })
        let exited = null
        try {
            await buildProgram(deps).parseAsync(['validator', 'init', '--force'], { from: 'user' })
        } catch (err) {
            exited = err.exitCode
        }
        expect(exited).to.equal(1)
        expect(deps.action.called).to.be.false
    })

    // --broadcast too: its service locks only the sends, and a dispatch hold would refuse that service's own lock.
    for (const argv of [['validator', 'status'], ['validator', 'drift'], ['validator', 'stake'], ['validator', 'unstake'],
        ['validator', 'stake', '--broadcast'], ['validator', 'unstake', '--broadcast'], ['validator']]) {
        it(`${argv.join(' ')} takes no lock and runs no preCheck`, async function () {
            const deps = await run(argv)
            expect(deps.acquireCommandLock.called).to.be.false
            expect(deps.preCheck.called).to.be.false
        })
    }
})
