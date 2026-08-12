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
    DB_MODULE_NAME, XChainService
} = require('../../src/config/constants')

const TestEnv        = require('./helpers/test-env')
const CommandCapture = require('./helpers/command-capture')

describe('Integration: Database Service Chain', function () {
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

    function makeDatabaseService(options = {}) {
        const state = require('../../src/state')
        state.setDbRootPassword('testrootpw')

        const dbContainerId = options.dbContainerId || TestEnv.fakeContainerId('d')

        capture.when(/docker pull/).returns({ stdout: '' })
        capture.when(/docker tag/).returns({ stdout: '' })
        capture.when(/docker run/).returns({ stdout: dbContainerId + '\n' })
        capture.when(/docker exec.*SELECT 1/).returns({ stdout: '1' })
        capture.when(/docker exec.*SELECT COUNT\(SCHEMA/).returns({ stdout: '0' })
        capture.when(/docker exec.*SELECT COUNT\(\*\).*mysql.user/).returns({ stdout: '0' })
        capture.when(/docker exec.*CREATE DATABASE/).returns({ stdout: '' })
        capture.when(/docker exec.*CREATE USER/).returns({ stdout: '' })
        capture.when(/docker exec.*SHOW GRANTS/).returns({ stdout: '' })
        capture.when(/docker exec.*GRANT ALL/).returns({ stdout: '' })
        capture.when(/docker exec.*FLUSH/).returns({ stdout: '' })
        capture.when(/docker network inspect/).returns({
            stdout: JSON.stringify([{
                IPAM: { Config: [{ Gateway: '172.18.0.1' }] }
            }])
        })
        capture.when(/docker inspect/).returns({
            stdout: JSON.stringify([{
                State: { Status: 'running' },
                NetworkSettings: { Ports: {}, Networks: {} }
            }])
        })

        const execFileStub = capture.createExecFileStub()
        const execFileAsyncStub = capture.createExecFileAsyncStub()

        const DatabaseService = proxyquire('../../src/services/DatabaseService', {
            'child_process': {
                execFile: execFileStub
            },
            'util': {
                promisify: () => execFileAsyncStub
            },
            'enquirer': {
                Password: class { async run() { return 'testrootpw' } }
            },
            './StatusService': {
                statusChanged: async () => true,
                getStatus: async () => ({}),
                getInstalledCoinsAndNetworks: async () => options.installedCoins || {}
            },
            './DockerService': {
                getStatusFromContainer: async (id) => ({
                    State: { Status: 'running' },
                    NetworkSettings: { Ports: {}, Networks: {} }
                }),
                getDockerNetworkInspect: async () => ({
                    IPAM: { Config: [{ Gateway: '172.18.0.1' }] }
                }),
                addContainerToNetwork: async () => true
            },
            '../utils/helpers': {
                sleep: async () => {}
            }
        })

        return { DatabaseService, dbContainerId }
    }

    describe('buildDatabaseModule (first install)', function () {

        it('pulls mariadb, tags it, and runs container', async function () {
            const { DatabaseService, dbContainerId } = makeDatabaseService()
            env.writeConfigFile('bitcoin-mainnet', '')

            const result = await DatabaseService.buildDatabaseModule('bitcoin', 'mainnet')

            capture.assertCalled(/docker pull mariadb:latest/)
            capture.assertCalled(/docker tag mariadb:latest xchain-node-database/)

            const runCmds = capture.findCommands(/docker run/)
            expect(runCmds).to.have.length(1)
            const runCmd = runCmds[0].command
            expect(runCmd).to.include('--hostname mariadb')
            expect(runCmd).to.include('MYSQL_ROOT_PASSWORD=testrootpw')
            expect(runCmd).to.include('xchain-node-database')

            const state = require('../../src/state')
            const storedId = await state.db.getModuleContainer(DB_MODULE_NAME, '', '')
            expect(storedId).to.equal(dbContainerId)
        })

        it('includes network flag when coin/network are provided', async function () {
            const { DatabaseService } = makeDatabaseService()
            env.writeConfigFile('bitcoin-mainnet', '')

            await DatabaseService.buildDatabaseModule('bitcoin', 'mainnet')

            const runCmd = capture.findCommands(/docker run/)[0].command
            expect(runCmd).to.include('--network xchain-node-bitcoin-mainnet')
        })
    })

    describe('buildDatabaseModule (already exists)', function () {

        it('reuses existing container and adds to network', async function () {
            const dbContainerId = TestEnv.fakeContainerId('d')
            await env.insertModule(DB_MODULE_NAME, '', '', dbContainerId)

            const networkConnections = []
            const DatabaseService = proxyquire('../../src/services/DatabaseService', {
                'child_process': { execFile: capture.createExecFileStub() },
                'util': { promisify: () => capture.createExecFileAsyncStub() },
                'enquirer': { Password: class { async run() { return 'testrootpw' } } },
                './StatusService': {
                    statusChanged: async () => true,
                    getStatus: async () => ({}),
                    getInstalledCoinsAndNetworks: async () => ({})
                },
                './DockerService': {
                    getStatusFromContainer: async () => ({
                        State: { Status: 'running' },
                        NetworkSettings: { Ports: {}, Networks: {} }
                    }),
                    getDockerNetworkInspect: async () => ({
                        IPAM: { Config: [{ Gateway: '172.18.0.1' }] }
                    }),
                    addContainerToNetwork: async (id, network) => {
                        networkConnections.push({ id, network })
                        return true
                    }
                },
                '../utils/helpers': { sleep: async () => {} }
            })

            const state = require('../../src/state')
            state.setDbRootPassword('testrootpw')

            await DatabaseService.buildDatabaseModule('litecoin', 'mainnet')

            capture.assertNotCalled(/docker pull/)
            capture.assertNotCalled(/docker run/)

            expect(networkConnections).to.have.length(1)
            expect(networkConnections[0].id).to.equal(dbContainerId)
            expect(networkConnections[0].network).to.equal('xchain-node-litecoin-mainnet')
        })
    })

    describe('addUserPasswordToDatabase', function () {

        it('creates database, user, and grants for decoder', async function () {
            const dbContainerId = TestEnv.fakeContainerId('d')
            const decoderId = TestEnv.fakeContainerId('e')
            await env.insertModule(DB_MODULE_NAME, '', '', dbContainerId)
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', decoderId)

            env.writeConfigFile('bitcoin-mainnet', '')

            const { DatabaseService } = makeDatabaseService({ dbContainerId })

            await DatabaseService.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder',
                'xchain_decoder_bitcoin_mainnet',
                'xchain-password'
            )

            capture.assertCalled(/CREATE DATABASE IF NOT EXISTS XChain_BTC_Mainnet_Decoder/)

            const createUserCmds = capture.findCommands(/CREATE USER/)
            expect(createUserCmds).to.have.length(1)
            expect(createUserCmds[0].command).to.include('xchain_decoder_bitcoin_mainnet')
            expect(createUserCmds[0].command).to.include('172.18.0.0/255.255.0.0')

            capture.assertCalled(/GRANT ALL PRIVILEGES ON XChain_BTC_Mainnet_Decoder/)
            capture.assertCalled(/FLUSH PRIVILEGES/)
        })

        it('uses correct gateway-derived subnet from Docker network', async function () {
            const dbContainerId = TestEnv.fakeContainerId('d')
            const decoderId = TestEnv.fakeContainerId('e')
            await env.insertModule(DB_MODULE_NAME, '', '', dbContainerId)
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', decoderId)
            env.writeConfigFile('bitcoin-mainnet', '')

            const DatabaseService = proxyquire('../../src/services/DatabaseService', {
                'child_process': { execFile: capture.createExecFileStub() },
                'util': { promisify: () => capture.createExecFileAsyncStub() },
                'enquirer': { Password: class { async run() { return 'testrootpw' } } },
                './StatusService': {
                    statusChanged: async () => true,
                    getStatus: async () => ({}),
                    getInstalledCoinsAndNetworks: async () => ({})
                },
                './DockerService': {
                    getStatusFromContainer: async () => ({ State: { Status: 'running' }, NetworkSettings: { Ports: {}, Networks: {} } }),
                    getDockerNetworkInspect: async () => ({
                        IPAM: { Config: [{ Gateway: '172.20.0.1' }] }
                    }),
                    addContainerToNetwork: async () => true
                },
                '../utils/helpers': { sleep: async () => {} }
            })

            const state = require('../../src/state')
            state.setDbRootPassword('testrootpw')

            await DatabaseService.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder',
                'xchain_decoder_bitcoin_mainnet',
                'xchain-password'
            )

            const createUserCmds = capture.findCommands(/CREATE USER/)
            expect(createUserCmds[0].command).to.include('172.20.0.0/255.255.0.0')
        })
    })

    describe('setDatabaseParameters', function () {

        it('creates users for all installed decoders and indexers', async function () {
            const dbContainerId = TestEnv.fakeContainerId('d')
            const decoderId = TestEnv.fakeContainerId('e')
            const indexerId = TestEnv.fakeContainerId('i')

            await env.insertModule(DB_MODULE_NAME, '', '', dbContainerId)
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', decoderId)
            await env.insertModule('xchain-indexer', 'bitcoin', 'mainnet', indexerId)

            env.writeConfigFile('bitcoin-mainnet', '')

            const { DatabaseService } = makeDatabaseService({
                dbContainerId,
                installedCoins: { bitcoin: ['mainnet'] }
            })

            await DatabaseService.setDatabaseParameters()

            const createUserCmds = capture.findCommands(/CREATE USER/)
            const userNames = createUserCmds.map(c => c.command)

            const hasDecoderUser = userNames.some(cmd => cmd.includes('xchain_decoder_bitcoin_mainnet'))
            expect(hasDecoderUser).to.be.true

            const hasIndexerUser = userNames.some(cmd => cmd.includes('xchain_indexer_bitcoin_mainnet'))
            expect(hasIndexerUser).to.be.true
        })
    })

    describe('checkIfDatabaseIsReady', function () {

        it('retries until database responds', async function () {
            const dbContainerId = TestEnv.fakeContainerId('d')
            await env.insertModule(DB_MODULE_NAME, '', '', dbContainerId)

            let callCount = 0
            const execFileAsyncStub = async (command, args) => {
                callCount++
                if (callCount < 3) throw new Error('Connection refused')
                return { stdout: '1', stderr: '' }
            }

            const DatabaseService = proxyquire('../../src/services/DatabaseService', {
                'child_process': { execFile: capture.createExecFileStub() },
                'util': { promisify: () => execFileAsyncStub },
                'enquirer': { Password: class { async run() { return 'testrootpw' } } },
                './StatusService': {
                    statusChanged: async () => true,
                    getStatus: async () => ({}),
                    getInstalledCoinsAndNetworks: async () => ({})
                },
                './DockerService': {
                    getStatusFromContainer: async () => ({ State: { Status: 'running' }, NetworkSettings: { Ports: {}, Networks: {} } }),
                    getDockerNetworkInspect: async () => ({ IPAM: { Config: [{ Gateway: '172.18.0.1' }] } }),
                    addContainerToNetwork: async () => true
                },
                '../utils/helpers': { sleep: async () => {} }
            })

            const ready = await DatabaseService.checkIfDatabaseIsReady('root', 'testrootpw')
            expect(ready).to.be.true
            expect(callCount).to.equal(3)
        })
    })
})
