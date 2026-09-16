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

// updateModules
multiModuleSuite('updateModules orchestration', function (fixture) {

    it('reads old container ID from LevelDB and passes it to installModule', async function () {
        const { env, TestEnv } = fixture()
        const oldContainerId = TestEnv.fakeContainerId('o')
        await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', oldContainerId)

        const installCalls = []

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
                installModule: async (module, coin, network, remoteUpdate, overwriteId) => {
                    installCalls.push({ module, coin, network, overwriteId })
                    return TestEnv.fakeContainerId('n')
                },
                cloneGit: async () => true
            },
            '../services/database_service': {
                buildDatabaseModule: async () => true
            }
        })

        const serviceList = { 'bitcoin': { 'mainnet': ['xchain-encoder'] } }
        await moduleOps.updateModules(serviceList)

        expect(installCalls).to.have.length(1)
        expect(installCalls[0].module).to.equal('xchain-encoder')
        expect(installCalls[0].overwriteId).to.equal(oldContainerId)
    })
})

multiModuleSuite('updateModules orchestration', function (fixture) {

    it('clones git for non-node modules before installing', async function () {
        const { env, TestEnv } = fixture()
        const oldContainerId = TestEnv.fakeContainerId('o')
        await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', oldContainerId)

        // Since b1601d8 (2026-06-11), updateModulesOnBranch no longer calls
        // ModuleService.cloneGit itself for the moduleContainerId-exists path;
        // installModule does the clone internally (moduleOperations.js comment:
        // "installModule does the clone, so no separate cloneGit is needed
        // here"). Assert on the installModule call instead of a cloneGit spy
        // that this path never invokes.
        const installCalls = []

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
                installModule: async (module, coin, network, remoteUpdate, overwriteId) => {
                    installCalls.push({ module, coin, network, overwriteId })
                    return TestEnv.fakeContainerId('n')
                },
                cloneGit: async () => true
            },
            '../services/database_service': {
                buildDatabaseModule: async () => true
            }
        })

        const serviceList = { 'bitcoin': { 'mainnet': ['xchain-decoder'] } }
        await moduleOps.updateModules(serviceList)

        expect(installCalls.map(c => c.module)).to.include('xchain-decoder')
    })
})
