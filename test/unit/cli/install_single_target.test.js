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

const sinon = require('sinon')
const { expect } = require('chai')
const { Command } = require('commander')
const { registerPrimaryCommands } = require('../../../src/cli/commands')

describe('install action target handoff', function () {
    afterEach(() => sinon.restore())

    it('passes the target resolved by preAction to installModules', async function () {
        const target = { kind: 'release', ref: 'v1.2.3', tag: 'v1.2.3', manifest: {} }
        const installModules = sinon.stub().resolves({ installed: [] })
        const program = new Command().exitOverride().option('--no-bootstrap')
        registerPrimaryCommands(program, {
            filterCommandParameters: () => ({}),
            resolveArgs: () => ({ branch: null, service: 'all', chain: 'all', network: 'all' }),
            installModules,
            syncSharedServicesAfterInstall: sinon.stub().resolves(true),
            updateModules: sinon.stub(),
            recreateModules: sinon.stub(),
            uninstallModules: sinon.stub(),
            redactSecrets: value => value,
            config: {}
        })
        program.commands.find(command => command.name() === 'install').resolvedInstallTarget = target
        sinon.stub(process, 'exit')

        await program.parseAsync(['install'], { from: 'user' })

        expect(installModules.calledOnce).to.equal(true)
        expect(installModules.firstCall.args[2]).to.equal(target)
    })
})
