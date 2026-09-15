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
const proxyquire = require('proxyquire').noCallThru()

const { EXPLORER_MODULE_NAME } = require('../../src/config')
const { multiModuleSuite } = require('./multi_module_orchestration.test/support/fixture')

// installModules
multiModuleSuite('installModules orchestration', function (fixture) {

    it('creates Docker network and database before installing modules', async function () {
        const { TestEnv } = fixture()
        const callOrder = []

        const moduleOps = proxyquire('../../src/operations/module_operations', {
            '../services/docker_service': {
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
            '../services/database_service': {
                buildDatabaseModule: async (coin, network) => {
                    callOrder.push('database:' + coin + '-' + network)
                    return true
                }
            },
            '../services/module_service': {
                installModule: async (module, coin, network) => {
                    callOrder.push('install:' + module + ':' + coin + '-' + network)
                    return TestEnv.fakeContainerId('m')
                },
                cloneGit: async () => true
            }
        })

        // Only shared services (explorer)
        const serviceList = {
            'bitcoin': { 'mainnet': ['xchain-encoder', 'xchain-decoder'] }
        }

        await moduleOps.installModules(serviceList)

        // Order matters: network, then database, then modules.
        expect(callOrder[0]).to.equal('network:xchain-node-bitcoin-mainnet')
        // Database built second
        expect(callOrder[1]).to.equal('database:bitcoin-mainnet')
        // Then modules installed
        expect(callOrder[2]).to.equal('install:xchain-encoder:bitcoin-mainnet')
        expect(callOrder[3]).to.equal('install:xchain-decoder:bitcoin-mainnet')
    })
})

multiModuleSuite('installModules orchestration', function (fixture) {

    it('processes multiple coin/network stacks sequentially', async function () {
        const { TestEnv } = fixture()
        const installed = []

        const moduleOps = proxyquire('../../src/operations/module_operations', {
            '../services/docker_service': {
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
            '../services/database_service': {
                buildDatabaseModule: async () => true
            },
            '../services/module_service': {
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
})

multiModuleSuite('installModules orchestration', function (fixture) {

    it('skips database creation for shared services (empty coin/network)', async function () {
        const { TestEnv } = fixture()
        let databaseCalled = false

        const moduleOps = proxyquire('../../src/operations/module_operations', {
            '../services/docker_service': {
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
            '../services/database_service': {
                buildDatabaseModule: async () => { databaseCalled = true; return true }
            },
            '../services/module_service': {
                installModule: async () => TestEnv.fakeContainerId('m'),
                cloneGit: async () => true
            }
        })

        const serviceList = {
            '': { '': [EXPLORER_MODULE_NAME] }
        }

        await moduleOps.installModules(serviceList)

        // Database should NOT be called for empty coin/network
        expect(databaseCalled).to.be.false
    })
})
