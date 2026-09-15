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

const { multiModuleSuite } = require('./support/fixture')

function makeFailingUninstallOperations(uninstalled, recordFailure) {
    return proxyquire('../../../src/operations/module_operations', {
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
        '../services/module_service': {
            uninstallModule: async (coin, network, module) => {
                if (module === 'xchain-decoder') {
                    recordFailure()
                    throw new Error('Simulated failure')
                }
                uninstalled.push(module)
                return true
            },
            cloneGit: async () => true,
            installModule: async () => true
        },
        '../services/database_service': {
            buildDatabaseModule: async () => true
        }
    })
}

// uninstallModules
multiModuleSuite('uninstallModules orchestration', function (fixture) {

    it('calls uninstallModule for each service in the list', async function () {
        const { env, TestEnv } = fixture()
        // Modules must exist in LevelDB for uninstall to proceed
        await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', TestEnv.fakeContainerId('1'))
        await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', TestEnv.fakeContainerId('2'))
        await env.insertModule('xchain-indexer', 'dogecoin', 'testnet', TestEnv.fakeContainerId('3'))

        const uninstalled = []

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
            '../services/module_service': {
                uninstallModule: async (coin, network, module) => {
                    uninstalled.push({ coin, network, module })
                    return true
                },
                cloneGit: async () => true,
                installModule: async () => true
            },
            '../services/database_service': {
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
})

multiModuleSuite('uninstallModules orchestration', function (fixture) {

    it('continues uninstalling remaining modules when one fails', async function () {
        const { env, TestEnv } = fixture()
        // Modules must exist in the registry for uninstall to proceed
        await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', TestEnv.fakeContainerId('1'))
        await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', TestEnv.fakeContainerId('2'))
        await env.insertModule('xchain-indexer', 'bitcoin', 'mainnet', TestEnv.fakeContainerId('3'))

        const uninstalled = []
        let failCount = 0
        const moduleOps = makeFailingUninstallOperations(uninstalled, () => { failCount++ })

        const serviceList = {
            'bitcoin': { 'mainnet': ['xchain-encoder', 'xchain-decoder', 'xchain-indexer'] }
        }

        // Batch completion and success are separate properties: the loop still
        // visits every module, but a Docker failure now propagates instead of returning true.
        let thrown = null
        try {
            await moduleOps.uninstallModules(serviceList)
        } catch (err) {
            thrown = err
        }

        expect(thrown, 'a failed uninstall must reject, not report success').to.not.equal(null)
        expect(thrown.message).to.match(/uninstall failed for 1 module/)
        // Should still continue past the failure
        expect(uninstalled).to.deep.equal(['xchain-encoder', 'xchain-indexer'])
        expect(failCount).to.equal(1)
    })
})
