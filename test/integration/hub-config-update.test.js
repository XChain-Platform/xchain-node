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
    XChainService, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, DB_MODULE_NAME, NODE_MODULE_NAME
} = require('../../src/config/constants')

const TestEnv     = require('./helpers/test-env')
const HttpCapture = require('./helpers/http-capture')

describe('Integration: Hub/Explorer Config Update', function () {
    this.timeout(15000)

    let env, httpCapture

    beforeEach(async function () {
        env = new TestEnv()
        await env.setup()
        env.patchConstants()
        httpCapture = new HttpCapture()
    })

    afterEach(async function () {
        await env.teardown()
    })

    function makeHubService(options = {}) {
        const axiosStub = httpCapture.createAxiosStub()

        const HubConnector = proxyquire('../../src/HubConnector', {
            'axios': axiosStub
        })

        const ExplorerConnector = proxyquire('../../src/ExplorerConnector', {
            'axios': axiosStub
        })

        const statusState = require('../../src/state')

        const HubService = proxyquire('../../src/services/HubService', {
            '../HubConnector.js': HubConnector,
            './DockerService': {
                addContainerToNetwork: async () => true,
                getStatusFromContainer: async (id) => ({
                    State: { Status: 'running' },
                    NetworkSettings: { Ports: {}, Networks: {} }
                }),
                stringToDockerContainerFile: async () => true
            },
            './ModuleService': {
                cloneGit: async () => true,
                buildAndUp: async () => TestEnv.fakeContainerId('h')
            },
            '../utils/helpers': {
                sleep: async () => {}
            }
        })

        return { HubService, HubConnector, ExplorerConnector }
    }

    describe('updateHubOrExplorer payload for hub', function () {

        it('builds JSON config with module connection details from installed modules', async function () {
            const state = require('../../src/state')

            const encId = TestEnv.fakeContainerId('e')
            const decId = TestEnv.fakeContainerId('d')
            const hubId = TestEnv.fakeContainerId('h')

            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', encId)
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', decId)
            await env.insertModule('xchain-hub', '', '', hubId)

            env.writeConfigFile('bitcoin-mainnet', '')
            state.setStatusUpdated(true)
            state.setLastStatus({
                'bitcoin': {
                    'mainnet': {
                        'xchain-encoder': { container_id: encId, status: { State: { Status: 'running' } } },
                        'xchain-decoder': { container_id: decId, status: { State: { Status: 'running' } } }
                    }
                }
            })

            httpCapture.when('127.0.0.1:10000').returns({ data: { result: true } })

            const { HubService } = makeHubService()
            await HubService.updateHubOrExplorer('xchain-hub')

            // Verify hub received a config payload
            const payloads = httpCapture.getPayloads('127.0.0.1:10000')
            expect(payloads.length).to.be.greaterThan(0)

            const lastPayload = payloads[payloads.length - 1]
            expect(lastPayload.method).to.equal('updateconfig')
            expect(lastPayload.params).to.have.property('config')

            const config = lastPayload.params.config
            expect(config).to.have.property('bitcoin')
            expect(config['bitcoin']).to.have.property('mainnet')

            const encoderConfig = config['bitcoin']['mainnet']['xchain-encoder']
            expect(encoderConfig).to.exist
            expect(encoderConfig.port).to.equal(3003)

            const decoderConfig = config['bitcoin']['mainnet']['xchain-decoder']
            expect(decoderConfig).to.exist
            expect(decoderConfig.port).to.equal(3002)
            expect(decoderConfig.db_host).to.equal('mariadb')
            expect(decoderConfig.name).to.equal('XChain_BTC_Mainnet_Decoder')
        })

        it('includes node config with correct ports and credentials', async function () {
            const state = require('../../src/state')

            const nodeId = TestEnv.fakeContainerId('n')
            const hubId = TestEnv.fakeContainerId('h')
            await env.insertModule('node', 'bitcoin', 'mainnet', nodeId)
            await env.insertModule('xchain-hub', '', '', hubId)

            // Since a2f1919 (2026-07-17), ConfigService generates a random
            // NODE_USER/NODE_PASSWORD per install whenever the config file
            // doesn't already carry them, rather than falling through to the
            // static "rpc"/"rpc" default (a well-known credential left on a
            // live stack). Seed both here so this test still asserts a known,
            // fixed value instead of a per-run random one.
            env.writeConfigFile('bitcoin-mainnet', 'NODE_USER=rpc\nNODE_PASSWORD=rpc\n')
            state.setStatusUpdated(true)
            state.setLastStatus({
                'bitcoin': {
                    'mainnet': {
                        'node': { container_id: nodeId, status: { State: { Status: 'running' } } }
                    }
                }
            })

            httpCapture.when('127.0.0.1:10000').returns({ data: { result: true } })

            const { HubService } = makeHubService()
            await HubService.updateHubOrExplorer('xchain-hub')

            const payloads = httpCapture.getPayloads('127.0.0.1:10000')
            const config = payloads[payloads.length - 1].params.config

            const nodeConfig = config['bitcoin']['mainnet']['node']
            expect(nodeConfig).to.exist
            expect(nodeConfig.host).to.equal('node')
            expect(nodeConfig.port).to.equal(8332)
            expect(nodeConfig.user).to.equal('rpc')
            expect(nodeConfig.pass).to.equal('rpc')
        })

        it('includes multiple coin/network stacks', async function () {
            const state = require('../../src/state')

            const id1 = TestEnv.fakeContainerId('1')
            const id2 = TestEnv.fakeContainerId('2')
            const hubId = TestEnv.fakeContainerId('h')

            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', id1)
            await env.insertModule('xchain-encoder', 'dogecoin', 'testnet', id2)
            await env.insertModule('xchain-hub', '', '', hubId)

            env.writeConfigFile('bitcoin-mainnet', '')
            env.writeConfigFile('dogecoin-testnet', '')
            state.setStatusUpdated(true)
            state.setLastStatus({
                'bitcoin': {
                    'mainnet': {
                        'xchain-encoder': { container_id: id1, status: { State: { Status: 'running' } } }
                    }
                },
                'dogecoin': {
                    'testnet': {
                        'xchain-encoder': { container_id: id2, status: { State: { Status: 'running' } } }
                    }
                }
            })

            httpCapture.when('127.0.0.1:10000').returns({ data: { result: true } })

            const { HubService } = makeHubService()
            await HubService.updateHubOrExplorer('xchain-hub')

            const payloads = httpCapture.getPayloads('127.0.0.1:10000')
            const config = payloads[payloads.length - 1].params.config

            expect(config).to.have.property('bitcoin')
            expect(config).to.have.property('dogecoin')
            expect(config['bitcoin']['mainnet']['xchain-encoder'].port).to.equal(3003)
            expect(config['dogecoin']['testnet']['xchain-encoder'].port).to.equal(3003)
        })
    })

    describe('hub update retry logic', function () {

        it('retries on failure and succeeds when hub responds', async function () {
            const state = require('../../src/state')

            const hubId = TestEnv.fakeContainerId('h')
            const encId = TestEnv.fakeContainerId('e')
            await env.insertModule('xchain-hub', '', '', hubId)
            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', encId)

            env.writeConfigFile('bitcoin-mainnet', '')
            state.setStatusUpdated(true)
            state.setLastStatus({
                'bitcoin': {
                    'mainnet': {
                        'xchain-encoder': { container_id: encId, status: { State: { Status: 'running' } } }
                    }
                }
            })

            httpCapture.when('127.0.0.1:10000').failsThenSucceeds(
                2,
                new Error('Connection refused'),
                { data: { result: true } }
            )

            const { HubService } = makeHubService()
            await HubService.updateHubOrExplorer('xchain-hub')

            expect(httpCapture.callCount('127.0.0.1:10000')).to.equal(3)
        })

        it('throws after exhausting all retries', async function () {
            const state = require('../../src/state')

            const hubId = TestEnv.fakeContainerId('h')
            await env.insertModule('xchain-hub', '', '', hubId)

            state.setStatusUpdated(true)
            state.setLastStatus({})

            httpCapture.when('127.0.0.1:10000').rejects(new Error('Connection refused'))

            const { HubService } = makeHubService()

            try {
                await HubService.updateHubOrExplorer('xchain-hub')
                expect.fail('Should have thrown')
            } catch (err) {
                expect(err).to.include('problem trying to update')
            }

            expect(httpCapture.callCount('127.0.0.1:10000')).to.equal(10)
        })
    })

    describe('updateHubOrExplorer for explorer', function () {

        it('writes config.json to explorer container via docker exec', async function () {
            const state = require('../../src/state')

            const explorerId = TestEnv.fakeContainerId('x')
            const encId = TestEnv.fakeContainerId('e')
            await env.insertModule('xchain-explorer', '', '', explorerId)
            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', encId)

            env.writeConfigFile('bitcoin-mainnet', '')
            state.setStatusUpdated(true)
            state.setLastStatus({
                'bitcoin': {
                    'mainnet': {
                        'xchain-encoder': { container_id: encId, status: { State: { Status: 'running' } } }
                    }
                }
            })

            let writtenData = null
            let writtenPath = null

            const HubService = proxyquire('../../src/services/HubService', {
                '../HubConnector.js': function () { return { ping: async () => true, updateConfig: async () => true } },
                './DockerService': {
                    addContainerToNetwork: async () => true,
                    getStatusFromContainer: async () => ({ State: { Status: 'running' }, NetworkSettings: { Ports: {}, Networks: {} } }),
                    stringToDockerContainerFile: async (containerId, data, filePath) => {
                        writtenData = data
                        writtenPath = filePath
                        return true
                    }
                },
                './ModuleService': {
                    cloneGit: async () => true,
                    buildAndUp: async () => explorerId
                },
                '../utils/helpers': {
                    sleep: async () => {}
                }
            })

            await HubService.updateHubOrExplorer('xchain-explorer')

            expect(writtenPath).to.equal('/XChainExplorer/src/config.json')
            expect(writtenData).to.be.a('string')

            const parsed = JSON.parse(writtenData)
            expect(parsed).to.be.an('array')
            expect(parsed.length).to.be.greaterThan(0)
            expect(parsed[0].coin).to.equal('bitcoin')
            expect(parsed[0].network).to.equal('mainnet')
            expect(parsed[0]['xchain-encoder']).to.exist
        })
    })

    describe('updateHub network connectivity', function () {

        it('connects hub container to all installed coin/network Docker networks', async function () {
            const state = require('../../src/state')

            const hubId = TestEnv.fakeContainerId('h')
            const encId = TestEnv.fakeContainerId('e')
            const decId = TestEnv.fakeContainerId('d')

            await env.insertModule('xchain-hub', '', '', hubId)
            await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', encId)
            await env.insertModule('xchain-decoder', 'dogecoin', 'testnet', decId)

            env.writeConfigFile('bitcoin-mainnet', '')
            env.writeConfigFile('dogecoin-testnet', '')

            state.setStatusUpdated(true)
            state.setLastStatus({
                'bitcoin': { 'mainnet': { 'xchain-encoder': { container_id: encId, status: { State: { Status: 'running' } } } } },
                'dogecoin': { 'testnet': { 'xchain-decoder': { container_id: decId, status: { State: { Status: 'running' } } } } },
                '': { '': { 'xchain-hub': { container_id: hubId, status: { State: { Status: 'running' } } } } }
            })

            const networkConnections = []
            httpCapture.when('127.0.0.1:10000').returns({ data: { result: true } })

            const HubService = proxyquire('../../src/services/HubService', {
                '../HubConnector.js': proxyquire('../../src/HubConnector', {
                    'axios': httpCapture.createAxiosStub()
                }),
                './DockerService': {
                    addContainerToNetwork: async (containerId, network) => {
                        networkConnections.push({ containerId, network })
                        return true
                    },
                    getStatusFromContainer: async () => ({
                        State: { Status: 'running' },
                        NetworkSettings: { Ports: {}, Networks: {} }
                    }),
                    stringToDockerContainerFile: async () => true
                },
                './ModuleService': {
                    cloneGit: async () => true,
                    buildAndUp: async () => hubId
                },
                '../utils/helpers': {
                    sleep: async () => {}
                }
            })

            await HubService.updateHub()

            const hubConnections = networkConnections.filter(c => c.containerId === hubId)
            const networks = hubConnections.map(c => c.network)
            expect(networks).to.include('xchain-node-bitcoin-mainnet')
            expect(networks).to.include('xchain-node-dogecoin-testnet')
        })
    })

    // The explorer hard-requires a checkpoint block per serving coin, and the push is
    // what generates it. While the opt-in was read only from the host env at command
    // time, a coin installed from a shell that never exported it got no block, both
    // config stores being upsert-only kept the earlier coins' blocks, and the explorer
    // served that one coin's hub-mirrored routes as a 500 while its siblings answered.
    describe('checkpoint self-sync opt-in survives the shell that set it', function () {

        let savedOptIn

        beforeEach(function () {
            savedOptIn = process.env.EXPLORER_CHECKPOINT_SELF_SYNC
            delete process.env.EXPLORER_CHECKPOINT_SELF_SYNC
        })

        afterEach(function () {
            if (savedOptIn === undefined) delete process.env.EXPLORER_CHECKPOINT_SELF_SYNC
            else process.env.EXPLORER_CHECKPOINT_SELF_SYNC = savedOptIn
        })

        async function pushWithContainerEnv(containerEnv) {
            const state = require('../../src/state')

            const hubId = TestEnv.fakeContainerId('h')
            const btcId = TestEnv.fakeContainerId('b')
            const ltcId = TestEnv.fakeContainerId('l')

            await env.insertModule('xchain-hub', '', '', hubId)
            await env.insertModule('xchain-indexer', 'bitcoin',  'regtest', btcId)
            await env.insertModule('xchain-indexer', 'litecoin', 'regtest', ltcId)

            env.writeConfigFile('bitcoin-regtest', '')
            env.writeConfigFile('litecoin-regtest', '')

            state.setStatusUpdated(true)
            state.setLastStatus({
                'bitcoin':  { 'regtest': { 'xchain-indexer': { container_id: btcId, status: { State: { Status: 'running' } } } } },
                'litecoin': { 'regtest': { 'xchain-indexer': { container_id: ltcId, status: { State: { Status: 'running' } } } } }
            })

            httpCapture.when('127.0.0.1:10000').returns({ data: { result: true } })

            const HubService = proxyquire('../../src/services/HubService', {
                '../HubConnector.js': proxyquire('../../src/HubConnector', {
                    'axios': httpCapture.createAxiosStub()
                }),
                './DbCredentialDrift': {
                    readContainerEnv: async () => containerEnv
                },
                './DockerService': {
                    addContainerToNetwork: async () => true,
                    getStatusFromContainer: async () => ({
                        State: { Status: 'running' },
                        NetworkSettings: { Ports: {}, Networks: {} }
                    }),
                    stringToDockerContainerFile: async () => true
                },
                './ModuleService': {
                    cloneGit: async () => true,
                    buildAndUp: async () => hubId
                },
                '../utils/helpers': {
                    sleep: async () => {}
                }
            })

            await HubService.updateHubOrExplorer('xchain-hub')

            const payloads = httpCapture.getPayloads('127.0.0.1:10000')
            return payloads[payloads.length - 1].params.config
        }

        it('emits a checkpoint block for EVERY installed coin when only the explorer container remembers the opt-in', async function () {
            const config = await pushWithContainerEnv({ HUB_API_URL: 'http://xchain-node-xchain-hub:10000' })

            for (const coin of ['bitcoin', 'litecoin']) {
                const checkpoint = config[coin]['regtest'].checkpoint
                expect(checkpoint, coin + ' checkpoint block').to.exist
                expect(checkpoint.self_sync, coin + ' self_sync').to.be.true
                expect(checkpoint.hub_url, coin + ' hub_url').to.be.a('string').and.to.have.length.above(0)
                expect(checkpoint.name, coin + ' mirror schema').to.match(/_HubMirror$/)
            }
        })

        it('emits none when neither the env nor the explorer container was ever opted in', async function () {
            const config = await pushWithContainerEnv({ EXPLORER_PORT: '18080' })

            expect(config['bitcoin']['regtest'].checkpoint).to.be.undefined
            expect(config['litecoin']['regtest'].checkpoint).to.be.undefined
        })
    })
})
