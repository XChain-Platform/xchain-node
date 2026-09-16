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

const E2EEnv       = require('../../e2e/helpers/e2e-env')

const { filterCommandParameters } = require('../../../src/services/config_service')

describe('Regression Suite', function () {
    afterEach(function () { sinon.restore() })

    describe('[regression:p1] E2E Lifecycle Workflows', function () {
        this.timeout(30000)
        let env, cli
        beforeEach(async function () {
            env = new E2EEnv()
            await env.setup()
            env.setupDefaultRoutes()
            const state = require('../../../src/state')
            state.setDbRootPassword('testrootpw')
        })
        afterEach(async function () {
            await env.teardown()
        })

        it('R-E2E-001: full install -> stop -> start -> uninstall cycle succeeds', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')

            // installModules reports what it built: a bare true would make
            // "installed the stack" and "installed nothing" identical.
            const installResult = await cli.moduleOps.installModules(serviceList, 'master')
            expect(installResult.installed.length).to.be.greaterThan(0)

            const modulesAfterInstall = await env.getAllModules()
            expect(modulesAfterInstall.length).to.be.greaterThanOrEqual(5)

            for (const mod of modulesAfterInstall) {
                expect(mod.container_id).to.have.lengthOf(64)
            }

            const stopResult = await cli.moduleOps.stopModules(serviceList)
            expect(stopResult).to.be.true

            const startResult = await cli.moduleOps.startModules(serviceList)
            expect(startResult).to.be.true

            // Container IDs preserved
            const modulesAfterRestart = await env.getAllModules()
            expect(modulesAfterRestart).to.have.lengthOf(modulesAfterInstall.length)
            for (const mod of modulesAfterInstall) {
                const after = modulesAfterRestart.find(
                    m => m.module === mod.module && m.coin === mod.coin && m.network === mod.network
                )
                expect(after, `${mod.module} preserved`).to.exist
                expect(after.container_id).to.equal(mod.container_id)
            }

            // Resolving at all is now the success signal: uninstallModules rejects
            // when any module failed, instead of returning true regardless.
            const uninstallResult = await cli.moduleOps.uninstallModules(serviceList)
            expect(uninstallResult.uninstalled.length).to.be.greaterThan(0)
        })
    })
})

describe('Regression Suite', function () {
    afterEach(function () { sinon.restore() })

    describe('[regression:p1] E2E Lifecycle Workflows', function () {
        this.timeout(30000)
        let env, cli
        beforeEach(async function () {
            env = new E2EEnv()
            await env.setup()
            env.setupDefaultRoutes()
            const state = require('../../../src/state')
            state.setDbRootPassword('testrootpw')
        })
        afterEach(async function () {
            await env.teardown()
        })

        it('R-E2E-002: install stores correct coin/network per module in LevelDB', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const modules = await env.getAllModules()
            const btcModules = modules.filter(m => m.coin === 'bitcoin' && m.network === 'regtest')
            expect(btcModules.length).to.be.greaterThanOrEqual(5)

            const moduleNames = btcModules.map(m => m.module)
            expect(moduleNames).to.include('xchain-encoder')
            expect(moduleNames).to.include('xchain-decoder')
            expect(moduleNames).to.include('xchain-utxo-tracker')
            expect(moduleNames).to.include('xchain-indexer')
            expect(moduleNames).to.include('xchain-regtest-miner')
        })

        it('R-E2E-003: selective install only installs targeted module', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const decoderEntry = await env.getModule('xchain-decoder', 'bitcoin', 'regtest')
            expect(decoderEntry).to.not.be.null
            expect(decoderEntry).to.have.lengthOf(64)

            // Encoder should NOT be installed
            const encoderEntry = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(encoderEntry).to.be.null
        })
    })
})

describe('Regression Suite', function () {
    afterEach(function () { sinon.restore() })

    describe('[regression:p1] E2E Lifecycle Workflows', function () {
        this.timeout(30000)
        let env, cli
        beforeEach(async function () {
            env = new E2EEnv()
            await env.setup()
            env.setupDefaultRoutes()
            const state = require('../../../src/state')
            state.setDbRootPassword('testrootpw')
        })
        afterEach(async function () {
            await env.teardown()
        })

        it('R-E2E-004: docker build commands use correct image names', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const buildCmds = env.capture.findCommands(/docker build/)
            const buildNames = buildCmds.map(c => c.command)

            expect(buildNames.some(cmd => cmd.includes('-t xchain-node-bitcoin-regtest-xchain-encoder'))).to.be.true
            expect(buildNames.some(cmd => cmd.includes('-t xchain-node-bitcoin-regtest-xchain-decoder'))).to.be.true
        })

        it('R-E2E-005: docker run commands include correct hostname and network', async function () {
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
})

describe('Regression Suite', function () {
    afterEach(function () { sinon.restore() })

    describe('[regression:p1] E2E Lifecycle Workflows', function () {
        this.timeout(30000)
        let env, cli
        beforeEach(async function () {
            env = new E2EEnv()
            await env.setup()
            env.setupDefaultRoutes()
            const state = require('../../../src/state')
            state.setDbRootPassword('testrootpw')
        })
        afterEach(async function () {
            await env.teardown()
        })

        // The install path reaches BootstrapService, DatabaseService,
        // BootstrapHealthGate and ConfigService through requires evaluated at
        // CALL time, which proxyquire cannot intercept. Unsealed, those ran
        // against the host: `docker inspect`/`docker exec` answered from a
        // venue's resident regtest stack (consensus-shaped refusals in a
        // "fully stubbed" tier), the host's own config/<coin>-<network> was
        // read instead of this env's, and a bootstrap lookup went out to the
        // network, whose unbounded latency is what pushed a different case in
        // this suite past the mocha ceiling on each run.
        it('R-E2E-006: install answers from this env, never from host docker, config or network', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            // A marker that exists ONLY in this env's temp config dir.
            env.writeConfigFile('bitcoin-regtest', 'XC1986_CONFIG_SOURCE=temp-config-dir\n')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            // Each of these is a call-time require the install really makes;
            // an unrecorded one means the real, host-reaching copy ran.
            const seams = env.hostSeamCallNames()
            expect(seams, 'utxo-tracker freshness').to.include('bootstrap_service.utxoTrackerVolumeFreshness')
            expect(seams, 'decoder/indexer freshness').to.include('bootstrap_service.mariaDbModuleFreshness')
            expect(seams, 'db container probe').to.include('database_service.getDatabaseContainerId')
            expect(seams, 'container health probe').to.include('bootstrap_health_gate.probeServiceStatus')
            expect(seams, 'config read').to.include('config_service.getDefaultConfig')

            // No bootstrap archive was fetched over the network.
            const downloads = env.hostSeamCalls.filter(c => c.name === 'downloadBootstrap')
            expect(downloads, 'no bootstrap download attempted').to.have.lengthOf(0)

            // And the module every call-time require resolves to answers from
            // this env's temp config dir, not from the checkout's config dir.
            const realConfigService = require('../../../src/services/config_service')
            const config = await realConfigService.getDefaultConfig('xchain-decoder', 'bitcoin', 'regtest')
            expect(config['XC1986_CONFIG_SOURCE']).to.equal('temp-config-dir')
        })
    })
})
