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

const { EXPLORER_MODULE_NAME } = require('../../../src/config')
const { multiModuleSuite } = require('./support/fixture')

// Full filterCommandParameters -> installModules pipeline
multiModuleSuite('filterCommandParameters -> installModules end-to-end', function (fixture) {

    it('"all bitcoin mainnet" installs correct set in correct order', async function () {
        const { TestEnv } = fixture()
        const { filterCommandParameters } = require('../../../src/services/config_service')
        const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')

        const installed = []
        let networkCreated = false
        let databaseCreated = false

        const moduleOps = proxyquire('../../../src/operations/module_operations', {
            '../services/docker_service': {
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
            '../services/database_service': {
                buildDatabaseModule: async () => { databaseCreated = true; return true }
            },
            '../services/module_service': {
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
})

multiModuleSuite('filterCommandParameters -> installModules end-to-end', function (fixture) {

    it('"all bitcoin regtest" includes regtest-miner but not e2e-test', async function () {
        const { TestEnv } = fixture()
        const { filterCommandParameters } = require('../../../src/services/config_service')
        const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')

        const installed = []

        const moduleOps = proxyquire('../../../src/operations/module_operations', {
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
