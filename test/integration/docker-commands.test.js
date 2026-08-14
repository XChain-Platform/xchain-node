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

const {
    XChainService, EXPLORER_MODULE_NAME, HUB_MODULE_NAME, SYNC_MODULE_NAME,
    Coin, Network, CoinTickerSymbol
} = require('../../src/config/constants')

const TestEnv        = require('./helpers/test-env')
const CommandCapture = require('./helpers/command-capture')

describe('Integration: Docker Command Construction', function () {
    this.timeout(15000)

    let env, capture

    beforeEach(async function () {
        env = new TestEnv()
        await env.setup()
        capture = new CommandCapture()
    })

    afterEach(async function () {
        await env.teardown()
    })

    function makeBuildAndUp() {
        const containerId = TestEnv.fakeContainerId('c')

        capture.when(/docker build/).returns({ stdout: '' })
        capture.when(/docker run/).returns({ stdout: containerId + '\n' })
        // kill/rm echo the container ID back from the command so DockerService's
        // stdout === containerId check passes.
        const extractId = (cmd) => {
            const parts = cmd.trim().split(/\s+/)
            return { stdout: parts[parts.length - 1] }
        }
        capture.when(/docker kill/).respondsWith(extractId)
        capture.when(/docker rm/).respondsWith(extractId)

        const patchedConstants = Object.assign({}, require('../../src/config/constants'), {
            configDir: env.configDir,
            moduleDir: env.moduleDir,
            dataDir: env.dataDir
        })

        const PatchedConfigService = proxyquire('../../src/services/ConfigService', {
            '../config/constants': patchedConstants
        })

        const execFileStub = capture.createExecFileStub()
        const execFileAsyncStub = capture.createExecFileAsyncStub()

        const PatchedDockerService = proxyquire('../../src/services/DockerService', {
            'child_process': {
                execFile: execFileStub,
                spawn: capture.createSpawnStub(),
                spawnSync: capture.createSpawnSyncStub()
            },
            'util': { promisify: () => execFileAsyncStub },
            'blessed': {
                screen: () => ({ key: () => {}, on: () => {}, render: () => {}, destroy: () => {} }),
                text: () => {},
                log: () => ({ log: () => {} })
            }
        })

        const ModuleService = proxyquire('../../src/services/ModuleService', {
            'child_process': {
                execFile: execFileStub
            },
            'util': { promisify: () => execFileAsyncStub },
            '../config/constants': patchedConstants,
            './ConfigService': PatchedConfigService,
            './DockerService': PatchedDockerService,
            './StatusService': {
                statusChanged: async () => true,
                getStatus: async () => ({})
            },
            './DatabaseService': {
                setDatabaseParameters: async () => true
            }
        })

        return { ModuleService, containerId }
    }

    describe('xchain-encoder Docker run command', function () {

        it('includes correct hostname, network, port mapping, and env vars', async function () {
            env.writeConfigFile('bitcoin-mainnet', '')
            env.createFakeModule('xchain-encoder')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)

            const buildCmds = capture.findCommands(/docker build/)
            expect(buildCmds).to.have.length(1)
            expect(buildCmds[0].command).to.include('-t xchain-node-bitcoin-mainnet-xchain-encoder')

            const runCmds = capture.findCommands(/docker run/)
            expect(runCmds).to.have.length(1)
            const runCmd = runCmds[0].command

            expect(runCmd).to.include('-d')
            expect(runCmd).to.include('--hostname xchain-node-bitcoin-mainnet-xchain-encoder')
            expect(runCmd).to.include('--network xchain-node-bitcoin-mainnet')
            expect(runCmd).to.include('-t xchain-node-bitcoin-mainnet-xchain-encoder')
            expect(runCmd).to.include('-p 3003:3003')

            expect(runCmd).to.include('NETWORK=mainnet')
            expect(runCmd).to.include('NODE_PORT=8332')
            expect(runCmd).to.include('ENCODER_API_PORT=3003')
            expect(runCmd).to.include('NODE_URL=node')
        })

        it('uses testnet port when network is testnet', async function () {
            env.writeConfigFile('bitcoin-testnet', '')
            env.createFakeModule('xchain-encoder')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-encoder', 'bitcoin', 'testnet', null, true)

            const runCmd = capture.findCommands(/docker run/)[0].command
            expect(runCmd).to.include('NODE_PORT=18332')
            expect(runCmd).to.include('NETWORK=testnet')
        })

        it('propagates config file overrides into Docker env vars', async function () {
            env.writeConfigFile('bitcoin-mainnet', 'ENCODER_API_PORT=4003\nENCODER_PORT=4003\n')
            env.createFakeModule('xchain-encoder')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)

            const runCmd = capture.findCommands(/docker run/)[0].command
            expect(runCmd).to.include('ENCODER_API_PORT=4003')
            expect(runCmd).to.include('-p 4003:4003')
        })
    })

    describe('xchain-decoder Docker run command', function () {

        it('includes database env vars and bootstrap volume', async function () {
            env.writeConfigFile('bitcoin-mainnet', '')
            env.createFakeModule('xchain-decoder')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet', null, true)

            const runCmd = capture.findCommands(/docker run/)[0].command

            expect(runCmd).to.include('DECODER_DB_NAME=XChain_BTC_Mainnet_Decoder')
            expect(runCmd).to.include('DECODER_DB_HOST=mariadb')
            expect(runCmd).to.include('DECODER_DB_USER=xchain_decoder_bitcoin_mainnet')
            expect(runCmd).to.include('DECODER_DB_PASS=xchain-password')
            expect(runCmd).to.include('-p 3002:3002')

            expect(runCmd).to.include('-v ')
            expect(runCmd).to.include(':/bootstrap/xchain-decoder')
        })

        it('dogecoin/testnet gets correct DB names', async function () {
            env.writeConfigFile('dogecoin-testnet', '')
            env.createFakeModule('xchain-decoder')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-decoder', 'dogecoin', 'testnet', null, true)

            const runCmd = capture.findCommands(/docker run/)[0].command
            expect(runCmd).to.include('DECODER_DB_NAME=XChain_DOGE_Testnet_Decoder')
            expect(runCmd).to.include('DECODER_DB_USER=xchain_decoder_dogecoin_testnet')
            expect(runCmd).to.include('--network xchain-node-dogecoin-testnet')
        })
    })

    describe('xchain-utxo-tracker Docker run command', function () {

        it('includes data volume, bootstrap volume, and ulimit', async function () {
            env.writeConfigFile('bitcoin-mainnet', '')
            env.createFakeModule('xchain-utxo-tracker')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-utxo-tracker', 'bitcoin', 'mainnet', null, true)

            const runCmd = capture.findCommands(/docker run/)[0].command

            expect(runCmd).to.include('-v xchain-utxo-tracker-bitcoin-mainnet-data:/data/xchain-utxo-tracker')
            expect(runCmd).to.include(':/bootstrap/xchain-utxo-tracker')
            expect(runCmd).to.include('--ulimit nofile=2048:2048')
            expect(runCmd).to.include('-p 3001:3001')
            expect(runCmd).to.include('--network xchain-node-bitcoin-mainnet')
        })
    })

    describe('xchain-indexer Docker run command', function () {

        it('includes indexer DB env vars and correct port', async function () {
            env.writeConfigFile('bitcoin-mainnet', '')
            env.createFakeModule('xchain-indexer')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-indexer', 'bitcoin', 'mainnet', null, true)

            const runCmd = capture.findCommands(/docker run/)[0].command

            expect(runCmd).to.include('INDEXER_DB_NAME=XChain_BTC_Mainnet_Indexer')
            expect(runCmd).to.include('INDEXER_DB_USER=xchain_indexer_bitcoin_mainnet')
            expect(runCmd).to.include('INDEXER_DB_HOST=mariadb')
            expect(runCmd).to.include('INDEXER_COIN=BTC')
            expect(runCmd).to.include('INDEXER_NETWORK=mainnet')
            expect(runCmd).to.include('-p 3004:3004')
        })
    })

    describe('xchain-regtest-miner Docker run command', function () {

        it('includes regtest miner port on regtest network', async function () {
            env.writeConfigFile('bitcoin-regtest', '')
            env.createFakeModule('xchain-regtest-miner')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-regtest-miner', 'bitcoin', 'regtest', null, true)

            const runCmd = capture.findCommands(/docker run/)[0].command

            expect(runCmd).to.include('NODE_PORT=18444')
            expect(runCmd).to.include('NETWORK=regtest')
            expect(runCmd).to.include('-p 3005:3005')
            expect(runCmd).to.include('--network xchain-node-bitcoin-regtest')
        })
    })

    describe('xchain-hub Docker run command', function () {

        it('uses base network and hub port', async function () {
            env.createFakeModule('xchain-hub')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-hub', null, null, null, true)

            const buildCmd = capture.findCommands(/docker build/)[0].command
            expect(buildCmd).to.include('-t xchain-node-xchain-hub')

            const runCmd = capture.findCommands(/docker run/)[0].command
            expect(runCmd).to.include('--hostname xchain-node-xchain-hub')
            expect(runCmd).to.include('--network xchain-node')
            expect(runCmd).to.include('-p 10000:10000')
        })
    })

    describe('xchain-explorer Docker run command', function () {

        it('uses base network and both HTTP/HTTPS ports', async function () {
            env.createFakeModule('xchain-explorer')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-explorer', null, null, null, true)

            const runCmd = capture.findCommands(/docker run/)[0].command
            expect(runCmd).to.include('--hostname xchain-node-xchain-explorer')
            expect(runCmd).to.include('--network xchain-node')
            expect(runCmd).to.include('-p 18080:8080')
            expect(runCmd).to.include('-p 18081:8081')
        })
    })

    describe('buildAndUp with overwriteContainerId', function () {

        it('kills and removes old container before creating new one', async function () {
            env.writeConfigFile('bitcoin-mainnet', '')
            env.createFakeModule('xchain-encoder')

            const oldContainerId = TestEnv.fakeContainerId('o')
            const { ModuleService } = makeBuildAndUp()

            await ModuleService.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', oldContainerId, true)

            const killCmds = capture.findCommands(/docker kill/)
            expect(killCmds).to.have.length(1)
            expect(killCmds[0].command).to.include(oldContainerId)

            // Two `docker rm`s, not one: the explicit overwriteContainerId removal
            // above is id-keyed, plus buildAndUp also runs a name-keyed
            // forceRemoveContainerByName(containerPrefix) immediately before
            // `docker run --name`, to catch a leftover carcass the registry never
            // recorded (e.g. an interrupted prior run). Deliberate belt-and-suspenders
            // cleanup, not a duplicate call; see ModuleService.js's
            // "Name-keyed cleanup" comment (uuid:9533ee7a).
            const rmCmds = capture.findCommands(/docker rm/)
            expect(rmCmds).to.have.length(2)
            expect(rmCmds.some(c => c.command.includes(oldContainerId))).to.be.true
            expect(rmCmds.some(c => c.command.includes('xchain-node-bitcoin-mainnet-xchain-encoder'))).to.be.true

            const runCmds = capture.findCommands(/docker run/)
            expect(runCmds).to.have.length(1)
        })
    })

    describe('docker build working directory', function () {

        it('cwd is set to the module directory', async function () {
            env.writeConfigFile('bitcoin-mainnet', '')
            env.createFakeModule('xchain-encoder')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)

            const buildCmd = capture.findCommands(/docker build/)[0]
            expect(buildCmd.options.cwd).to.include('xchain-encoder')
        })
    })

    describe('every coin/network combo produces valid Docker run commands', function () {
        for (const coin of Object.values(Coin)) {
            for (const network of Object.values(Network)) {

                it(`xchain-encoder on ${coin}/${network}`, async function () {
                    env.writeConfigFile(`${coin}-${network}`, '')
                    env.createFakeModule('xchain-encoder')

                    const { ModuleService } = makeBuildAndUp()
                    await ModuleService.buildAndUp('xchain-encoder', coin, network, null, true)

                    const runCmd = capture.findCommands(/docker run/)[0].command

                    expect(runCmd).to.include(`--hostname xchain-node-${coin}-${network}-xchain-encoder`)
                    expect(runCmd).to.include(`--network xchain-node-${coin}-${network}`)
                    expect(runCmd).to.include(`NETWORK=${network}`)
                    expect(runCmd).to.include(`INDEXER_COIN=${CoinTickerSymbol[coin]}`)

                    if (network === 'regtest') {
                        expect(runCmd).to.include('REGTEST_MINER_API_PORT=3005')
                    }
                })
            }
        }
    })
})
