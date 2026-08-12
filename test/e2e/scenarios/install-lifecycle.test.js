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

const E2EEnv = require('../helpers/e2e-env')
const TestEnv = require('../../integration/helpers/test-env')

const { filterCommandParameters } = require('../../../src/services/ConfigService')

describe('E2E: Install Lifecycle (Scenarios 4.1, 4.3)', function () {
    this.timeout(30000)

    let env, cli

    beforeEach(async function () {
        env = new E2EEnv()
        await env.setup()
        env.setupDefaultRoutes()

        // Pre-set database root password to skip interactive prompt
        const state = require('../../../src/state')
        state.setDbRootPassword('testrootpw')
    })

    afterEach(async function () {
        await env.teardown()
    })

    describe('E2E-001: Full install all services for bitcoin/regtest', function () {

        it('creates Docker network, builds and runs all modules, stores IDs in LevelDB', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            env.capture.assertCalled(/docker network inspect/)

            const buildCmds = env.capture.findCommands(/docker build/)
            expect(buildCmds.length).to.be.greaterThanOrEqual(5) // encoder, decoder, utxo-tracker, indexer, regtest-miner

            const runCmds = env.capture.findCommands(/docker run/)
            expect(runCmds.length).to.be.greaterThanOrEqual(5)

            const modules = await env.getAllModules()
            const moduleNames = modules.map(m => m.module)
            expect(moduleNames).to.include('xchain-encoder')
            expect(moduleNames).to.include('xchain-decoder')
            expect(moduleNames).to.include('xchain-utxo-tracker')
            expect(moduleNames).to.include('xchain-indexer')
            expect(moduleNames).to.include('xchain-regtest-miner')

            for (const mod of modules) {
                if (mod.module === 'database') continue // database uses empty coin/network
                expect(mod.container_id).to.have.lengthOf(64)
            }
        })

        it('stores bitcoin/regtest as the coin/network for each module', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const modules = await env.getAllModules()
            const btcModules = modules.filter(m => m.coin === 'bitcoin' && m.network === 'regtest')
            expect(btcModules.length).to.be.greaterThanOrEqual(5)
        })

        it('database container is stored with empty coin/network (shared service)', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const dbModule = await env.getModule('database', '', '')
            expect(dbModule).to.not.be.null
            expect(dbModule).to.have.lengthOf(64)
        })

        it('docker build commands use correct container image names', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const buildCmds = env.capture.findCommands(/docker build/)
            const buildNames = buildCmds.map(c => c.command)

            const hasEncoder = buildNames.some(cmd => cmd.includes('-t xchain-node-bitcoin-regtest-xchain-encoder'))
            const hasDecoder = buildNames.some(cmd => cmd.includes('-t xchain-node-bitcoin-regtest-xchain-decoder'))
            expect(hasEncoder, 'encoder build command').to.be.true
            expect(hasDecoder, 'decoder build command').to.be.true
        })

        it('docker run commands include correct hostnames and networks', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmds = env.capture.findCommands(/docker run/)
            const encoderRun = runCmds.find(c => c.command.includes('xchain-encoder'))

            expect(encoderRun).to.exist
            expect(encoderRun.command).to.include('--hostname xchain-node-bitcoin-regtest-xchain-encoder')
            expect(encoderRun.command).to.include('--network xchain-node-bitcoin-regtest')
        })
    })

    describe('E2E-002: Stop all services', function () {

        it('calls docker stop for each container stored in LevelDB', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const modules = await env.getAllModules()
            const containerIds = modules.map(m => m.container_id)

            env.capture.reset()

            await cli.moduleOps.stopModules(serviceList)

            const stopCmds = env.capture.findCommands(/docker stop/)
            expect(stopCmds.length).to.be.greaterThanOrEqual(5)

            for (const cmd of stopCmds) {
                const stoppedId = cmd.command.split(/\s+/).pop()
                expect(containerIds, `stopped ID ${stoppedId} not in LevelDB`).to.include(stoppedId)
            }
        })

        it('LevelDB entries are preserved after stop (containers not removed)', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const modulesBefore = await env.getAllModules()

            await cli.moduleOps.stopModules(serviceList)

            const modulesAfter = await env.getAllModules()
            expect(modulesAfter).to.have.lengthOf(modulesBefore.length)
        })
    })

    describe('E2E-003: Start all services', function () {

        it('calls docker start for each container stored in LevelDB', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const modules = await env.getAllModules()
            const containerIds = modules.map(m => m.container_id)

            env.capture.reset()
            await cli.moduleOps.startModules(serviceList)

            const startCmds = env.capture.findCommands(/docker start/)
            expect(startCmds.length).to.be.greaterThanOrEqual(5)

            for (const cmd of startCmds) {
                const startedId = cmd.command.split(/\s+/).pop()
                expect(containerIds, `started ID ${startedId} not in LevelDB`).to.include(startedId)
            }
        })
    })

    describe('E2E-004: Uninstall all services', function () {

        it('removes coin-specific LevelDB entries after uninstall', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const modulesBefore = await env.getAllModules()
            expect(modulesBefore.length).to.be.greaterThanOrEqual(5)

            // uninstallModule calls getStatus, which re-queries LevelDB + docker inspect (both stubbed here)
            await cli.moduleOps.uninstallModules(serviceList)

            const encoderEntry = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(encoderEntry).to.be.null

            const decoderEntry = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')
            expect(decoderEntry).to.be.null

            const indexerEntry = await env.getModule('xchain-indexer', 'bitcoin', 'regtest')
            expect(indexerEntry).to.be.null
        })

        it('shared services (database, hub, explorer) are preserved unless --include-shared', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            await cli.moduleOps.uninstallModules(serviceList, false)

            const dbEntry = await env.getModule('database', '', '')
            expect(dbEntry).to.not.be.null
        })
    })

    describe('E2E-005: Selective install (decoder only)', function () {

        it('installs only decoder, database, hub, and explorer', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const decoderEntry = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')
            expect(decoderEntry).to.not.be.null
            expect(decoderEntry).to.have.lengthOf(64)

            const dbEntry = await env.getModule('database', '', '')
            expect(dbEntry).to.not.be.null

            const encoderEntry = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(encoderEntry).to.be.null

            const indexerEntry = await env.getModule('xchain-indexer', 'bitcoin', 'regtest')
            expect(indexerEntry).to.be.null

            const utxoEntry = await env.getModule('xchain-utxo-tracker', 'bitcoin', 'regtest')
            expect(utxoEntry).to.be.null
        })

        it('docker build called only for decoder, not other services', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const buildCmds = env.capture.findCommands(/docker build/)
            const buildNames = buildCmds.map(c => c.command)

            const hasDecoder = buildNames.some(cmd => cmd.includes('xchain-decoder'))
            expect(hasDecoder, 'decoder should be built').to.be.true

            const hasEncoder = buildNames.some(cmd => cmd.includes('xchain-encoder'))
            expect(hasEncoder, 'encoder should NOT be built').to.be.false
        })
    })

    describe('E2E-006: Full lifecycle sequence', function () {

        it('install → stop → start → uninstall all succeed in sequence', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')

            const installResult = await cli.moduleOps.installModules(serviceList, 'master')
            expect(installResult).to.be.true

            const modulesAfterInstall = await env.getAllModules()
            expect(modulesAfterInstall.length).to.be.greaterThanOrEqual(5)

            const stopResult = await cli.moduleOps.stopModules(serviceList)
            expect(stopResult).to.be.true

            const startResult = await cli.moduleOps.startModules(serviceList)
            expect(startResult).to.be.true

            const modulesAfterRestart = await env.getAllModules()
            expect(modulesAfterRestart).to.have.lengthOf(modulesAfterInstall.length)

            for (const mod of modulesAfterInstall) {
                const afterRestart = modulesAfterRestart.find(
                    m => m.module === mod.module && m.coin === mod.coin && m.network === mod.network
                )
                expect(afterRestart, `${mod.module} missing after restart`).to.exist
                expect(afterRestart.container_id).to.equal(mod.container_id)
            }

            const uninstallResult = await cli.moduleOps.uninstallModules(serviceList)
            expect(uninstallResult).to.be.true
        })
    })
})
