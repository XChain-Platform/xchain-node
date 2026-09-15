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

function createProgram() {
    const { Command } = require('commander')
    const capturedProgram = new Command()

    proxyquire(path.join(ROOT, 'src/cli'), {
        'commander': {
            Command: function () {
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
    }).parseCommand()

    return capturedProgram
}

describe('S-SMOKE-003 – Global Options Registration', function () {

    let program

    before(function () {
        program = createProgram()
    })

    const expectedOptions = [
        { flags: '--verbose',       short: '-v' },
        { flags: '--interactive',   short: '-i' },
        { flags: '--no-bootstrap',  short: null },
        { flags: '--no-explorer',   short: null },
        { flags: '--version',       short: '-V' }
    ]

    for (const opt of expectedOptions) {
        it(`registers ${opt.flags} option`, function () {
            const found = program.options.some(o => o.long === opt.flags)
            expect(found, `missing option ${opt.flags}`).to.be.true
        })

        if (opt.short) {
            it(`registers ${opt.short} as short flag for ${opt.flags}`, function () {
                const found = program.options.some(o => o.short === opt.short && o.long === opt.flags)
                expect(found, `missing short flag ${opt.short}`).to.be.true
            })
        }
    }
})
