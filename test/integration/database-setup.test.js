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

    // executeDockerMariaDbCommand (98e37a9, predates the argv/env fix under
    // test) feeds provisioning SQL to `docker exec -i ... mariadb -u root`
    // over the child's STDIN, never as an argv `-e <sql>` token, precisely so
    // secret-bearing statements (CREATE USER ... IDENTIFIED BY) never land in
    // argv or a docker error message. It reaches the container through raw
    // `spawn(...)`, not `execFile`/`execFileAsync`, so CommandCapture's
    // shared execFile-based stub never sees the SQL at all, and its generic
    // spawn stub records argv but never delivers a response or fires 'close'.
    // This local stub replicates spawn's real event contract (stdout/stderr/
    // stdin, 'close') for that one call shape, folds the piped SQL into the
    // recorded command string, and routes it through the SAME
    // `capture.when()` patterns/history the execFile stub already uses, so
    // the regex-based assertions below (targeting the actual SQL text, e.g.
    // /CREATE USER/) keep working against the real post-fix argv+stdin split.
    function makeMariadbSpawnStub(cmdCapture) {
        const EventEmitter = require('events')
        return function spawnStub(command, args) {
            const child = new EventEmitter()
            child.stdout = new EventEmitter()
            child.stderr = new EventEmitter()
            child.stdin  = new EventEmitter()
            const argvCommand = command + ' ' + (args || []).join(' ')

            child.stdin.end = (data) => {
                const sql = String(data || '').replace(/;\n$/, '')
                const fullCommand = (argvCommand + ' ' + sql).trim()
                cmdCapture.history().push({
                    command: fullCommand, args, options: {}, type: 'spawn', timestamp: Date.now()
                })
                const response = cmdCapture._matchRoute(fullCommand)
                process.nextTick(() => {
                    if (response.error) {
                        child.stderr.emit('data', String(response.error.message || response.error))
                        child.emit('close', 1)
                    } else {
                        if (response.stdout) child.stdout.emit('data', response.stdout)
                        child.emit('close', 0)
                    }
                })
            }

            return child
        }
    }

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
        // getDatabaseContainerId() runs `docker inspect --type container
        // --format {{.Id}}`, which prints the bare 64-hex container id (not
        // JSON) on success. This route has to be registered ahead of the
        // generic `docker inspect` one below and match its exact shape, or
        // checkIfDatabaseModuleExists()/getDatabaseContainerId() always read
        // back a non-hex string and treat the database as never installed
        // regardless of options.dbContainerId. options.containerExists
        // toggles "database already installed" (used by the reuse/grant
        // tests) vs "fresh install" (the default, used by the first-install
        // test) semantics.
        capture.when(/docker inspect --type container --format/).returns(
            options.containerExists ? { stdout: dbContainerId + '\n' } : { stdout: '' }
        )
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
                execFile: execFileStub,
                spawn: makeMariadbSpawnStub(capture)
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
                sleep: async () => {},
                // DatabaseService logs several provisioning steps through
                // redactSecrets(); replacing the whole module without it
                // throws "redactSecrets is not a function" the first time a
                // test actually exercises those log lines (e.g. a successful
                // CREATE DATABASE/CREATE USER). An identity passthrough is
                // fine here: these tests assert on captured commands, not on
                // console output.
                redactSecrets: (s) => s
            }
        })

        return { DatabaseService, dbContainerId }
    }

    describe('buildDatabaseModule (first install)', function () {

        it('pulls mariadb, tags it, and runs container', async function () {
            const { DatabaseService, dbContainerId } = makeDatabaseService()
            env.writeConfigFile('bitcoin-mainnet', '')

            const result = await DatabaseService.buildDatabaseModule('bitcoin', 'mainnet')

            // Pin tracks src/services/DatabaseService.js's actual `docker pull`/
            // `docker tag` target; the image tag itself is not a secret.
            capture.assertCalled(/docker pull mariadb:10.11/)
            capture.assertCalled(/docker tag mariadb:10.11 xchain-node-database/)

            const runCmds = capture.findCommands(/docker run/)
            expect(runCmds).to.have.length(1)
            const runCmd = runCmds[0].command
            const runEnv = runCmds[0].options.env
            expect(runCmd).to.include('--hostname mariadb')
            // MYSQL_ROOT_PASSWORD is a live secret. It is passed by NAME on
            // the docker run command line; its VALUE travels only through
            // execFile's `env` option (3b0c5fa), so it must never appear in
            // argv (a failed `docker run` would otherwise leak it via
            // err.cmd/err.message into upstream logging).
            expect(runCmd).to.include('--env MYSQL_ROOT_PASSWORD')
            expect(runCmd).to.not.include('MYSQL_ROOT_PASSWORD=testrootpw')
            expect(runEnv.MYSQL_ROOT_PASSWORD).to.equal('testrootpw')
            expect(runCmd).to.include('xchain-node-database')

            // What the install branch owes its caller is the new container id;
            // every downstream provisioning step keys off that return value.
            expect(result).to.equal(dbContainerId)

            // It does NOT write a `modules` registry row for the database
            // module, and that absence is deliberate rather than a missing
            // insert (XC-1473). This branch is what CREATES the MariaDB
            // container, and the registry table lives INSIDE that very
            // container: at this point there is no xchain_node database, no
            // open pool, and no `modules` table to insert into, so registering
            // the DB module in its own registry is circular. Nothing in src/
            // reads such a row to find the DB either - every lookup goes
            // through DatabaseService.getDatabaseContainerId(), which resolves
            // the id with `docker inspect` on the container NAME, precisely
            // because it has to work before the registry exists. The row does
            // show up later, written by DiscoveryService.discoverContainers()
            // (DB_MODULE_NAME is in its SHARED_MODULES list), which runs once
            // there is a registry to write into and is what puts the database
            // line into `ps`.
            //
            // Asserting the absence rather than dropping the check keeps the
            // decision visible: a future change that starts writing here has to
            // be deliberate about the ordering problem above.
            const state = require('../../src/state')
            const storedId = await state.db.getModuleContainer(DB_MODULE_NAME, '', '')
            expect(storedId).to.equal(null)
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

            // getDatabaseContainerId() (checkIfDatabaseModuleExists's probe)
            // resolves the running database container via a real `docker
            // inspect --type container --format {{.Id}}` call, not the module
            // registry env.insertModule() just populated; without this route
            // it reads back empty stdout, checkIfDatabaseModuleExists()
            // returns null, and buildDatabaseModule wrongly takes the
            // fresh-install branch instead of the reuse branch under test.
            capture.when(/docker inspect --type container --format/).returns({ stdout: dbContainerId + '\n' })

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
                // See makeDatabaseService's identical comment above: DatabaseService
                // logs through redactSecrets(), so a bare `{ sleep }` mock throws
                // "redactSecrets is not a function" once code reaches a log line.
                '../utils/helpers': { sleep: async () => {}, redactSecrets: (s) => s }
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

            // containerExists: addUserPasswordToDatabase's preCheckContainerId
            // guard (DatabaseService.js ~L489) requires getDatabaseContainerId()
            // to resolve the already-installed database, unlike the fresh-install
            // test above.
            const { DatabaseService } = makeDatabaseService({ dbContainerId, containerExists: true })

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
            // Host is unconditionally '%' (4cc107e, predates the argv fix under
            // test), not a per-network gateway-derived subnet: a gateway-scoped
            // host previously blocked shared services on a different docker
            // network (e.g. the explorer) from reaching a per-coin DB.
            expect(createUserCmds[0].command).to.include("'%'")

            capture.assertCalled(/GRANT ALL PRIVILEGES ON XChain_BTC_Mainnet_Decoder/)
            capture.assertCalled(/FLUSH PRIVILEGES/)
        })

        // Renamed in spirit from its original "gateway-derived subnet" premise:
        // 4cc107e replaced the per-network subnet host with a universal '%' so
        // cross-network shared services could reach per-coin DBs, so a
        // different-than-usual gateway (172.20.x here vs. 172.18.x above) now
        // has to produce the SAME '%' host, not a different subnet. This is a
        // regression guard against reintroducing gateway-derived hosts, not a
        // test of gateway derivation (which no longer exists).
        it('uses "%" as the grant host regardless of the Docker network gateway', async function () {
            const dbContainerId = TestEnv.fakeContainerId('d')
            const decoderId = TestEnv.fakeContainerId('e')
            await env.insertModule(DB_MODULE_NAME, '', '', dbContainerId)
            await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', decoderId)
            env.writeConfigFile('bitcoin-mainnet', '')

            // Same preCheckContainerId requirement as the test above: resolve
            // the already-installed database container via `docker inspect
            // --type container --format {{.Id}}`.
            capture.when(/docker inspect --type container --format/).returns({ stdout: dbContainerId + '\n' })

            const DatabaseService = proxyquire('../../src/services/DatabaseService', {
                'child_process': {
                    execFile: capture.createExecFileStub(),
                    spawn: makeMariadbSpawnStub(capture)
                },
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
                // See makeDatabaseService's identical comment above: DatabaseService
                // logs through redactSecrets(), so a bare `{ sleep }` mock throws
                // "redactSecrets is not a function" once code reaches a log line.
                '../utils/helpers': { sleep: async () => {}, redactSecrets: (s) => s }
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
            expect(createUserCmds[0].command).to.include("'%'")
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

            // containerExists: setDatabaseParameters (DatabaseService.js
            // ~L664) resolves the database container up front via
            // getDatabaseContainerId() before provisioning any account.
            const { DatabaseService } = makeDatabaseService({
                dbContainerId,
                installedCoins: { bitcoin: ['mainnet'] },
                containerExists: true
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
                // See makeDatabaseService's identical comment above: DatabaseService
                // logs through redactSecrets(), so a bare `{ sleep }` mock throws
                // "redactSecrets is not a function" once code reaches a log line.
                '../utils/helpers': { sleep: async () => {}, redactSecrets: (s) => s }
            })

            const ready = await DatabaseService.checkIfDatabaseIsReady('root', 'testrootpw')
            expect(ready).to.be.true
            expect(callCount).to.equal(3)
        })
    })
})
