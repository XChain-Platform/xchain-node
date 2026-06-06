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

const { expect } = require('chai')

const E2EEnv = require('../helpers/e2e-env')
const { filterCommandParameters } = require('../../../src/services/ConfigService')

describe('E2E: Configuration Overrides (Scenario 4.4)', function () {
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

    // -------------------------------------------------------------------
    // E2E-020: Default config produces correct env vars
    // -------------------------------------------------------------------

    describe('E2E-020: Default config env vars', function () {

        it('encoder on regtest gets NODE_PORT=18444 and ENCODER_API_PORT=3003', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-encoder')).command
            expect(runCmd).to.include('NODE_PORT=18444')
            expect(runCmd).to.include('ENCODER_API_PORT=3003')
            expect(runCmd).to.include('NETWORK=regtest')
        })

        it('encoder on mainnet gets NODE_PORT=8332', async function () {
            env.setupFullStack('bitcoin', 'mainnet')
            env.writeConfigFile('bitcoin-mainnet', '')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'mainnet')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-encoder')).command
            expect(runCmd).to.include('NODE_PORT=8332')
            expect(runCmd).to.include('NETWORK=mainnet')
        })

        it('encoder on testnet gets NODE_PORT=18332', async function () {
            env.setupFullStack('bitcoin', 'testnet')
            env.writeConfigFile('bitcoin-testnet', '')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'testnet')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-encoder')).command
            expect(runCmd).to.include('NODE_PORT=18332')
        })
    })

    // -------------------------------------------------------------------
    // E2E-021: Config file overrides flow through to docker run
    // -------------------------------------------------------------------

    describe('E2E-021: Config file overrides', function () {

        it('ENCODER_PORT override flows to docker run port mapping', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            env.writeConfigFile('bitcoin-regtest', 'ENCODER_PORT=4003\nENCODER_API_PORT=4003\n')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-encoder')).command
            expect(runCmd).to.include('ENCODER_API_PORT=4003')
            expect(runCmd).to.include('-p 4003:4003')
        })

        it('DECODER_PORT override flows to docker run', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            env.writeConfigFile('bitcoin-regtest', 'DECODER_PORT=4002\nDECODER_API_PORT=4002\n')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-decoder')).command
            expect(runCmd).to.include('DECODER_API_PORT=4002')
            expect(runCmd).to.include('-p 4002:4002')
        })

        it('config file values take precedence over defaults', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            env.writeConfigFile('bitcoin-regtest', 'NODE_USER=customuser\nNODE_PASSWORD=custompass\n')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-encoder')).command
            expect(runCmd).to.include('NODE_USER=customuser')
            expect(runCmd).to.include('NODE_PASSWORD=custompass')
        })

        it('unspecified values fall back to defaults', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            env.writeConfigFile('bitcoin-regtest', 'NODE_USER=customuser\n')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-encoder')).command
            // NODE_USER overridden
            expect(runCmd).to.include('NODE_USER=customuser')
            // NODE_PASSWORD uses default
            expect(runCmd).to.include('NODE_PASSWORD=rpc')
        })
    })

    // -------------------------------------------------------------------
    // E2E-022: Regtest-specific config
    // -------------------------------------------------------------------

    describe('E2E-022: Regtest-specific config values', function () {

        it('regtest includes REGTEST_MINER_URL', async function () {
            env.setupFullStack('bitcoin', 'regtest')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-encoder')).command
            expect(runCmd).to.include('REGTEST_MINER_URL')
            expect(runCmd).to.include('REGTEST_MINER_API_PORT')
        })

        it('mainnet does NOT include REGTEST_MINER_URL', async function () {
            env.setupFullStack('bitcoin', 'mainnet')
            env.writeConfigFile('bitcoin-mainnet', '')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'mainnet')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-encoder')).command
            expect(runCmd).to.not.include('REGTEST_MINER_URL')
        })
    })

    // -------------------------------------------------------------------
    // E2E-023: Database naming convention
    // -------------------------------------------------------------------

    describe('E2E-023: Database naming follows convention', function () {

        it('decoder bitcoin/mainnet → XChain_BTC_Mainnet_Decoder', async function () {
            env.setupFullStack('bitcoin', 'mainnet')
            env.writeConfigFile('bitcoin-mainnet', '')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'mainnet')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-decoder')).command
            expect(runCmd).to.include('DECODER_DB_NAME=XChain_BTC_Mainnet_Decoder')
        })

        it('indexer dogecoin/testnet → XChain_DOGE_Testnet_Indexer', async function () {
            env.setupFullStack('dogecoin', 'testnet')
            env.writeConfigFile('dogecoin-testnet', '')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-indexer', 'dogecoin', 'testnet')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-indexer')).command
            expect(runCmd).to.include('INDEXER_DB_NAME=XChain_DOGE_Testnet_Indexer')
        })

        it('decoder litecoin/regtest → XChain_LTC_Regtest_Decoder', async function () {
            env.setupFullStack('litecoin', 'regtest')
            env.writeConfigFile('litecoin-regtest', '')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'litecoin', 'regtest')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-decoder')).command
            expect(runCmd).to.include('DECODER_DB_NAME=XChain_LTC_Regtest_Decoder')
        })

        it('DB user follows xchain_<module>_<coin>_<network> pattern', async function () {
            env.setupFullStack('bitcoin', 'mainnet')
            env.writeConfigFile('bitcoin-mainnet', '')
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-decoder', 'bitcoin', 'mainnet')
            await cli.moduleOps.installModules(serviceList, 'master')

            const runCmd = env.capture.findCommands(/docker run/).find(c => c.command.includes('xchain-decoder')).command
            expect(runCmd).to.include('DECODER_DB_USER=xchain_decoder_bitcoin_mainnet')
        })
    })
})
