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
const resetOperations = require('../../../src/operations/module_operations/reset_modules')
const { registerPreRecoveryCommands } = require('../../../src/cli/errors')

const HUB = 'xchain-hub'
const INDEXER = 'xchain-indexer'

function row(name, state = 'running') {
    return { ID: name + '-id', Names: name, State: state }
}

function makeHarness({ failHub = null } = {}) {
    const containers = [
        row('rail-a-xchain-hub'),
        row('rail-a-database'),
        row('rail-a-bitcoin-regtest-xchain-indexer'),
        row('rail-a-xchain-explorer'),
        row('rail-b-xchain-hub'),
        row('rail-b-database'),
        row('rail-b-dogecoin-regtest-xchain-indexer'),
        row('rail-b-xchain-explorer')
    ]
    const events = []
    const sql = []
    const environments = {
        'rail-a-xchain-hub-id': ['HUB_DB_NAME=RailA_Hub'],
        'rail-b-xchain-hub-id': ['HUB_DB_NAME=RailB_Hub'],
        'rail-a-bitcoin-regtest-xchain-indexer-id': ['INDEXER_DB_NAME=RailA_Bitcoin_Regtest_Indexer'],
        'rail-b-dogecoin-regtest-xchain-indexer-id': ['INDEXER_DB_NAME=RailB_Dogecoin_Regtest_Indexer']
    }
    const execFileAsync = sinon.stub().callsFake(async (command, args) => {
        expect(command).to.equal('docker')
        if (args[0] === 'ps') return { stdout: containers.map(value => JSON.stringify(value)).join('\n') }
        if (args[0] === 'inspect') return { stdout: JSON.stringify(environments[args[5]]) }
        if (args[0] === 'exec') {
            const statement = args[args.length - 1]
            sql.push(statement)
            if (statement.startsWith('SELECT COUNT(*)')) return { stdout: '1\n' }
            if (statement.includes('CREATE TABLE')) events.push('recreate:' + args[1])
            if (statement.includes('TRUNCATE TABLE')) events.push('purge:' + args[1])
            return { stdout: '' }
        }
        throw new Error('unexpected docker call: ' + args.join(' '))
    })
    const stopContainer = sinon.stub().callsFake(async (id) => {
        events.push('stop:' + id)
        if (id === failHub) throw new Error('hub refused SIGTERM')
        return true
    })
    const startContainer = sinon.stub().callsFake(async (id) => {
        events.push('start:' + id)
        return true
    })
    const statusChanged = sinon.stub().resolves()
    resetOperations.configure({
        Coin: { BITCOIN: 'bitcoin', LITECOIN: 'litecoin', DOGECOIN: 'dogecoin' },
        Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' },
        NODE_MODULE_NAME: 'node',
        HUB_MODULE_NAME: HUB,
        XChainService: {
            XCHAIN_UTXO_TRACKER: 'xchain-utxo-tracker',
            XCHAIN_DECODER: 'xchain-decoder',
            XCHAIN_INDEXER: INDEXER,
            XCHAIN_REGTEST_MINER: 'xchain-regtest-miner'
        },
        EXTERNAL_DB: false,
        execFileAsync,
        readline: {},
        stopContainer,
        startContainer,
        stopModuleContainer: (...args) => args[0](args[4]),
        getContainerStopSettings: sinon.stub().resolves(null),
        statusChanged,
        failureReason: err => err && err.message ? err.message : String(err)
    })
    return { events, sql, statusChanged }
}

async function driveReset() {
    const program = new Command()
    program.exitOverride()
    registerPreRecoveryCommands(program, { resetModules: resetOperations.resetModules })
    const exit = sinon.stub(process, 'exit')
    try {
        await program.parseAsync(['node', 'xchain-node', 'reset', 'hub-checkpoints', '--yes'])
        return exit
    } catch (err) {
        exit.restore()
        throw err
    }
}

describe('CLI reset hub-checkpoints', function () {
    afterEach(function () {
        if (process.exit.restore) process.exit.restore()
    })

    it('stops every rail, recreates only checkpoint tables, purges every mirror, and restarts', async function () {
        const harness = makeHarness()
        const exit = await driveReset()

        sinon.assert.calledOnceWithExactly(exit, 0)
        const lastStop = Math.max(...harness.events.map((event, index) => event.startsWith('stop:') ? index : -1))
        const firstRecreate = harness.events.findIndex(event => event.startsWith('recreate:'))
        const lastRecreate = Math.max(...harness.events.map((event, index) => event.startsWith('recreate:') ? index : -1))
        const firstPurge = harness.events.findIndex(event => event.startsWith('purge:'))
        const lastPurge = Math.max(...harness.events.map((event, index) => event.startsWith('purge:') ? index : -1))
        const firstStart = harness.events.findIndex(event => event.startsWith('start:'))
        expect(lastStop).to.be.lessThan(firstRecreate)
        expect(lastRecreate).to.be.lessThan(firstPurge)
        expect(lastPurge).to.be.lessThan(firstStart)

        expect(harness.events.filter(event => event.startsWith('recreate:'))).to.have.length(6)
        expect(harness.events.filter(event => event.startsWith('purge:'))).to.have.length(4)
        expect(harness.events.filter(event => event.startsWith('start:'))).to.have.length(6)
        expect(harness.statusChanged.calledOnce).to.equal(true)

        const mutationSql = harness.sql.filter(statement => /CREATE TABLE|TRUNCATE TABLE/.test(statement)).join('\n')
        for (const table of ['state_checkpoints', 'snapshot_checkpoints', 'anchor_published_checkpoints']) {
            expect(mutationSql).to.contain(table)
        }
        expect(harness.sql.join('\n')).to.not.match(/price|validator|config|consensus_state/i)
    })

    it('refuses before any database mutation or mirror stop when one hub will not stop', async function () {
        const harness = makeHarness({ failHub: 'rail-b-xchain-hub-id' })
        const exit = await driveReset()

        sinon.assert.calledOnceWithExactly(exit, 1)
        expect(harness.sql.some(statement => /CREATE TABLE|TRUNCATE TABLE/.test(statement))).to.equal(false)
        expect(harness.events).to.deep.equal([
            'stop:rail-a-xchain-hub-id',
            'stop:rail-b-xchain-hub-id',
            'start:rail-a-xchain-hub-id'
        ])
        expect(harness.statusChanged.called).to.equal(false)
    })
})
