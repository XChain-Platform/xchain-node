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

const HUB = 'xchain-hub'
const INDEXER = 'xchain-indexer'

function row(name, state = 'running') {
    return { ID: name + '-id', Names: name, State: state }
}

function railContainers() {
    return [
        row('rail-a-xchain-hub'), row('rail-a-database'),
        row('rail-a-bitcoin-regtest-xchain-indexer'), row('rail-a-xchain-explorer'),
        row('rail-b-xchain-hub'), row('rail-b-database'),
        row('rail-b-dogecoin-regtest-xchain-indexer'), row('rail-b-xchain-explorer')
    ]
}

function railEnvironments() {
    return {
        'rail-a-xchain-hub-id': ['HUB_DB_NAME=RailA_Hub'],
        'rail-b-xchain-hub-id': ['HUB_DB_NAME=RailB_Hub'],
        'rail-a-bitcoin-regtest-xchain-indexer-id': ['INDEXER_DB_NAME=RailA_Bitcoin_Regtest_Indexer'],
        'rail-b-dogecoin-regtest-xchain-indexer-id': ['INDEXER_DB_NAME=RailB_Dogecoin_Regtest_Indexer']
    }
}

function makeHarness({ failHub = null } = {}) {
    const containers = railContainers()
    const events = []
    const databaseCalls = []
    const environments = railEnvironments()
    const execFileAsync = sinon.stub().callsFake(async (command, args) => {
        expect(command).to.equal('docker')
        if (args[0] === 'ps') return { stdout: containers.map(value => JSON.stringify(value)).join('\n') }
        if (args[0] === 'inspect') return { stdout: JSON.stringify(environments[args[5]]) }
        if (args[0] === 'exec') {
            const [script, database, table] = [args[6], args[8], args[9]]
            databaseCalls.push({ script, database, table })
            if (script.includes('mariadb-show')) return { stdout: `| ${table} |\n` }
            if (database === 'RailA_Hub' || database === 'RailB_Hub') events.push('recreate:' + args[3])
            else events.push('purge:' + args[3])
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
    const dependencies = {
        NODE_PREFIX: 'rail-a',
        HUB_MODULE_NAME: HUB,
        INDEXER_MODULE_NAME: INDEXER,
        EXTERNAL_DB: false,
        execFileAsync,
        stopContainer,
        startContainer,
        stopModuleContainer: (...args) => args[0](args[4]),
        getContainerStopSettings: sinon.stub().resolves(null),
        statusChanged,
        rootPassword: async () => 'root-pw'
    }
    return { events, databaseCalls, dependencies, statusChanged }
}

async function driveReset(harness) {
    const program = new Command()
    program.exitOverride()
    registerPreRecoveryCommands(program, {
        resetModules: sinon.stub().rejects(new Error('ordinary reset path called')),
        hubCheckpointDependencies: harness.dependencies
    })
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
        const exit = await driveReset(harness)

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

        expect(harness.events.filter(event => event.startsWith('recreate:'))).to.have.length(3)
        expect(harness.events.filter(event => event.startsWith('purge:'))).to.have.length(2)
        expect(harness.events.filter(event => event.startsWith('start:'))).to.have.length(3)
        // The caller's own stack only: rail-b is another stack and stays untouched.
        expect(harness.events.filter(event => event.includes('rail-b'))).to.have.length(0)
        expect(harness.statusChanged.calledOnce).to.equal(true)

        const mutations = harness.databaseCalls.filter(call => call.script.includes('mariadb-dump'))
        for (const table of ['state_checkpoints', 'snapshot_checkpoints', 'anchor_published_checkpoints']) {
            expect(mutations.map(call => call.table)).to.contain(table)
        }
        expect(harness.databaseCalls.map(call => call.table).join('\n')).to.not.match(/price|validator|config|consensus_state/i)
    })

    it('refuses before any database mutation or mirror stop when one hub will not stop', async function () {
        const harness = makeHarness({ failHub: 'rail-a-xchain-hub-id' })
        const exit = await driveReset(harness)

        sinon.assert.calledOnceWithExactly(exit, 1)
        expect(harness.databaseCalls.some(call => call.script.includes('mariadb-dump'))).to.equal(false)
        expect(harness.events).to.deep.equal([
            'stop:rail-a-xchain-hub-id'
        ])
        expect(harness.statusChanged.called).to.equal(false)
    })
})

// A shared docker host can carry other stacks beside the CLI's own: one with no database
// container at all, or one whose database will not take this CLI's root password. Neither
// may abort, or be touched by, the reset of the CLI's own stack.
const { resetHubCheckpoints } = require('../../../src/cli/reset_hub_checkpoints')
const DENIED = 'ERROR 1045 (28000): Access denied for user root'
const OWN = 'xchain-node'

function ownStack({ withDatabase = true } = {}) {
    return [
        row(OWN + '-xchain-hub'),
        ...(withDatabase ? [row(OWN + '-database')] : []),
        row(OWN + '-bitcoin-regtest-xchain-indexer'), row(OWN + '-xchain-explorer')
    ]
}

// refuse: the database container whose login is refused, and how ('reject' or 'stderr').
function makeForeignHarness({ containers, refuse = null, refusal = 'reject' }) {
    const environments = {
        [OWN + '-xchain-hub-id']: ['HUB_DB_NAME=Own_Hub'],
        [OWN + '-bitcoin-regtest-xchain-indexer-id']: ['INDEXER_DB_NAME=Own_Bitcoin_Regtest_Indexer'],
        'zz9-xchain-hub-id': ['HUB_DB_NAME=Zz9_Hub'],
        'xcsw1-xchain-hub-id': ['HUB_DB_NAME=H_xcsw1_xchain_hub'],
        'xcsw1-bitcoin-regtest-xchain-indexer-id': ['INDEXER_DB_NAME=Xcsw1_Bitcoin_Regtest_Indexer']
    }
    const calls = [], stops = [], starts = [], rebuilds = []
    const execFileAsync = sinon.stub().callsFake(async (command, args) => {
        calls.push(args.join(' '))
        if (args[0] === 'ps') return { stdout: containers.map(value => JSON.stringify(value)).join('\n') }
        if (args[0] === 'inspect') return { stdout: JSON.stringify(environments[args[5]]) }
        if (args[0] === 'exec') {
            const [container, script, database, table] = [args[3], args[6], args[8], args[9]]
            if (container === refuse) {
                if (refusal === 'reject') throw Object.assign(new Error('Command failed'), { stderr: DENIED })
                return { stdout: '', stderr: DENIED }
            }
            if (script.includes('mariadb-show')) return { stdout: `| ${table} |\n` }
            rebuilds.push(`${database}.${table}`)
            return { stdout: '' }
        }
        throw new Error('unexpected docker call: ' + args.join(' '))
    })
    const dependencies = {
        NODE_PREFIX: OWN,
        HUB_MODULE_NAME: HUB,
        INDEXER_MODULE_NAME: INDEXER,
        EXTERNAL_DB: false,
        execFileAsync,
        stopContainer: sinon.stub().callsFake(async (id) => { stops.push(id); return true }),
        startContainer: sinon.stub().callsFake(async (id) => { starts.push(id); return true }),
        stopModuleContainer: (...args) => args[0](args[4]),
        getContainerStopSettings: sinon.stub().resolves(null),
        statusChanged: sinon.stub().resolves(),
        rootPassword: async () => 'root-pw'
    }
    return { calls, stops, starts, rebuilds, dependencies }
}

function expectOwnStackReset(harness) {
    const ownIds = [OWN + '-xchain-hub-id', OWN + '-bitcoin-regtest-xchain-indexer-id', OWN + '-xchain-explorer-id']
    expect(harness.stops).to.deep.equal(ownIds)
    expect(harness.starts).to.have.members(ownIds)
    expect(harness.rebuilds).to.have.members([
        'Own_Hub.state_checkpoints', 'Own_Hub.snapshot_checkpoints', 'Own_Hub.anchor_published_checkpoints',
        'Own_Bitcoin_Regtest_Indexer.state_checkpoints', 'Own_Bitcoin_Regtest_Indexer_HubMirror.state_checkpoints'
    ])
}

function expectForeignUntouched(harness, foreignPrefix) {
    const named = text => text.includes(foreignPrefix + '-')
    expect(harness.stops.filter(named)).to.deep.equal([])
    expect(harness.starts.filter(named)).to.deep.equal([])
    // Not inspected, not queried: the only call that may name it is the host listing itself.
    expect(harness.calls.filter(call => !call.startsWith('ps ')).filter(named)).to.deep.equal([])
}

describe('CLI reset hub-checkpoints: foreign stacks on the same host', function () {
    it('@regression resets its own stack while a foreign hub with no database container runs', async function () {
        const harness = makeForeignHarness({ containers: ownStack().concat([row('zz9-xchain-hub')]) })

        expect(await resetHubCheckpoints(true, harness.dependencies)).to.equal(true)
        expectOwnStackReset(harness)
        expectForeignUntouched(harness, 'zz9')
    })

    it('@regression resets its own stack when a foreign database rejects the root login', async function () {
        const harness = makeForeignHarness({
            containers: ownStack().concat([row('xcsw1-xchain-hub'), row('xcsw1-database'),
                row('xcsw1-bitcoin-regtest-xchain-indexer')]),
            refuse: 'xcsw1-database-id'
        })

        expect(await resetHubCheckpoints(true, harness.dependencies)).to.equal(true)
        expectOwnStackReset(harness)
        expectForeignUntouched(harness, 'xcsw1')
    })

    it('@regression resets its own stack when a foreign database answers the root login with only a refusal', async function () {
        const harness = makeForeignHarness({
            containers: ownStack().concat([row('xcsw1-xchain-hub'), row('xcsw1-database'),
                row('xcsw1-bitcoin-regtest-xchain-indexer')]),
            refuse: 'xcsw1-database-id', refusal: 'stderr'
        })

        expect(await resetHubCheckpoints(true, harness.dependencies)).to.equal(true)
        expectOwnStackReset(harness)
        expectForeignUntouched(harness, 'xcsw1')
    })

    it('@regression still refuses before any stop when its own stack has no database container', async function () {
        const harness = makeForeignHarness({ containers: ownStack({ withDatabase: false }) })

        let failure = null
        try { await resetHubCheckpoints(true, harness.dependencies) } catch (err) { failure = err }
        expect(failure && failure.message).to.equal(
            'reset hub-checkpoints: no database container found for ' + OWN + '-xchain-hub')
        expect(harness.stops).to.deep.equal([])
        expect(harness.rebuilds).to.deep.equal([])
    })

    it('@regression still refuses before any stop when its own database rejects the root login', async function () {
        const harness = makeForeignHarness({ containers: ownStack(), refuse: OWN + '-database-id' })

        let failure = null
        try { await resetHubCheckpoints(true, harness.dependencies) } catch (err) { failure = err }
        expect(failure && failure.message).to.equal('reset hub-checkpoints: the database refused the root login')
        expect(harness.stops).to.deep.equal([])
        expect(harness.rebuilds).to.deep.equal([])
    })
})
