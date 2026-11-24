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
// Pins that restore-dump refuses a malformed service, chain or network before it
// takes the command lock or runs preCheck (which pushes hub config).

const sinon       = require('sinon')
const { expect }  = require('chai')
const { Command } = require('commander')

const { installDispatch } = require('../../../src/cli/dispatch')

function buildProgram(deps) {
    const program = new Command()
    program.exitOverride()
    program.option('--verbose').option('--no-telemetry')
    installDispatch(program, deps)
    program.command('restore-dump')
        .argument('<service>').argument('<chain>').argument('<network>')
        .requiredOption('--file <path>').option('--yes').option('--allow-mainnet')
        .action(deps.action)
    return program
}

function makeDeps() {
    return {
        config: {},
        action: sinon.stub(),
        setVerbose: sinon.stub(),
        maybeSelfUpdateBeforeUpdate: sinon.stub().resolves(),
        redactSecrets: (s) => s,
        acquireCommandLock: sinon.stub().returns(sinon.stub()),
        preCheck: sinon.stub().resolves(),
        resolveNoRefInstallTarget: sinon.stub().resolves(null),
        refForPreCheck: sinon.stub().returns(null),
        commandRepairsHub: sinon.stub().returns(false),
        maybeReportTelemetry: sinon.stub().resolves(),
        noticeNewerRelease: sinon.stub().resolves()
    }
}

const SIGNALS = ['exit', 'SIGINT', 'SIGTERM']
let before, exitStub, errStub

async function run(args) {
    const deps = makeDeps()
    await buildProgram(deps).parseAsync(['restore-dump', ...args, '--file', 'x.2026.sql.gz'], { from: 'user' })
    return deps
}

describe('CLI dispatch: restore-dump argument check', function () {
    beforeEach(function () {
        before = {}
        for (const ev of SIGNALS) before[ev] = process.listeners(ev)
        exitStub = sinon.stub(process, 'exit')
        errStub = sinon.stub(console, 'error')
    })
    afterEach(function () {
        for (const ev of SIGNALS) for (const fn of process.listeners(ev)) if (!before[ev].includes(fn)) process.removeListener(ev, fn)
        sinon.restore()
    })

    const bad = [
        [['xchain-encoder', 'dogecoin', 'regtest'], /unsupported service 'xchain-encoder'/],
        [['xchain-decoder', 'dogechain', 'regtest'], /unknown chain 'dogechain'/],
        [['xchain-decoder', 'dogecoin', 'devnet'], /unknown network 'devnet'/],
        [['xchain-decoder', 'dogecoin', 'mainnet'], /without --allow-mainnet/]
    ]
    for (const [args, message] of bad) {
        it(`refuses ${args.join(' ')} before the lock and preCheck`, async function () {
            const deps = await run(args)
            expect(deps.preCheck.called).to.be.false
            expect(deps.acquireCommandLock.called).to.be.false
            expect(exitStub.calledWith(1)).to.be.true
            expect(errStub.args.flat().join(' ')).to.match(message)
        })
    }

    it('lets a valid regtest call take the lock and run preCheck once', async function () {
        const deps = await run(['xchain-decoder', 'dogecoin', 'regtest'])
        expect(deps.acquireCommandLock.calledOnce).to.be.true
        expect(deps.preCheck.calledOnce).to.be.true
        expect(exitStub.called).to.be.false
    })

    it('lets mainnet with --allow-mainnet pass the early check', async function () {
        const deps = makeDeps()
        await buildProgram(deps).parseAsync(['restore-dump', 'xchain-decoder', 'dogecoin', 'mainnet', '--file', 'x.2026.sql.gz', '--allow-mainnet'], { from: 'user' })
        expect(deps.preCheck.calledOnce).to.be.true
        expect(exitStub.called).to.be.false
    })
})
