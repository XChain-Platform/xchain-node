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
const { proxyquireDockerService } = require('../../helpers/docker_service_loader')

// Helpers
function makeStubs() {
    return {
        execFile: sinon.stub(),
        spawn: sinon.stub(),
        spawnSync: sinon.stub()
    }
}

function loadDockerService(stubs, fsStub) {
    return proxyquireDockerService(require.resolve('../../../src/services/docker_service'), {
        'child_process': {
            execFile: stubs.execFile,
            spawn: stubs.spawn,
            spawnSync: stubs.spawnSync
        },
        'util': { promisify: (fn) => fn },
        'fs': fsStub || { readFileSync: sinon.stub() },
        'blessed': {
            screen: sinon.stub().returns({
                key: sinon.stub(),
                on: sinon.stub(),
                render: sinon.stub(),
                destroy: sinon.stub()
            }),
            text: sinon.stub(),
            log: sinon.stub().returns({
                log: sinon.stub()
            })
        }
    })
}

describe('DockerService', function () {


    describe('stopContainer()', function () {
        it('runs docker stop <containerId>', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['stop', 'abc123'])
                cb(null, 'abc123\n')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.stopContainer('abc123')
            expect(result).to.be.true
        })

        it('rejects when stdout does not match', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, 'wrong')
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.stopContainer('abc123')
                expect.fail()
            } catch (err) {
                expect(err).to.include('abc123')
            }
        })
    })
})


describe('DockerService', function () {


    describe('stopContainerByName()', function () {
        // `docker stop` exits 0 whether the daemon left on SIGTERM or was killed
        // at the budget; the container's exit code is what tells them apart.
        function stopThenInspect(stubs, { stopErr = null, stopOut = 'xchain-node-bitcoin-mainnet-node\n', exitCode = '0', inspectErr = null } = {}) {
            const calls = []
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                calls.push(args)
                if (args[0] === 'stop') return cb(stopErr, stopOut)
                if (args[0] === 'inspect') return cb(inspectErr, exitCode + '\n')
                cb(new Error('unexpected ' + args.join(' ')))
            })
            return calls
        }

        it('runs docker stop -t <budget> <name> and reads the exit code after it', async function () {
            const stubs = makeStubs()
            const calls = stopThenInspect(stubs)
            const ds = loadDockerService(stubs)
            const outcome = await ds.stopContainerByName('xchain-node-bitcoin-mainnet-node', 600)
            expect(calls[0]).to.deep.equal(['stop', '-t', '600', 'xchain-node-bitcoin-mainnet-node'])
            expect(calls[1].slice(0, 2)).to.deep.equal(['inspect', '--format'])
            expect(outcome.stopped).to.be.true
            expect(outcome.killed).to.be.false
            expect(outcome.seconds).to.be.a('number')
        })

        it('reports a kill when the container exited 137', async function () {
            const stubs = makeStubs()
            stopThenInspect(stubs, { exitCode: '137' })
            const ds = loadDockerService(stubs)
            const outcome = await ds.stopContainerByName('xchain-node-bitcoin-mainnet-node', 600)
            expect(outcome).to.include({ stopped: true, killed: true })
        })

        it('reports not stopped, and does not inspect, when docker did not confirm the stop', async function () {
            const stubs = makeStubs()
            const calls = stopThenInspect(stubs, { stopErr: new Error('No such container') })
            const ds = loadDockerService(stubs)
            const outcome = await ds.stopContainerByName('xchain-node-bitcoin-mainnet-node', 600)
            expect(outcome).to.include({ stopped: false, killed: false })
            expect(calls).to.have.length(1)
        })

        it('treats an unreadable exit code as clean unless the stop consumed the whole budget', async function () {
            const stubs = makeStubs()
            stopThenInspect(stubs, { inspectErr: new Error('daemon unreachable') })
            const ds = loadDockerService(stubs)
            // A zero budget makes the elapsed time reach it on any machine.
            const atBudget = await ds.stopContainerByName('xchain-node-bitcoin-mainnet-node', 0)
            expect(atBudget.killed).to.be.true
            stopThenInspect(stubs, { inspectErr: new Error('daemon unreachable') })
            const inside = await ds.stopContainerByName('xchain-node-bitcoin-mainnet-node', 600)
            expect(inside.killed).to.be.false
        })
    })
})

