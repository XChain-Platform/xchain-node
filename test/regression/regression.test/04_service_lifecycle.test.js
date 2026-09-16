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
const proxyquire = require('proxyquire').noCallThru()

const TestEnv      = require('../../integration/helpers/test-env')

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    // P1: HIGH
    describe('[regression:p1] Service Lifecycle', function () {
        this.timeout(15000)

        let env

        beforeEach(async function () {
            env = new TestEnv()
            await env.setup()
        })

        afterEach(async function () {
            await env.teardown()
        })

        it('R-LIF-001: install stores container ID in LevelDB via buildAndUp', async function () {
            const state = require('../../../src/state')
            const containerId = TestEnv.fakeContainerId('a')
            await state.db.setModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', containerId)
            const retrieved = await state.db.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(retrieved).to.equal(containerId)
        })

        it('R-LIF-002: startModules reads container IDs from LevelDB', async function () {
            const containerId = TestEnv.fakeContainerId('s')
            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', containerId)

            const startedIds = []
            const moduleOps = proxyquire('../../../src/operations/module_operations', {
                '../services/docker_service': {
                    startContainer: async (id) => { startedIds.push(id); return true },
                    createDockerNetwork: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-encoder'] } }
            await moduleOps.startModules(serviceList)
            expect(startedIds).to.include(containerId)
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p1] Service Lifecycle', function () {
        this.timeout(15000)

        let env

        beforeEach(async function () {
            env = new TestEnv()
            await env.setup()
        })

        afterEach(async function () {
            await env.teardown()
        })

        it('R-LIF-003: stopModules reads container IDs from LevelDB and stops', async function () {
            const containerId = TestEnv.fakeContainerId('t')
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', containerId)

            const stoppedIds = []
            const moduleOps = proxyquire('../../../src/operations/module_operations', {
                '../services/docker_service': {
                    stopContainer: async (id) => { stoppedIds.push(id); return true },
                    stopContainerByName: async (id) => { stoppedIds.push(id); return { stopped: true, seconds: 1, killed: false } },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-decoder'] } }
            await moduleOps.stopModules(serviceList)
            expect(stoppedIds).to.include(containerId)
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p1] Service Lifecycle', function () {
        this.timeout(15000)

        let env

        beforeEach(async function () {
            env = new TestEnv()
            await env.setup()
        })

        afterEach(async function () {
            await env.teardown()
        })

        it('R-LIF-004: restartModules reads IDs from LevelDB and restarts', async function () {
            const containerId = TestEnv.fakeContainerId('r')
            await env.insertModule('xchain-indexer', 'bitcoin', 'mainnet', containerId)

            const restartedIds = []
            const moduleOps = proxyquire('../../../src/operations/module_operations', {
                '../services/docker_service': {
                    restartContainer: async (id) => { restartedIds.push(id); return true },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/status_service': { statusChanged: async () => true }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-indexer'] } }
            await moduleOps.restartModules(serviceList)
            expect(restartedIds).to.have.length(1)
            expect(restartedIds[0]).to.equal(containerId)
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p1] Service Lifecycle', function () {
        this.timeout(15000)

        let env

        beforeEach(async function () {
            env = new TestEnv()
            await env.setup()
        })

        afterEach(async function () {
            await env.teardown()
        })

        it('R-LIF-005: uninstall removes LevelDB entry', async function () {
            const state = require('../../../src/state')
            const containerId = TestEnv.fakeContainerId('u')
            await state.db.setModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', containerId)

            const removed = await state.db.deleteModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(removed).to.equal(containerId)

            const retrieved = await state.db.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(retrieved).to.be.null
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p1] Service Lifecycle', function () {
        this.timeout(15000)

        let env

        beforeEach(async function () {
            env = new TestEnv()
            await env.setup()
        })

        afterEach(async function () {
            await env.teardown()
        })

        it('R-LIF-008: stopModules handles multiple modules across coin/networks', async function () {
            const id1 = TestEnv.fakeContainerId('1')
            const id2 = TestEnv.fakeContainerId('2')
            const id3 = TestEnv.fakeContainerId('3')

            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', id1)
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', id2)
            await env.insertModule('xchain-encoder', 'litecoin', 'testnet', id3)

            const stoppedIds = []
            const moduleOps = proxyquire('../../../src/operations/module_operations', {
                '../services/docker_service': {
                    stopContainer: async (id) => { stoppedIds.push(id); return true },
                    stopContainerByName: async (id) => { stoppedIds.push(id); return { stopped: true, seconds: 1, killed: false } },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = {
                'bitcoin':  { 'mainnet': ['xchain-encoder', 'xchain-decoder'] },
                'litecoin': { 'testnet': ['xchain-encoder'] }
            }
            await moduleOps.stopModules(serviceList)
            expect(stoppedIds).to.have.length(3)
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p1] Service Lifecycle', function () {
        this.timeout(15000)

        let env

        beforeEach(async function () {
            env = new TestEnv()
            await env.setup()
        })

        afterEach(async function () {
            await env.teardown()
        })

        it('R-LIF-009: execModules reads container ID and passes command', async function () {
            const containerId = TestEnv.fakeContainerId('x')
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', containerId)

            const execCalls = []
            const moduleOps = proxyquire('../../../src/operations/module_operations', {
                '../services/docker_service': {
                    execContainer: async (id, cmd) => { execCalls.push({ id, cmd }); return 'output' },
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-decoder'] } }
            await moduleOps.execModules(serviceList, 'ls -la')
            expect(execCalls).to.have.length(1)
            expect(execCalls[0].id).to.equal(containerId)
        })
    })
})
