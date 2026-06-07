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

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CONTAINER_ID = 'a'.repeat(64)

function makeStubs() {
    // execFileAsync is what the source uses (via promisify(execFile)) for all
    // docker inspect / docker port / docker pull / docker run calls.
    // Default: return a valid 64-char hex container ID (simulates a running DB
    // container found via `docker inspect`).
    const execFileAsync = sinon.stub().resolves({ stdout: VALID_CONTAINER_ID + '\n' })
    return {
        execFile: sinon.stub(),
        execFileAsync,
        db: {
            getModuleContainer: sinon.stub().resolves('db-container-id'),
            insertModuleContainer: sinon.stub().resolves(true)
        },
        getDbRootPassword: sinon.stub().returns('rootpass'),
        setDbRootPassword: sinon.stub(),
        statusChanged: sinon.stub().resolves(),
        getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } }),
        addContainerToNetwork: sinon.stub().resolves(true),
        getDockerNetworkInspect: sinon.stub().resolves({
            IPAM: { Config: [{ Gateway: '172.18.0.1' }] }
        })
    }
}

function loadDatabaseService(stubs) {
    return proxyquire('../../src/services/DatabaseService', {
        'child_process': { execFile: stubs.execFile },
        'util': { promisify: () => stubs.execFileAsync },
        'mariadb': {},
        'enquirer': { Password: class { run() { return Promise.resolve('rootpass') } } },
        '../state': {
            db: stubs.db,
            getDbRootPassword: stubs.getDbRootPassword,
            setDbRootPassword: stubs.setDbRootPassword
        },
        '../utils/helpers': { sleep: sinon.stub().resolves() },
        './ConfigService': {
            getDefaultConfig: sinon.stub().resolves({
                'DB_PORT': 3306,
                'HUB_PORT': 10000,
                'DECODER_DB_NAME': 'XChain_BTC_Mainnet_Decoder',
                'DECODER_DB_USER': 'xchain_decoder_bitcoin_mainnet',
                'DECODER_DB_PASS': 'xchain-password'
            }),
            getDockerContainerImageName: (mod) => 'xchain-node-' + mod,
            getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : '')
        },
        './DockerService': {
            getStatusFromContainer: stubs.getStatusFromContainer,
            getDockerNetworkInspect: stubs.getDockerNetworkInspect,
            addContainerToNetwork: stubs.addContainerToNetwork
        },
        './StatusService': {
            statusChanged: stubs.statusChanged,
            getInstalledCoinsAndNetworks: sinon.stub().resolves({ bitcoin: ['mainnet'] })
        }
    })
}

describe('DatabaseService', function () {

    // -------------------------------------------------------------------
    // checkIfDatabaseModuleExists
    // -------------------------------------------------------------------

    describe('checkIfDatabaseModuleExists()', function () {

        it('returns container ID when database container exists and is valid', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseModuleExists('bitcoin', 'mainnet')
            // Source now uses getDatabaseContainerId() → docker inspect → returns
            // the 64-char hex ID directly (not a DB-stored string).
            expect(result).to.equal(VALID_CONTAINER_ID)
        })

        it('returns null when container does not have State.Status', async function () {
            const stubs = makeStubs()
            stubs.getStatusFromContainer.resolves({})
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseModuleExists('bitcoin', 'mainnet')
            expect(result).to.be.null
        })

        it('returns null when docker inspect fails', async function () {
            const stubs = makeStubs()
            // Source uses getDatabaseContainerId() → execFileAsync('docker inspect ...).
            // Simulate container not found by rejecting the async exec.
            stubs.execFileAsync.rejects(new Error('not found'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseModuleExists('bitcoin', 'mainnet')
            expect(result).to.be.null
        })
    })

    // -------------------------------------------------------------------
    // executeDockerMariaDbCommand
    // -------------------------------------------------------------------

    describe('executeDockerMariaDbCommand()', function () {

        it('constructs correct docker exec command', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('docker')
                expect(args).to.include('exec')
                expect(args).to.include('-i')
                expect(args).to.include('db-container')
                expect(args).to.include('mariadb')
                expect(args).to.include('-u')
                expect(args).to.include('root')
                expect(args).to.include('-prootpass')
                expect(args).to.include('-e')
                expect(args).to.include('SELECT 1')
                cb(null, '1\n')
            })
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT 1')
            expect(result).to.equal('1')
        })

        it('appends commandOptions when provided', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(args).to.include('-B')
                expect(args).to.include('-N')
                cb(null, '0\n')
            })
            const ds = loadDatabaseService(stubs)
            await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT COUNT(*)', '-B -N')
        })

        it('rejects on exec error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(new Error('db error'))
            })
            const ds = loadDatabaseService(stubs)
            try {
                await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT 1')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // buildDatabaseModule
    // -------------------------------------------------------------------

    describe('buildDatabaseModule()', function () {

        it('skips installation when database already exists and connects to network', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            const result = await ds.buildDatabaseModule('bitcoin', 'mainnet')
            expect(result).to.be.true
            expect(stubs.addContainerToNetwork.calledOnce).to.be.true
        })

        it('installs mariadb when no existing database found', async function () {
            const stubs = makeStubs()
            // First execFileAsync call is `docker inspect` inside getDatabaseContainerId()
            // (called by checkIfDatabaseModuleExists). Rejecting it makes the check
            // return null → buildDatabaseModule enters the install branch.
            // Subsequent calls (docker pull, tag, run) resolve with a valid container ID.
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.buildDatabaseModule('bitcoin', 'mainnet')
            // Should call execFileAsync for docker pull, tag, and run
            expect(stubs.execFileAsync.called).to.be.true
        })

        // Locate the `docker run -d ...` argv array among the execFileAsync calls.
        function findDockerRunArgs(execFileAsync) {
            const call = execFileAsync.getCalls().find(c =>
                c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
            return call ? call.args[1] : null
        }

        it('appends MariaDB tuning args to docker run when env vars are set', async function () {
            const saved = {
                XCHAIN_NODE_DB_BUFFER_POOL_SIZE:        process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE,
                XCHAIN_NODE_DB_MAX_CONNECTIONS:         process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS,
                XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT: process.env.XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT
            }
            process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE        = '16G'
            process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS         = '300'
            process.env.XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT = '2'
            try {
                const stubs = makeStubs()
                stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
                stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
                const ds = loadDatabaseService(stubs)
                await ds.buildDatabaseModule('bitcoin', 'mainnet')

                const runArgs = findDockerRunArgs(stubs.execFileAsync)
                expect(runArgs, 'docker run call not found').to.not.be.null
                // mysqld args must come AFTER the image name, else Docker reads
                // them as `docker run` options instead of the container command.
                const imageIdx = runArgs.indexOf('xchain-node-database')
                const poolIdx  = runArgs.indexOf('--innodb-buffer-pool-size=16G')
                expect(imageIdx).to.be.greaterThan(-1)
                expect(poolIdx).to.be.greaterThan(imageIdx)
                expect(runArgs).to.include('--max-connections=300')
                expect(runArgs).to.include('--innodb-flush-log-at-trx-commit=2')
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })

        it('omits MariaDB tuning args when env vars are unset', async function () {
            const saved = {
                XCHAIN_NODE_DB_BUFFER_POOL_SIZE:        process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE,
                XCHAIN_NODE_DB_MAX_CONNECTIONS:         process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS,
                XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT: process.env.XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT
            }
            delete process.env.XCHAIN_NODE_DB_BUFFER_POOL_SIZE
            delete process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS
            delete process.env.XCHAIN_NODE_DB_FLUSH_LOG_AT_TRX_COMMIT
            try {
                const stubs = makeStubs()
                stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
                stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
                const ds = loadDatabaseService(stubs)
                await ds.buildDatabaseModule('bitcoin', 'mainnet')

                const runArgs = findDockerRunArgs(stubs.execFileAsync)
                expect(runArgs, 'docker run call not found').to.not.be.null
                expect(runArgs.some(a => a.startsWith('--innodb-buffer-pool-size'))).to.be.false
                expect(runArgs.some(a => a.startsWith('--max-connections'))).to.be.false
                expect(runArgs.some(a => a.startsWith('--innodb-flush-log-at-trx-commit'))).to.be.false
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })
    })

    // -------------------------------------------------------------------
    // checkIfDatabaseIsReady
    // -------------------------------------------------------------------

    describe('checkIfDatabaseIsReady()', function () {

        it('returns true when database responds', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: 'OK' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseIsReady('root', 'rootpass')
            expect(result).to.be.true
        })

        it('retries up to 10 times then returns false', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.rejects(new Error('connection refused'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseIsReady('root', 'badpass')
            expect(result).to.be.false
        })
    })
})
