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
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')

const ROOT = path.join(__dirname, '..', '..', '..')

const expectedCommands = [
    'install', 'uninstall', 'update', 'ps',
    'start', 'stop', 'restart',
    'tail', 'logs', 'monitor', 'tailmonitor',
    'exec', 'shell', 'e2etest', 'reset', 'rollback', 'bootstrap', 'validator'
]

const expectedArgs = {
    // install's ref/service/chain/network all became optional (commit f9f5e67:
    // an omitted ref resolves the latest published release), so 0/4 is the
    // current contract, not the pre-f9f5e67 2/2.
    'install':     { required: 0, optional: 4 },
    'uninstall':   { required: 1, optional: 2 },
    // bf4d32a: a bare `xchain-node update` means `update all`, so every
    // positional (service, chain, network, ref) is optional.
    'update':      { required: 0, optional: 4 },
    'ps':          { required: 0, optional: 0 },
    'start':       { required: 1, optional: 2 },
    'stop':        { required: 1, optional: 2 },
    'restart':     { required: 1, optional: 2 },
    'tail':        { required: 0, optional: 3 },
    'logs':        { required: 0, optional: 3 },
    'monitor':     { required: 0, optional: 3 },
    'tailmonitor': { required: 0, optional: 3 },
    'exec':        { required: 4, optional: 0 },
    'shell':       { required: 3, optional: 0 },
    'e2etest':     { required: 1, optional: 1 },
    'reset':       { required: 3, optional: 0 },
    'rollback':    { required: 4, optional: 0 },
    'bootstrap':   { required: 4, optional: 0 }
}

function createProgram() {
    // Intercept Commander to capture the program instance
    const { Command } = require('commander')
    const capturedProgram = new Command()
    let originalParse = capturedProgram.parse

    const mod = proxyquire(path.join(ROOT, 'src/cli'), {
        'commander': {
            Command: function () {
                // Stub parse to prevent actual argv processing
                capturedProgram.parse = sinon.stub()
                return capturedProgram
            }
        },
        './precheck': { preCheck: sinon.stub().resolves() },
        './state': { setVerbose: sinon.stub() },
        './services/config_service': {
            filterCommandParameters: sinon.stub().returns({}),
            resolveArgs: sinon.stub().returns({ service: 'all', chain: 'all', network: 'all', branch: 'master' })
        },
        './operations/module_operations': {
            installModules: sinon.stub().resolves(),
            updateModules: sinon.stub().resolves(),
            uninstallModules: sinon.stub().resolves(),
            logModules: sinon.stub().resolves(),
            monitorModules: sinon.stub().resolves(),
            restartModules: sinon.stub().resolves(),
            stopModules: sinon.stub().resolves(),
            startModules: sinon.stub().resolves(),
            execModules: sinon.stub().resolves(),
            shellModule: sinon.stub().resolves(),
            runE2ETest: sinon.stub().resolves({ logFile: '', exitCode: 0 }),
            resetModules: sinon.stub().resolves()
        },
        './services/status_service': { getStatus: sinon.stub().resolves() },
        './services/bootstrap_service': { makeBootstrap: sinon.stub().resolves() },
        './ui/menu': {
            restoreBootstrapInterface: sinon.stub().resolves(),
            startInterface: sinon.stub().resolves()
        }
    })

    // Invoke parseCommand to trigger all program.command() registrations
    mod.parseCommand()
    return capturedProgram
}

describe('S-SMOKE-002 – Commander CLI Registration', function () {

    let program

    before(function () {
        program = createProgram()
    })

    it('registers all expected commands', function () {
        const registeredNames = program.commands.map(c => c.name())
        for (const name of expectedCommands) {
            expect(registeredNames, `missing command: ${name}`).to.include(name)
        }
    })

    it('each command has an action handler', function () {
        for (const cmd of program.commands) {
            // Command groups (e.g. `validator`, which only routes to `validator
            // init`/`validator status`) intentionally have no action handler of
            // their own; commander dispatches to their subcommands instead.
            if (cmd.commands.length > 0) continue
            expect(cmd._actionHandler, `${cmd.name()} missing action handler`).to.be.a('function')
        }
    })
})

describe('S-SMOKE-002 – Commander CLI Registration', function () {

    let program

    before(function () {
        program = createProgram()
    })

    for (const [cmdName, counts] of Object.entries(expectedArgs)) {
        it(`${cmdName} has correct argument counts (${counts.required} required, ${counts.optional} optional)`, function () {
            const cmd = program.commands.find(c => c.name() === cmdName)
            expect(cmd, `command ${cmdName} not found`).to.exist

            const args = cmd.registeredArguments || cmd._args || []
            const required = args.filter(a => a.required).length
            const optional = args.filter(a => !a.required).length

            expect(required, `${cmdName} required args`).to.equal(counts.required)
            expect(optional, `${cmdName} optional args`).to.equal(counts.optional)
        })
    }
})
