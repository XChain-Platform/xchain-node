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
// clear-reorg-halt must refuse a chain or network it does not know with a
// reason that names the bad value as unknown, not with the misleading
// "no container is installed" text a typo would otherwise fall through to.

const sinon       = require('sinon')
const { expect }  = require('chai')
const { Command } = require('commander')

const { registerToolCommands } = require('../../../src/cli/commands')

class ExitCalled extends Error {
    constructor(code) { super('exit ' + code); this.code = code }
}

async function run(argv, clearResult = true) {
    const deps = {
        filterCommandParameters: sinon.stub().returns([]),
        clearDecoderReorgHalt: sinon.stub().resolves(clearResult),
        execModules: sinon.stub(),
        shellModule: sinon.stub()
    }
    const program = new Command()
    program.exitOverride()
    registerToolCommands(program, deps)
    const logs = []
    sinon.stub(console, 'log').callsFake((...a) => { logs.push(a.join(' ')) })
    sinon.stub(process, 'exit').callsFake((code) => { throw new ExitCalled(code) })
    let exitCode = null
    try {
        await program.parseAsync(argv, { from: 'user' })
    } catch (e) {
        if (!(e instanceof ExitCalled)) throw e
        exitCode = e.code
    } finally {
        sinon.restore()
    }
    return { deps, logs: logs.join('\n'), exitCode }
}

describe('CLI clear-reorg-halt: unknown chain or network', function () {
    afterEach(() => sinon.restore())

    it('names an unknown chain as unknown and touches nothing', async function () {
        const { deps, logs, exitCode } = await run(['clear-reorg-halt', 'bitcion', 'regtest', '--dry-run'])
        expect(logs).to.match(/unknown (coin|chain)/i)
        expect(logs).to.include('bitcion')
        expect(logs).to.not.include('no xchain-decoder container is installed')
        expect(exitCode).to.equal(1)
        expect(deps.filterCommandParameters.called).to.be.false
        expect(deps.clearDecoderReorgHalt.called).to.be.false
    })

    it('names an unknown network as unknown and touches nothing', async function () {
        const { deps, logs, exitCode } = await run(['clear-reorg-halt', 'bitcoin', 'regtset', '--dry-run'])
        expect(logs).to.match(/unknown network/i)
        expect(logs).to.include('regtset')
        expect(exitCode).to.equal(1)
        expect(deps.filterCommandParameters.called).to.be.false
        expect(deps.clearDecoderReorgHalt.called).to.be.false
    })

    it('still reaches the clear for a valid chain and network', async function () {
        const { deps, exitCode } = await run(['clear-reorg-halt', 'bitcoin', 'regtest', '--dry-run'])
        expect(deps.filterCommandParameters.calledOnce).to.be.true
        expect(deps.clearDecoderReorgHalt.calledOnce).to.be.true
        expect(exitCode).to.equal(0)
    })
})
