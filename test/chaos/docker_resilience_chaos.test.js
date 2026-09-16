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
const { proxyquireDockerService } = require('../helpers/docker_service_loader')

// Helpers
function makeStubs() {
    return {
        execFile: sinon.stub(),
        spawn: sinon.stub(),
        spawnSync: sinon.stub()
    }
}

function loadDockerService(stubs, fsStub) {
    return proxyquireDockerService(require.resolve('../../src/services/docker_service'), {
        'child_process': {
            execFile: stubs.execFile,
            spawn: stubs.spawn,
            spawnSync: stubs.spawnSync
        },
        'fs': fsStub || {
            readFileSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            createWriteStream: sinon.stub()
        },
        'blessed': {
            screen: sinon.stub().returns({
                key: sinon.stub(), on: sinon.stub(),
                render: sinon.stub(), destroy: sinon.stub()
            }),
            text: sinon.stub(),
            log: sinon.stub().returns({ log: sinon.stub() })
        }
    })
}

describe('Chaos: Docker Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // Experiment 3: Docker daemon unavailable (CMD-01, CMD-02)
    describe('Experiment 3: Docker daemon unavailable', function () {

        it('rejects when docker binary is not found (ENOENT)', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                const err = new Error('spawn docker ENOENT')
                err.code = 'ENOENT'
                cb(err)
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.checkDockerInstalledAndReachable()
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('docker --version')
            }
        })

        it('rejects when docker version succeeds but daemon is down', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callCount++
                if (callCount === 1) {
                    cb(null, 'Docker version 24.0.0, build abc1234')
                } else {
                    cb(new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'))
                }
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.checkDockerInstalledAndReachable()
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('docker ps')
            }
        })
    })
})

describe('Chaos: Docker Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('Experiment 3: Docker daemon unavailable', function () {

        it('rejects when docker version returns permission denied', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('Got permission denied while trying to connect to the Docker daemon socket'))
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.checkDockerInstalledAndReachable()
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.be.a('string')
            }
        })

        it('rejects when docker version returns empty output', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === '--version') {
                    cb(null, '')
                }
            })
            const ds = loadDockerService(stubs)

            try {
                await ds.checkDockerInstalledAndReachable()
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('format')
            }
        })
    })
})
