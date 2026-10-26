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

// `reset --db-container` serves a stack this CLI did not install, one that runs its own MariaDB container.
// Every DB step must land on that server, its services are found by container name rather than through this
// CLI's registry, nothing is pushed to the hub or explorer, and no node datadir is ever wiped on that path.

const { sinon, expect, makeStubs, loadOperations, registerLifecycleHooks } = require('../helpers/harness')

const NAMED_DB = 'xchain-rail-database'
const DECODER = 'xchain-decoder'
const INDEXER = 'xchain-indexer'
// The harness names containers `${coin}-${network}-${module}`.
const SERVICE_IDS = {
    'bitcoin-regtest-xchain-decoder': 'a'.repeat(64),
    'bitcoin-regtest-xchain-indexer': 'b'.repeat(64)
}

// Answer `docker inspect` by container name: an id, docker's own "no such object", or a given failure.
// The callback hands back an object so the harness promisify resolves the { stdout } shape node's does.
function dockerAnswersByName(stubs, answers = SERVICE_IDS) {
    stubs.execFile.callsFake((cmd, args, cb) => {
        if (cmd === 'docker' && args[0] === 'inspect' && args[1] === '--type') {
            const name = args[args.length - 1]
            const answer = answers[name]
            if (answer instanceof Error) return cb(answer)
            if (answer === undefined) {
                const gone = new Error('Error: No such object: ' + name)
                gone.stderr = gone.message
                return cb(gone)
            }
            return cb(null, { stdout: answer + '\n' })
        }
        return cb(null, '', '')
    })
}

// Run a reset past the post-reset bounce's settle sleep, with its console output captured.
async function runReset(ops, args, logged = []) {
    const log = sinon.stub(console, 'log').callsFake((...a) => logged.push(a.join(' ')))
    const clock = sinon.useFakeTimers()
    try {
        const promise = ops.resetModules(...args)
        await clock.tickAsync(6000)
        return await promise
    } finally {
        clock.restore()
        log.restore()
    }
}

describe('moduleOperations', function () {
    registerLifecycleHooks(() => {})

    describe('resetModules() with --db-container', function () {

        it('runs the database drop and the hub fence clear on the named server', async function () {
            const stubs = makeStubs()
            dockerAnswersByName(stubs)
            const ops = loadOperations(stubs)

            const result = await runReset(ops, [DECODER, 'bitcoin', 'regtest', true, true, { dbContainer: NAMED_DB }])

            expect(result).to.be.true
            sinon.assert.calledOnceWithExactly(stubs.resolveNamedDatabaseTarget, NAMED_DB, 'bitcoin', 'regtest', [DECODER, INDEXER])
            const target = await stubs.resolveNamedDatabaseTarget.firstCall.returnValue
            expect(stubs.resetDatabases.firstCall.args).to.deep.equal(['bitcoin', 'regtest', [DECODER, INDEXER], target])
            expect(stubs.clearHubPriceIngestWatermark.firstCall.args).to.deep.equal(['bitcoin', 'regtest', target])
            // The bundled server is never asked: not its container, not its cached root.
            expect(stubs.getDatabaseContainerId.called).to.be.false
            expect(stubs.askMariadbRootPassword.called).to.be.false
        })

        it('stops and restarts the containers found by name, never through the registry', async function () {
            const stubs = makeStubs()
            dockerAnswersByName(stubs)
            const ops = loadOperations(stubs)

            await runReset(ops, [DECODER, 'bitcoin', 'regtest', true, true, { dbContainer: NAMED_DB }])

            const stopped = stubs.stopContainer.args.map((a) => a[0])
            const started = stubs.startContainer.args.map((a) => a[0])
            expect(stopped).to.include.members(Object.values(SERVICE_IDS))
            expect(started).to.include.members(Object.values(SERVICE_IDS))
            expect(stopped).to.not.include('container-id-123')
            expect(stubs.db.getModuleContainerStrict.called).to.be.false
        })

        it('pushes no config to the hub or explorer after the restart', async function () {
            const stubs = makeStubs()
            dockerAnswersByName(stubs)
            const ops = loadOperations(stubs)
            const logged = []

            expect(await runReset(ops, [DECODER, 'bitcoin', 'regtest', true, true, { dbContainer: NAMED_DB }], logged)).to.be.true

            expect(stubs.statusChanged.called).to.be.false
            expect(logged.join('\n')).to.contain('Skipped the hub and explorer config push')
        })
    })
})

describe('moduleOperations', function () {
    registerLifecycleHooks(() => {})

    describe('resetModules() with --db-container', function () {

        for (const service of ['all', 'node', 'xchain-utxo-tracker']) {
            it(`refuses '${service}' before anything is resolved, stopped or wiped`, async function () {
                const stubs = makeStubs()
                dockerAnswersByName(stubs)
                const ops = loadOperations(stubs)
                const logged = []

                expect(await runReset(ops, [service, 'bitcoin', 'regtest', true, false, { dbContainer: NAMED_DB }], logged)).to.be.false

                expect(stubs.resolveNamedDatabaseTarget.called).to.be.false
                expect(stubs.stopContainer.called).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                expect(stubs.execFile.args.some((a) => a[1] && a[1][0] === 'run')).to.be.false
                expect(logged.join('\n')).to.contain('No data was touched')
            })
        }

        it('refuses the override in external-DB mode', async function () {
            const stubs = makeStubs()
            dockerAnswersByName(stubs)
            const ops = loadOperations(stubs, { EXTERNAL_DB: true })

            expect(await runReset(ops, [DECODER, 'bitcoin', 'regtest', true, true, { dbContainer: NAMED_DB }])).to.be.false
            expect(stubs.resolveNamedDatabaseTarget.called).to.be.false
            expect(stubs.resetDatabases.called).to.be.false
        })
    })
})

describe('moduleOperations', function () {
    registerLifecycleHooks(() => {})

    describe('resetModules() with --db-container', function () {

        it('refuses before stopping anything when the named server cannot be used', async function () {
            const stubs = makeStubs()
            dockerAnswersByName(stubs)
            stubs.resolveNamedDatabaseTarget.rejects(new Error('xchain-rail-database holds no database XChain_BTC_Regtest_Decoder'))
            const ops = loadOperations(stubs)
            const logged = []

            expect(await runReset(ops, [DECODER, 'bitcoin', 'regtest', true, true, { dbContainer: NAMED_DB }], logged)).to.be.false

            expect(stubs.stopContainer.called).to.be.false
            expect(stubs.resetDatabases.called).to.be.false
            expect(logged.join('\n')).to.contain('holds no database XChain_BTC_Regtest_Decoder')
        })

        // Only docker saying "no such container" is absence: a failed inspect must not let the drop run under a live decoder.
        it('refuses and drops nothing when a service container cannot be inspected', async function () {
            const stubs = makeStubs()
            dockerAnswersByName(stubs, {
                ...SERVICE_IDS,
                'bitcoin-regtest-xchain-decoder': new Error('permission denied while trying to connect to the Docker daemon')
            })
            const ops = loadOperations(stubs)

            expect(await runReset(ops, [DECODER, 'bitcoin', 'regtest', true, true, { dbContainer: NAMED_DB }])).to.be.false
            expect(stubs.resetDatabases.called).to.be.false
        })
    })
})

describe('moduleOperations', function () {
    registerLifecycleHooks(() => {})

    describe('resetModules() with --db-container', function () {

        it('leaves a reset without the flag on the registry, the bundled server and the config push', async function () {
            const stubs = makeStubs()
            dockerAnswersByName(stubs)
            const ops = loadOperations(stubs)

            expect(await runReset(ops, [DECODER, 'bitcoin', 'regtest', true, true])).to.be.true

            expect(stubs.resolveNamedDatabaseTarget.called).to.be.false
            expect(stubs.resetDatabases.firstCall.args).to.deep.equal(['bitcoin', 'regtest', [DECODER, INDEXER]])
            expect(stubs.clearHubPriceIngestWatermark.firstCall.args).to.deep.equal(['bitcoin', 'regtest'])
            expect(stubs.askMariadbRootPassword.called).to.be.true
            expect(stubs.db.getModuleContainerStrict.called).to.be.true
            expect(stubs.stopContainer.args.map((a) => a[0])).to.include('container-id-123')
            expect(stubs.statusChanged.calledOnce).to.be.true
        })
    })
})
