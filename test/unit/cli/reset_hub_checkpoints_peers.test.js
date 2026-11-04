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

const { expect } = require('chai')
const sinon = require('sinon')
const { Command } = require('commander')
const { registerPreRecoveryCommands } = require('../../../src/cli/errors')

const row = (name, state = 'running') => ({ ID: name + '-id', Names: name, State: state })

// A federated rail: the CLI's hub, two hand-built peers on their own databases,
// a dated drill snapshot of a peer, and one indexer.
const CONTAINERS = [
    row('rail-xchain-hub'), row('rail-xchain-hub-b'), row('rail-xchain-hub-c'),
    row('rail-xchain-hub-b-pre-hb157-hub', 'exited'), row('rail-database'),
    row('rail-dogecoin-regtest-xchain-indexer'), row('rail-xchain-explorer')
]
const ENVIRONMENTS = {
    'rail-xchain-hub-id': ['HUB_DB_NAME=Hub_A'],
    'rail-xchain-hub-b-id': ['HUB_DB_NAME=Hub_B'],
    'rail-xchain-hub-c-id': ['HUB_DB_NAME=Hub_C'],
    'rail-xchain-hub-b-pre-hb157-hub-id': ['HUB_DB_NAME=Hub_Snapshot'],
    'rail-dogecoin-regtest-xchain-indexer-id': ['INDEXER_DB_NAME=Doge_Indexer']
}

function harness() {
    const rebuilt = [], events = [], logins = []
    const execFileAsync = sinon.stub().callsFake(async (command, args, options) => {
        if (args[0] === 'ps') return { stdout: CONTAINERS.map(value => JSON.stringify(value)).join('\n') }
        if (args[0] === 'inspect') return { stdout: JSON.stringify(ENVIRONMENTS[args[5]]) }
        const [script, database, table] = [args[6], args[8], args[9]]
        logins.push({ argv: args.join(' '), password: options && options.env && options.env.MYSQL_PWD })
        if (script.includes('mariadb-show')) return { stdout: `| ${table} |\n` }
        rebuilt.push(database + '.' + table)
        return { stdout: '' }
    })
    const dependencies = {
        HUB_MODULE_NAME: 'xchain-hub', INDEXER_MODULE_NAME: 'xchain-indexer', EXTERNAL_DB: false, execFileAsync,
        stopContainer: async (id) => { events.push('stop:' + id); return true },
        startContainer: async (id) => { events.push('start:' + id); return true },
        stopModuleContainer: (...args) => args[0](args[4]),
        getContainerStopSettings: sinon.stub().resolves(null),
        statusChanged: sinon.stub().resolves(),
        rootPassword: async () => 'root-pw'
    }
    return { rebuilt, events, logins, dependencies }
}

async function drive(state, extra = []) {
    const program = new Command()
    program.exitOverride()
    registerPreRecoveryCommands(program, {
        resetModules: sinon.stub().rejects(new Error('ordinary reset path called')),
        hubCheckpointDependencies: state.dependencies
    })
    const exit = sinon.stub(process, 'exit')
    try {
        await program.parseAsync(['node', 'xchain-node', 'reset', 'hub-checkpoints', '--yes', ...extra])
        return exit.firstCall && exit.firstCall.args[0]
    } finally {
        exit.restore()
    }
}

describe('CLI reset hub-checkpoints: federation peers and --with-capabilities @regression', function () {
    it('stops, rebuilds and restarts every federation peer with the CLI hub, never a drill snapshot', async function () {
        const state = harness()
        expect(await drive(state)).to.equal(0)
        for (const hub of ['rail-xchain-hub', 'rail-xchain-hub-b', 'rail-xchain-hub-c']) {
            expect(state.events).to.include('stop:' + hub + '-id')
            expect(state.events).to.include('start:' + hub + '-id')
        }
        expect(state.events.join(' ')).to.not.include('pre-hb157')
        for (const database of ['Hub_A', 'Hub_B', 'Hub_C']) expect(state.rebuilt).to.include(database + '.state_checkpoints')
        expect(state.rebuilt.join(' ')).to.not.include('Hub_Snapshot')
    })

    it('logs in with the resolved root password through MYSQL_PWD, never argv', async function () {
        const state = harness()
        expect(await drive(state)).to.equal(0)
        expect(state.logins.length).to.be.greaterThan(0)
        for (const login of state.logins) {
            expect(login.password).to.equal('root-pw')
            expect(login.argv).to.include('-e MYSQL_PWD rail-database-id')
            expect(login.argv).to.not.include('root-pw')
        }
    })

    it('leaves capability_snapshots alone unless asked', async function () {
        const state = harness()
        expect(await drive(state)).to.equal(0)
        expect(state.rebuilt.join(' ')).to.not.include('capability_snapshots')
    })

    it('rebuilds capability_snapshots on every hub and indexer mirror with --with-capabilities', async function () {
        const state = harness()
        expect(await drive(state, ['--with-capabilities'])).to.equal(0)
        for (const database of ['Hub_A', 'Hub_B', 'Hub_C', 'Doge_Indexer']) {
            expect(state.rebuilt).to.include(database + '.capability_snapshots')
        }
        expect(state.rebuilt).to.include('Doge_Indexer.state_checkpoints')
    })

    it('refuses --with-capabilities on any other reset before it resets anything', async function () {
        const resetModules = sinon.stub().resolves(true)
        const program = new Command()
        program.exitOverride()
        registerPreRecoveryCommands(program, { resetModules, hubCheckpointDependencies: harness().dependencies })
        const exit = sinon.stub(process, 'exit')
        const stderr = sinon.stub(process.stderr, 'write')
        try {
            await program.parseAsync(['node', 'xchain-node', 'reset', 'xchain-indexer', 'dogecoin', 'regtest', '--with-capabilities'])
        } finally {
            exit.restore()
            stderr.restore()
        }
        expect(exit.firstCall.args[0]).to.equal(1)
        expect(resetModules.called).to.equal(false)
    })
})
