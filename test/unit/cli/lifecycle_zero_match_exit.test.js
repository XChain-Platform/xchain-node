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
// start, stop and restart must exit non-zero with a reason when the selection
// matches no installed service. A typo'd service name, or a real service that
// is not installed on the named chain and network, used to act on nothing,
// print nothing and exit 0, so a script believed a service was stopped while
// it kept running. An unknown chain or network must give its reason the same way.

const { Command } = require('commander')
const { sinon, expect, makeStubs, loadOperations } = require('../module_operations.test/helpers/harness')
const { filterCommandParameters } = require('../../../src/services/config_service')
const { registerLifecycleCommands } = require('../../../src/cli/options')

const VERBS = [
    ['start', 'startModules', 'startContainer'],
    ['stop', 'stopModules', 'stopContainer'],
    ['restart', 'restartModules', 'stopContainer']
]

class ExitCalled extends Error {
    constructor(code) { super('exit ' + code); this.code = code }
}

// The registry of a regtest rail: real service names, installed on regtest only.
const RAIL_MODULES = ['node', 'xchain-encoder', 'xchain-decoder', 'xchain-indexer', 'xchain-utxo-tracker']
const installedOnRegtestOnly = (module, coin, network) =>
    network === 'regtest' && RAIL_MODULES.includes(module)

// Builds the commands over the real filter and the real module controls, with
// only the registry and docker stubbed, so the exit status is the CLI's own.
function buildProgram(installed) {
    const stubs = makeStubs()
    stubs.db.getModuleContainerStrict.callsFake(async (module, coin, network) =>
        installed(module, coin, network) ? `id-${module}-${coin}-${network}` : null)
    const ops = loadOperations(stubs)
    const program = new Command()
    program.exitOverride()
    registerLifecycleCommands(program, {
        filterCommandParameters,
        startModules: ops.startModules,
        stopModules: ops.stopModules,
        restartModules: ops.restartModules,
        redactSecrets: (s) => String(s),
        scanAndRegisterModules: sinon.stub().resolves(0),
        loadModule: sinon.stub()
    })
    return { stubs, program }
}

async function run(argv, installed = () => true) {
    const { stubs, program } = buildProgram(installed)
    const errors = []
    sinon.stub(console, 'error').callsFake((...a) => { errors.push(a.join(' ')) })
    sinon.stub(console, 'log')
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
    return { stubs, stderr: errors.join('\n'), exitCode }
}

function moduleControlCases() {
    for (const [verb, op, dockerCall] of VERBS) {
        it(`${op} rejects with the unmatched module, chain and network and touches no container`, async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainerStrict.resolves(null)
            const ops = loadOperations(stubs)
            const err = await ops[op]({ bitcoin: { regtest: ['xchain-decodr'] } }).then(() => null, e => e)
            expect(err, `${verb} of a service that is not installed must not resolve`).to.be.an('error')
            expect(err.message).to.include('xchain-decodr')
            expect(err.message).to.include('bitcoin')
            expect(err.message).to.include('regtest')
            expect(err.message).to.match(/no installed service/)
            expect(stubs[dockerCall].called).to.be.false
            expect(stubs.startContainer.called).to.be.false
        })

        it(`${op} still succeeds for an "all" selection with one module not installed`, async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainerStrict.callsFake(async (module) =>
                module === 'xchain-regtest-miner' ? null : `id-${module}`)
            const ops = loadOperations(stubs)
            const result = await ops[op]({ bitcoin: { regtest: ['node', 'xchain-decoder', 'xchain-regtest-miner'] } })
            expect(result).to.equal(true)
            expect(stubs[dockerCall].called).to.be.true
        })
    }
}

const TYPO_CASES = [
    [['stop', 'xchain-decodr', 'bitcoin', 'regtest'], 'xchain-decodr'],
    [['stop', 'xchain-decoder', 'bitcion', 'regtest'], 'bitcion'],
    [['restart', 'xchain-decoder', 'bitcoin', 'regtset'], 'regtset'],
    [['start', 'xchain-encoder', 'litecoin', 'mainnet'], 'xchain-encoder'],
    [['stop', 'xchain-decoder;id', 'bitcoin', 'regtest'], 'xchain-decoder;id'],
    [['stop', 'xchain-decoder', 'bitcoin$(id)', 'regtest'], 'bitcoin$(id)']
]

function cliExitCases() {
    for (const [argv, named] of TYPO_CASES) {
        it(`\`${argv.join(' ')}\` exits 1 and names ${named} on stderr`, async function () {
            const { stubs, stderr, exitCode } = await run(argv, installedOnRegtestOnly)
            expect(exitCode).to.equal(1)
            expect(stderr).to.include(`${argv[0]} failed`)
            expect(stderr).to.include(named)
            expect(stubs.stopContainer.called).to.be.false
            expect(stubs.startContainer.called).to.be.false
        })
    }

    for (const verb of ['start', 'stop', 'restart']) {
        it(`\`${verb}\` of an installed service still exits 0`, async function () {
            const { stderr, exitCode } = await run([verb, 'xchain-decoder', 'bitcoin', 'regtest'], installedOnRegtestOnly)
            expect(exitCode).to.equal(0)
            expect(stderr).to.equal('')
        })
    }
}

describe('lifecycle commands: a selection that matches no installed service', function () {
    afterEach(() => sinon.restore())
    describe('module controls', moduleControlCases)
    describe('CLI exit status', cliExitCases)
})
