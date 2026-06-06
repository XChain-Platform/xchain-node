'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const {
    XChainService, DB_MODULE_NAME, NODE_MODULE_NAME,
    HUB_MODULE_NAME, EXPLORER_MODULE_NAME,
    Coin, Network
} = require('../../src/config/constants')

const TestEnv        = require('./helpers/test-env')
const CommandCapture = require('./helpers/command-capture')

describe('Integration: Multi-Module Orchestration', function () {
    this.timeout(15000)

    let env, capture

    beforeEach(async function () {
        env = new TestEnv()
        await env.setup()
        env.patchConstants()
        capture = new CommandCapture()
    })

    afterEach(async function () {
        await env.teardown()
    })

    // ---------------------------------------------------------------
    // installModules
    // ---------------------------------------------------------------

    describe('installModules orchestration', function () {

        it('creates Docker network and database before installing modules', async function () {
            const callOrder = []

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    createDockerNetwork: async (network) => {
                        callOrder.push('network:' + network)
                        return true
                    },
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/DatabaseService': {
                    buildDatabaseModule: async (coin, network) => {
                        callOrder.push('database:' + coin + '-' + network)
                        return true
                    }
                },
                '../services/ModuleService': {
                    installModule: async (module, coin, network) => {
                        callOrder.push('install:' + module + ':' + coin + '-' + network)
                        return TestEnv.fakeContainerId('m')
                    },
                    cloneGit: async () => true
                }
            })

            const serviceList = {
                'bitcoin': { 'mainnet': ['xchain-encoder', 'xchain-decoder'] }
            }

            await moduleOps.installModules(serviceList)

            // Network created first
            expect(callOrder[0]).to.equal('network:xchain-node-bitcoin-mainnet')

            // Database built second
            expect(callOrder[1]).to.equal('database:bitcoin-mainnet')

            // Then modules installed
            expect(callOrder[2]).to.equal('install:xchain-encoder:bitcoin-mainnet')
            expect(callOrder[3]).to.equal('install:xchain-decoder:bitcoin-mainnet')
        })

        it('processes multiple coin/network stacks sequentially', async function () {
            const installed = []

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/DatabaseService': {
                    buildDatabaseModule: async () => true
                },
                '../services/ModuleService': {
                    installModule: async (module, coin, network) => {
                        installed.push({ module, coin, network })
                        return TestEnv.fakeContainerId('m')
                    },
                    cloneGit: async () => true
                }
            })

            const serviceList = {
                'bitcoin': { 'mainnet': ['xchain-encoder'] },
                'litecoin': { 'testnet': ['xchain-decoder'] },
                '': { '': [EXPLORER_MODULE_NAME] }
            }

            await moduleOps.installModules(serviceList)

            expect(installed).to.have.length(3)
            expect(installed[0]).to.deep.include({ module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet' })
            expect(installed[1]).to.deep.include({ module: 'xchain-decoder', coin: 'litecoin', network: 'testnet' })
            expect(installed[2]).to.deep.include({ module: EXPLORER_MODULE_NAME, coin: '', network: '' })
        })

        it('skips database creation for shared services (empty coin/network)', async function () {
            let databaseCalled = false

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/DatabaseService': {
                    buildDatabaseModule: async () => { databaseCalled = true; return true }
                },
                '../services/ModuleService': {
                    installModule: async () => TestEnv.fakeContainerId('m'),
                    cloneGit: async () => true
                }
            })

            // Only shared services (explorer)
            const serviceList = {
                '': { '': [EXPLORER_MODULE_NAME] }
            }

            await moduleOps.installModules(serviceList)

            // Database should NOT be called for empty coin/network
            expect(databaseCalled).to.be.false
        })
    })

    // ---------------------------------------------------------------
    // updateModules
    // ---------------------------------------------------------------

    describe('updateModules orchestration', function () {

        it('reads old container ID from LevelDB and passes it to installModule', async function () {
            const oldContainerId = TestEnv.fakeContainerId('o')
            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', oldContainerId)

            const installCalls = []

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/ModuleService': {
                    installModule: async (module, coin, network, remoteUpdate, overwriteId) => {
                        installCalls.push({ module, coin, network, overwriteId })
                        return TestEnv.fakeContainerId('n')
                    },
                    cloneGit: async () => true
                },
                '../services/DatabaseService': {
                    buildDatabaseModule: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-encoder'] } }
            await moduleOps.updateModules(serviceList)

            expect(installCalls).to.have.length(1)
            expect(installCalls[0].module).to.equal('xchain-encoder')
            expect(installCalls[0].overwriteId).to.equal(oldContainerId)
        })

        it('clones git for non-node modules before installing', async function () {
            const oldContainerId = TestEnv.fakeContainerId('o')
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', oldContainerId)

            const clonedModules = []

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/ModuleService': {
                    installModule: async () => TestEnv.fakeContainerId('n'),
                    cloneGit: async (module) => { clonedModules.push(module); return true }
                },
                '../services/DatabaseService': {
                    buildDatabaseModule: async () => true
                }
            })

            const serviceList = { 'bitcoin': { 'mainnet': ['xchain-decoder'] } }
            await moduleOps.updateModules(serviceList)

            expect(clonedModules).to.include('xchain-decoder')
        })
    })

    // ---------------------------------------------------------------
    // uninstallModules
    // ---------------------------------------------------------------

    describe('uninstallModules orchestration', function () {

        it('calls uninstallModule for each service in the list', async function () {
            // Modules must exist in LevelDB for uninstall to proceed
            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', TestEnv.fakeContainerId('1'))
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', TestEnv.fakeContainerId('2'))
            await env.insertModule('xchain-indexer', 'dogecoin', 'testnet', TestEnv.fakeContainerId('3'))

            const uninstalled = []

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/ModuleService': {
                    uninstallModule: async (coin, network, module) => {
                        uninstalled.push({ coin, network, module })
                        return true
                    },
                    cloneGit: async () => true,
                    installModule: async () => true
                },
                '../services/DatabaseService': {
                    buildDatabaseModule: async () => true
                }
            })

            const serviceList = {
                'bitcoin': { 'mainnet': ['xchain-encoder', 'xchain-decoder'] },
                'dogecoin': { 'testnet': ['xchain-indexer'] }
            }

            await moduleOps.uninstallModules(serviceList)

            expect(uninstalled).to.have.length(3)
            expect(uninstalled[0]).to.deep.include({ coin: 'bitcoin', network: 'mainnet', module: 'xchain-encoder' })
            expect(uninstalled[1]).to.deep.include({ coin: 'bitcoin', network: 'mainnet', module: 'xchain-decoder' })
            expect(uninstalled[2]).to.deep.include({ coin: 'dogecoin', network: 'testnet', module: 'xchain-indexer' })
        })

        it('continues uninstalling remaining modules when one fails', async function () {
            // Modules must exist in LevelDB for uninstall to proceed
            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', TestEnv.fakeContainerId('1'))
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', TestEnv.fakeContainerId('2'))
            await env.insertModule('xchain-indexer', 'bitcoin', 'mainnet', TestEnv.fakeContainerId('3'))

            const uninstalled = []
            let failCount = 0

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/ModuleService': {
                    uninstallModule: async (coin, network, module) => {
                        if (module === 'xchain-decoder') {
                            failCount++
                            throw new Error('Simulated failure')
                        }
                        uninstalled.push(module)
                        return true
                    },
                    cloneGit: async () => true,
                    installModule: async () => true
                },
                '../services/DatabaseService': {
                    buildDatabaseModule: async () => true
                }
            })

            const serviceList = {
                'bitcoin': { 'mainnet': ['xchain-encoder', 'xchain-decoder', 'xchain-indexer'] }
            }

            const result = await moduleOps.uninstallModules(serviceList)

            // Should continue past the failure
            expect(result).to.be.true
            expect(uninstalled).to.deep.equal(['xchain-encoder', 'xchain-indexer'])
            expect(failCount).to.equal(1)
        })
    })

    // ---------------------------------------------------------------
    // Full filterCommandParameters -> installModules pipeline
    // ---------------------------------------------------------------

    describe('filterCommandParameters -> installModules end-to-end', function () {

        it('"all bitcoin mainnet" installs correct set in correct order', async function () {
            const { filterCommandParameters } = require('../../src/services/ConfigService')
            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')

            const installed = []
            let networkCreated = false
            let databaseCreated = false

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    createDockerNetwork: async () => { networkCreated = true; return true },
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/DatabaseService': {
                    buildDatabaseModule: async () => { databaseCreated = true; return true }
                },
                '../services/ModuleService': {
                    installModule: async (module) => {
                        installed.push(module)
                        return TestEnv.fakeContainerId('m')
                    },
                    cloneGit: async () => true
                }
            })

            await moduleOps.installModules(serviceList)

            expect(networkCreated).to.be.true
            expect(databaseCreated).to.be.true

            // Core modules should be installed
            expect(installed).to.include('xchain-encoder')
            expect(installed).to.include('xchain-decoder')
            expect(installed).to.include('xchain-utxo-tracker')
            expect(installed).to.include('xchain-indexer')
            expect(installed).to.include('node')

            // Explorer (shared) should be installed too
            expect(installed).to.include(EXPLORER_MODULE_NAME)

            // Regtest modules should NOT be installed on mainnet
            expect(installed).to.not.include('xchain-regtest-miner')
            expect(installed).to.not.include('xchain-e2e-test')
        })

        it('"all bitcoin regtest" includes regtest-miner but not e2e-test', async function () {
            const { filterCommandParameters } = require('../../src/services/ConfigService')
            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')

            const installed = []

            const moduleOps = proxyquire('../../src/operations/moduleOperations', {
                '../services/DockerService': {
                    createDockerNetwork: async () => true,
                    startContainer: async () => true,
                    stopContainer: async () => true,
                    restartContainer: async () => true,
                    killContainer: async () => true,
                    removeContainer: async () => true,
                    execContainer: async () => '',
                    shellContainer: async () => true,
                    logContainer: async () => true,
                    startDockerMonitor: async () => true
                },
                '../services/DatabaseService': {
                    buildDatabaseModule: async () => true
                },
                '../services/ModuleService': {
                    installModule: async (module) => {
                        installed.push(module)
                        return TestEnv.fakeContainerId('m')
                    },
                    cloneGit: async () => true
                }
            })

            await moduleOps.installModules(serviceList)

            expect(installed).to.include('xchain-regtest-miner')
            expect(installed).to.not.include('xchain-e2e-test')
        })
    })
})
