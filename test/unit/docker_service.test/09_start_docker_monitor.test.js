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


    // startDockerMonitor
    describe('startDockerMonitor()', function () {
        it('rejects when containerIds is empty', async function () {
            const stubs = makeStubs()
            const ds = loadDockerService(stubs)
            try {
                await ds.startDockerMonitor([], true)
                expect.fail()
            } catch (err) {
                expect(err).to.include('No container')
            }
        })

        it('rejects when containerIds is null', async function () {
            const stubs = makeStubs()
            const ds = loadDockerService(stubs)
            try {
                await ds.startDockerMonitor(null, true)
                expect.fail()
            } catch (err) {
                expect(err).to.include('No container')
            }
        })
    })
})


function registerAddContainerToNetworkSuccesses() {
    it('connects container when not already in network', async function () {
        const stubs = makeStubs()
        // First call: docker inspect → container status
        // Second call: docker network connect → success
        let callCount = 0
        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            callCount++
            if (args[0] === 'inspect') {
                // Return container with no networks
                cb(null, JSON.stringify([{
                    NetworkSettings: { Networks: {} }
                }]))
            } else if (args[0] === 'network' && args[1] === 'connect') {
                cb(null)
            } else {
                cb(null, '')
            }
        })
        const ds = loadDockerService(stubs)
        const result = await ds.addContainerToNetwork('abc123', 'mynet')
        expect(result).to.be.true
        expect(stubs.execFile.getCalls().some(c => c.args[1] && c.args[1][1] === 'connect')).to.be.true
    })

    it('skips connect when container already in network', async function () {
        const stubs = makeStubs()
        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            if (args[0] === 'inspect') {
                cb(null, JSON.stringify([{
                    NetworkSettings: { Networks: { mynet: { IPAddress: '172.0.0.2' } } }
                }]))
            } else {
                cb(null, '')
            }
        })
        const ds = loadDockerService(stubs)
        const result = await ds.addContainerToNetwork('abc123', 'mynet')
        expect(result).to.be.true
        // Should NOT have called network connect
        expect(stubs.execFile.getCalls().some(c => c.args[1] && c.args[1][1] === 'connect')).to.be.false
    })
}

function registerAddContainerToNetworkFailures() {
    it('rejects when network connect fails', async function () {
        const stubs = makeStubs()
        stubs.execFile.callsFake((cmd, args, ...rest) => {
            const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
            if (args[0] === 'inspect') {
                cb(null, JSON.stringify([{
                    NetworkSettings: { Networks: {} }
                }]))
            } else if (args[0] === 'network' && args[1] === 'connect') {
                cb(new Error('network connect failed'))
            } else {
                cb(null, '')
            }
        })
        const ds = loadDockerService(stubs)
        try {
            await ds.addContainerToNetwork('abc123', 'mynet')
            expect.fail()
        } catch (err) {
            expect(err).to.be.an.instanceOf(Error)
        }
    })
}

describe('DockerService', function () {

    // addContainerToNetwork
    describe('addContainerToNetwork()', registerAddContainerToNetworkSuccesses)
    describe('addContainerToNetwork()', registerAddContainerToNetworkFailures)
})

