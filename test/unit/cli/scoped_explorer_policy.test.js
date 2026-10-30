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

const { Command } = require('commander')
const sinon = require('sinon')
const { expect } = require('chai')
const { filterCommandParameters } = require('../../../src/services/config_service')
const { registerPrimaryCommands } = require('../../../src/cli/commands')
const { registerLifecycleCommands } = require('../../../src/cli/options')

function hasExplorer(services) {
    return services[''] && services[''][''] && services[''][''].includes('xchain-explorer')
}

async function runPrimaryCommand(verb, chain = 'bitcoin') {
    const captured = {}
    const program = new Command()
    registerPrimaryCommands(program, {
        filterCommandParameters,
        resolveArgs: () => ({ service: 'all', chain, network: 'regtest', branch: null }),
        installModules: async services => { captured.install = services; return [] },
        syncSharedServicesAfterInstall: async () => true,
        uninstallModules: async services => { captured.uninstall = services; return {} },
        updateModules: async services => {
            captured.update = services
            return { updated: [{ module: 'node' }], skipped: [], failed: [] }
        },
        recreateModules: async services => {
            captured.recreate = services
            return { recreated: [{ module: 'node' }], skipped: [] }
        },
        getStatus: async () => true,
        redactSecrets: String,
        config: {}
    })
    sinon.stub(process, 'exit')
    try {
        await program.parseAsync([verb, 'all', chain, 'regtest'], { from: 'user' })
    } finally {
        sinon.restore()
    }
    return captured[verb]
}

async function runLifecycleCommand(verb, args = ['all', 'bitcoin', 'regtest']) {
    let captured
    const capture = async services => { captured = services }
    const program = new Command()
    registerLifecycleCommands(program, {
        filterCommandParameters,
        startModules: capture,
        stopModules: capture,
        restartModules: capture,
        redactSecrets: String,
        scanAndRegisterModules: async () => 0,
        loadModule: () => ({})
    })
    sinon.stub(process, 'exit')
    try {
        await program.parseAsync([verb, ...args], { from: 'user' })
    } finally {
        sinon.restore()
    }
    return captured
}

describe('CLI chain-scoped all explorer policy', function () {
    afterEach(() => sinon.restore())

    for (const verb of ['install', 'update', 'recreate']) {
        it(`${verb} all bitcoin regtest still lists xchain-explorer`, async function () {
            expect(hasExplorer(await runPrimaryCommand(verb))).to.equal(true)
        })
    }

    for (const verb of ['start', 'stop', 'restart']) {
        it(`${verb} all bitcoin regtest leaves xchain-explorer out`, async function () {
            expect(hasExplorer(await runLifecycleCommand(verb))).to.not.equal(true)
        })
    }

    it('uninstall all bitcoin regtest leaves xchain-explorer out', async function () {
        expect(hasExplorer(await runPrimaryCommand('uninstall'))).to.not.equal(true)
    })

    for (const verb of ['start', 'stop', 'restart']) {
        it(`${verb} all with no chain, or all chains on one network, still lists xchain-explorer`, async function () {
            expect(hasExplorer(await runLifecycleCommand(verb, ['all']))).to.equal(true)
            expect(hasExplorer(await runLifecycleCommand(verb, ['all', 'all', 'regtest']))).to.equal(true)
        })
    }

    it('uninstall all all regtest still lists xchain-explorer', async function () {
        expect(hasExplorer(await runPrimaryCommand('uninstall', 'all'))).to.equal(true)
    })
})
