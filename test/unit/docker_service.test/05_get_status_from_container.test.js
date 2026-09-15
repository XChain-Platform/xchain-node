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


    // getStatusFromContainer
    describe('getStatusFromContainer()', function () {
        it('runs docker inspect and returns parsed JSON', async function () {
            const stubs = makeStubs()
            const inspectData = [{ State: { Status: 'running' }, NetworkSettings: {} }]
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.deep.equal(['inspect', 'abc123'])
                cb(null, JSON.stringify(inspectData))
            })
            const ds = loadDockerService(stubs)
            const result = await ds.getStatusFromContainer('abc123')
            expect(result.State.Status).to.equal('running')
        })

        it('rejects on exec error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('not found'))
            })
            const ds = loadDockerService(stubs)
            try {
                await ds.getStatusFromContainer('bad-id')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })
})


describe('DockerService', function () {


    // Network operations
    describe('createDockerNetwork()', function () {
        it('creates network when inspect fails (network does not exist)', async function () {
            const stubs = makeStubs()
            let callNum = 0
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callNum++
                if (callNum === 1) {
                    expect(cmd).to.equal('docker')
                    expect(args).to.deep.equal(['network', 'inspect', 'mynet'])
                    cb(new Error('not found'))
                } else {
                    expect(cmd).to.equal('docker')
                    expect(args).to.deep.equal(['network', 'create', 'mynet'])
                    cb(null)
                }
            })
            const ds = loadDockerService(stubs)
            const result = await ds.createDockerNetwork('mynet')
            expect(result).to.be.true
        })

        it('resolves true when network already exists', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, '[]')
            })
            const ds = loadDockerService(stubs)
            const result = await ds.createDockerNetwork('mynet')
            expect(result).to.be.true
        })
    })
})

