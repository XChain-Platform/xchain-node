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

// The shipped `reset` command and dispatch hook, driven together: `--db-container` must reach resetModules and
// turn preCheck local, and a reset without it must call both exactly as before.

const { expect } = require('chai')
const sinon = require('sinon')
const { Command } = require('commander')
const { installDispatch } = require('../../../src/cli/dispatch')
const { registerPreRecoveryCommands } = require('../../../src/cli/errors')

const SIGNALS = ['exit', 'SIGINT', 'SIGTERM']

function makeDeps() {
    return {
        config: {},
        setVerbose: sinon.stub(),
        maybeSelfUpdateBeforeUpdate: sinon.stub().resolves(),
        redactSecrets: (s) => s,
        acquireCommandLock: sinon.stub().returns(sinon.stub()),
        preCheck: sinon.stub().resolves(),
        refForPreCheck: sinon.stub().returns(null),
        commandRepairsHub: sinon.stub().returns(false),
        maybeReportTelemetry: sinon.stub().resolves(),
        noticeNewerRelease: sinon.stub().resolves(),
        resetModules: sinon.stub().resolves(true),
        hubCheckpointDependencies: {}
    }
}

async function drive(argv) {
    const deps = makeDeps()
    const program = new Command()
    program.exitOverride()
    program.option('--verbose').option('--no-telemetry')
    installDispatch(program, deps)
    registerPreRecoveryCommands(program, deps)
    const exit = sinon.stub(process, 'exit')
    await program.parseAsync(['node', 'xchain-node', ...argv])
    return { deps, exit }
}

describe('CLI reset --db-container', function () {
    let listenersBefore
    beforeEach(function () {
        listenersBefore = {}
        for (const ev of SIGNALS) listenersBefore[ev] = process.listeners(ev)
    })
    afterEach(function () {
        for (const ev of SIGNALS) {
            for (const fn of process.listeners(ev)) if (!listenersBefore[ev].includes(fn)) process.removeListener(ev, fn)
        }
        sinon.restore()
    })

    it('hands the container to resetModules and runs a local-only preCheck', async function () {
        const { deps, exit } = await drive(['reset', 'xchain-decoder', 'bitcoin', 'regtest', '--with-indexer', '--yes',
            '--db-container', 'xchain-rail-database'])
        sinon.assert.calledOnceWithExactly(deps.resetModules, 'xchain-decoder', 'bitcoin', 'regtest', true, true,
            { dbContainer: 'xchain-rail-database', check: false })
        expect(deps.preCheck.firstCall.args).to.deep.equal([false, true, null, false, { localOnly: true }])
        sinon.assert.calledOnceWithExactly(exit, 0)
    })

    it('calls preCheck and resetModules as before when the flag is absent', async function () {
        const { deps } = await drive(['reset', 'xchain-decoder', 'bitcoin', 'regtest', '--with-indexer', '--yes'])
        sinon.assert.calledOnceWithExactly(deps.resetModules, 'xchain-decoder', 'bitcoin', 'regtest', true, true)
        expect(deps.preCheck.firstCall.args).to.deep.equal([false, true, null, false])
    })

    it('refuses the flag on hub-checkpoints without running that reset', async function () {
        const write = sinon.stub(process.stderr, 'write')
        const { deps, exit } = await drive(['reset', 'hub-checkpoints', '--yes', '--db-container', 'xchain-rail-database'])
        write.restore()
        sinon.assert.calledWith(exit, 1)
        expect(write.args.map(a => String(a[0])).join('')).to.contain('--db-container does not apply to hub-checkpoints')
        expect(deps.resetModules.called).to.be.false
    })

    it('passes --check through with the container', async function () {
        const { deps } = await drive(['reset', 'xchain-decoder', 'bitcoin', 'regtest', '--with-indexer',
            '--db-container', 'xchain-rail-database', '--check'])
        sinon.assert.calledOnceWithExactly(deps.resetModules, 'xchain-decoder', 'bitcoin', 'regtest', false, true,
            { dbContainer: 'xchain-rail-database', check: true })
    })

    it('refuses --check without --db-container', async function () {
        const write = sinon.stub(process.stderr, 'write')
        const { deps, exit } = await drive(['reset', 'xchain-decoder', 'bitcoin', 'regtest', '--check'])
        write.restore()
        sinon.assert.calledWith(exit, 1)
        expect(write.args.map(a => String(a[0])).join('')).to.contain('--check needs --db-container')
        expect(deps.resetModules.called).to.be.false
    })
})
