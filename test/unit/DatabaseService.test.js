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
const { EventEmitter } = require('events')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CONTAINER_ID = 'a'.repeat(64)

// Fake `spawn` for executeDockerMariaDbCommand, which now pipes SQL to the
// mariadb client over STDIN (never argv). `respond(sql, args, opts)` decides
// the child's output from the SQL the source writes to stdin, returning
// `{ stdout?, stderr?, code?, error? }`. The returned child records argv
// (`_args`), env (`_env`) and the piped SQL (`_stdin`) for assertions; grab it
// in a test via `stubs.spawn.firstCall.returnValue`.
function fakeSpawn(respond) {
    return function (cmd, args, opts) {
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child._cmd = cmd
        child._args = args
        child._env = opts && opts.env
        child._stdin = ''
        child.stdin = {
            write(d) { if (d != null) child._stdin += d },
            end(d) {
                if (d != null) child._stdin += d
                const r = (respond ? respond(child._stdin, args, opts) : null) || {}
                setImmediate(() => {
                    if (r.stdout) child.stdout.emit('data', Buffer.from(String(r.stdout)))
                    if (r.stderr) child.stderr.emit('data', Buffer.from(String(r.stderr)))
                    if (r.error) { child.emit('error', r.error); return }
                    child.emit('close', r.code == null ? 0 : r.code)
                })
            },
            on() {}
        }
        return child
    }
}

function makeStubs(overrides = {}) {
    // execFileAsync is what the source uses (via promisify(execFile)) for all
    // docker inspect / docker port / docker pull / docker run calls.
    // Default: return a valid 64-char hex container ID (simulates a running DB
    // container found via `docker inspect`).
    const execFileAsync = sinon.stub().resolves({ stdout: VALID_CONTAINER_ID + '\n' })

    // Fake mariadb connection used in executeNativeMariaDbCommand / _pingMariaDb
    const fakeConn = {
        query: sinon.stub().resolves([]),
        end: sinon.stub().resolves()
    }
    const mariadbStub = {
        createConnection: sinon.stub().resolves(fakeConn),
        _fakeConn: fakeConn
    }

    return {
        execFile: sinon.stub(),
        // executeDockerMariaDbCommand now uses spawn (SQL via stdin). Default:
        // a child that succeeds with empty output; tests override per-case.
        spawn: sinon.stub().callsFake(fakeSpawn(() => ({ stdout: '', code: 0 }))),
        execFileAsync,
        mariadb: mariadbStub,
        db: {
            isReady: sinon.stub().returns(true),
            assertReady: sinon.stub(),
            createDatabase: sinon.stub().resolves(),
            getModuleContainer: sinon.stub().resolves('db-container-id'),
            insertModuleContainer: sinon.stub().resolves(true)
        },
        getInstalledCoinsAndNetworks: sinon.stub().resolves({ bitcoin: ['mainnet'] }),
        getDbRootPassword: sinon.stub().returns('rootpass'),
        setDbRootPassword: sinon.stub(),
        statusChanged: sinon.stub().resolves(),
        getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } }),
        forceRemoveContainerByName: sinon.stub().resolves(true),
        addContainerToNetwork: sinon.stub().resolves(true),
        getDockerNetworkInspect: sinon.stub().resolves({
            IPAM: { Config: [{ Gateway: '172.18.0.1' }] }
        }),
        hasCredentials: sinon.stub().returns(false),
        loadCredentials: sinon.stub().returns(null),
        saveCredentials: sinon.stub(),
        hasExternalDbConfig: sinon.stub().returns(false),
        loadExternalDbConfig: sinon.stub().returns(null),
        saveExternalDbConfig: sinon.stub(),
        loadDbRootPassword: sinon.stub().returns(null),
        saveDbRootPassword: sinon.stub(),
        getOsUserDbName: sinon.stub().returns('xchain_node_testuser'),
        generatePassword: sinon.stub().returns('test-generated-pass'),
        assertNoHostPortConflicts: sinon.stub().resolves(),
        ...overrides
    }
}

function loadDatabaseService(stubs, constants = {}) {
    const defaultConstants = {
        DB_MODULE_NAME: 'database',
        HUB_MODULE_NAME: 'xchain-hub',
        XChainService: {
            XCHAIN_DECODER: 'xchain-decoder',
            XCHAIN_INDEXER: 'xchain-indexer'
        },
        SEP: '-',
        EXTERNAL_DB: false,
        EXTERNAL_DB_HOST: '127.0.0.1',
        EXTERNAL_DB_PORT: 3306,
        EXTERNAL_DB_ROOT_USER: 'root',
        ...constants
    }

    return proxyquire('../../src/services/DatabaseService', {
        'child_process': { execFile: stubs.execFile, spawn: stubs.spawn },
        'util': { promisify: () => stubs.execFileAsync },
        'mariadb': stubs.mariadb,
        'enquirer': {
            Password: class { run() { return Promise.resolve('rootpass') } },
            Input: class { run() { return Promise.resolve('127.0.0.1') } },
            NumberPrompt: class { run() { return Promise.resolve(3306) } }
        },
        '../state': {
            db: stubs.db,
            getDbRootPassword: stubs.getDbRootPassword,
            setDbRootPassword: stubs.setDbRootPassword
        },
        '../utils/helpers': { sleep: sinon.stub().resolves() },
        '../config/constants': defaultConstants,
        './ConfigService': {
            getDefaultConfig: sinon.stub().resolves({
                'DB_PORT': 3306,
                'HUB_PORT': 10000,
                'DECODER_DB_NAME': 'XChain_BTC_Mainnet_Decoder',
                'DECODER_DB_USER': 'xchain_decoder_bitcoin_mainnet',
                'DECODER_DB_PASS': 'test-pass',
                'INDEXER_DB_NAME': 'XChain_BTC_Mainnet_Indexer',
                'INDEXER_DB_USER': 'xchain_indexer_bitcoin_mainnet',
                'INDEXER_DB_PASS': 'test-pass'
            }),
            getDockerContainerImageName: (mod) => 'xchain-node-' + mod,
            getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
            getModuleDatabaseName: (mod, coin, net) => 'XChain_BTC_Mainnet_Decoder',
            validatePort: require('../../src/services/ConfigService').validatePort
        },
        './DockerService': {
            getStatusFromContainer: stubs.getStatusFromContainer,
            getDockerNetworkInspect: stubs.getDockerNetworkInspect,
            addContainerToNetwork: stubs.addContainerToNetwork,
            forceRemoveContainerByName: stubs.forceRemoveContainerByName
        },
        // buildDatabaseModule lazy-requires this for the multi-stack host-port
        // pre-flight; stub it so the install branch doesn't load the real
        // (LevelDB-backed) ModuleService. Default: no conflict (resolves).
        './ModuleService': {
            assertNoHostPortConflicts: stubs.assertNoHostPortConflicts
        },
        './StatusService': {
            statusChanged: stubs.statusChanged,
            getInstalledCoinsAndNetworks: stubs.getInstalledCoinsAndNetworks
        },
        './CredentialsService': {
            XCHAIN_NODE_DB: 'xchain_node',
            getOsUserDbName: stubs.getOsUserDbName,
            generatePassword: stubs.generatePassword,
            hasCredentials: stubs.hasCredentials,
            loadCredentials: stubs.loadCredentials,
            saveCredentials: stubs.saveCredentials,
            hasExternalDbConfig: stubs.hasExternalDbConfig,
            loadExternalDbConfig: stubs.loadExternalDbConfig,
            saveExternalDbConfig: stubs.saveExternalDbConfig,
            loadDbRootPassword: stubs.loadDbRootPassword,
            saveDbRootPassword: stubs.saveDbRootPassword
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

        it('returns null when getStatusFromContainer throws', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            stubs.getStatusFromContainer.rejects(new Error('docker inspect status error'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseModuleExists('bitcoin', 'mainnet')
            expect(result).to.be.null
        })
    })

    // -------------------------------------------------------------------
    // executeDockerMariaDbCommand
    // -------------------------------------------------------------------

    describe('executeDockerMariaDbCommand()', function () {

        it('pipes SQL via stdin (never argv) with the password in env, not argv', async function () {
            const stubs = makeStubs()
            stubs.spawn.callsFake(fakeSpawn(() => ({ stdout: '1\n' })))
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT 1')
            expect(result).to.equal('1')

            const child = stubs.spawn.firstCall.returnValue
            expect(stubs.spawn.firstCall.args[0]).to.equal('docker')
            expect(child._args).to.include('exec')
            expect(child._args).to.include('-i')
            expect(child._args).to.include('db-container')
            expect(child._args).to.include('mariadb')
            expect(child._args).to.include('-u')
            expect(child._args).to.include('root')
            // The SQL must NOT appear anywhere in argv; it is piped via stdin.
            expect(child._args.some(a => String(a).includes('SELECT 1'))).to.be.false
            expect(child._stdin).to.include('SELECT 1')
            // Password must travel via MYSQL_PWD env (forwarded with a bare
            // docker -e), never as a -p<password> argv entry.
            expect(child._args).to.include('MYSQL_PWD')
            expect(child._args.some(a => String(a).includes('rootpass'))).to.be.false
            expect(child._env.MYSQL_PWD).to.equal('rootpass')
        })

        it('appends commandOptions when provided', async function () {
            const stubs = makeStubs()
            stubs.spawn.callsFake(fakeSpawn(() => ({ stdout: '0\n' })))
            const ds = loadDatabaseService(stubs)
            await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT COUNT(*)', '-B -N')
            const child = stubs.spawn.firstCall.returnValue
            expect(child._args).to.include('-B')
            expect(child._args).to.include('-N')
        })

        it('rejects on non-zero exit', async function () {
            const stubs = makeStubs()
            stubs.spawn.callsFake(fakeSpawn(() => ({ stderr: 'db error', code: 1 })))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT 1')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })

        // Security: a failed command must not leak the SQL (which can embed a
        // user password). The SQL is no longer in argv at all; this guards the
        // remaining vector: mariadb's stderr echoing a fragment of the failing
        // statement, which callers console.log.
        it('scrubs the SQL from a failed command (avoids leaking an embedded password)', async function () {
            const stubs = makeStubs()
            const SECRET = 'us3r-pw-do-not-leak'
            const SQL = "CREATE USER 'x'@'%' IDENTIFIED BY PASSWORD('" + SECRET + "')"
            stubs.spawn.callsFake(fakeSpawn(() => ({
                // mariadb batch-mode error echoing the offending statement
                stderr: 'ERROR 1064 (42000) at line 1 near ' + SQL,
                code: 1
            })))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.executeDockerMariaDbCommand('db-container', 'rootpass', SQL)
                expect.fail('should have rejected')
            } catch (err) {
                expect(err.message).to.not.include(SECRET)
                expect(err.message).to.include('<redacted-sql>')
            }
        })
    })

    // -------------------------------------------------------------------
    // executeNativeMariaDbCommand (external-DB path)
    // -------------------------------------------------------------------

    describe('executeNativeMariaDbCommand()', function () {

        // Security: the mariadb driver embeds the failing SQL in its error
        // (.message / .sql), which a user-creation statement fills with a
        // password. Scrub it before the error propagates to a console.log.
        it('scrubs the SQL from a driver query error (avoids leaking an embedded password)', async function () {
            const stubs = makeStubs()
            const SECRET = 'us3r-pw-do-not-leak'
            const SQL = "CREATE USER 'x'@'%' IDENTIFIED BY PASSWORD('" + SECRET + "')"
            const driverErr = new Error('(conn=1, no: 1064, SQLState: 42000) syntax error\nsql: ' + SQL)
            driverErr.sql = SQL
            stubs.mariadb._fakeConn.query.rejects(driverErr)
            const ds = loadDatabaseService(stubs)
            const cfg = { host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'rootpass' }
            try {
                await ds.executeNativeMariaDbCommand(cfg, SQL)
                expect.fail('should have rejected')
            } catch (err) {
                expect(err.message).to.not.include(SECRET)
                expect(String(err.sql || '')).to.not.include(SECRET)
                expect(err.message).to.include('<redacted-sql>')
            }
            // Connection is still closed via the finally block.
            expect(stubs.mariadb._fakeConn.end.called).to.be.true
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

        it('fails fast with an actionable error when the existing DB container is not running', async function () {
            // A stopped/exited MariaDB container must not be treated as installed:
            // otherwise the readiness probe burns ~100s of retries before a
            // misleading abort. It must also NOT be auto-started or recreated.
            const stubs = makeStubs({
                getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'exited' } })
            })
            const ds = loadDatabaseService(stubs)
            let threw = null
            try {
                await ds.buildDatabaseModule('bitcoin', 'mainnet')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.match(/exists but is exited/)
            expect(threw.message).to.match(/docker start/)
            // No network mutation and no recreate attempt on a stopped container.
            expect(stubs.addContainerToNetwork.called).to.be.false
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

        it('throws instead of returning undefined when docker run output is not a 64-hex id', async function () {
            // uuid:fb0c275d: a mismatched id (e.g. a warning line ahead of the id)
            // means the container IS running but unregistered; falling through
            // silently would orphan it and cause a duplicate on the next run.
            const stubs = makeStubs()
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: 'Warning: some notice\nnot-a-valid-id\n' })
            const ds = loadDatabaseService(stubs)
            let threw = null
            try {
                await ds.buildDatabaseModule('bitcoin', 'mainnet')
            } catch (err) { threw = err }
            expect(threw).to.not.be.null
            expect(String(threw)).to.include('Unexpected docker run output')
        })

        it('runs the multi-stack host-port pre-flight before docker run', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            await ds.buildDatabaseModule('bitcoin', 'mainnet')

            expect(stubs.assertNoHostPortConflicts.calledOnce).to.be.true
            const [portArgs, selfName] = stubs.assertNoHostPortConflicts.firstCall.args
            // -p spec binds the DB host port to container 3306, scoped to the DB container name.
            expect(portArgs).to.include('-p')
            expect(portArgs.some(a => /:3306$/.test(a))).to.be.true
            expect(selfName).to.equal('xchain-node-database')
        })

        it('aborts the install (no docker run) when a host-port conflict is detected', async function () {
            const stubs = makeStubs({
                assertNoHostPortConflicts: sinon.stub().rejects(new Error('Host port conflict: host port 13306 is already published by: other-stack-database'))
            })
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            let threw = null
            try {
                await ds.buildDatabaseModule('bitcoin', 'mainnet')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.include('Host port conflict')
            // The guard runs after pull/tag but before run, so `docker run` must NOT fire.
            expect(findDockerRunArgs(stubs.execFileAsync)).to.be.null
        })

        // Locate the `docker run -d ...` argv array among the execFileAsync calls.
        function findDockerRunArgs(execFileAsync) {
            const call = execFileAsync.getCalls().find(c =>
                c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
            return call ? call.args[1] : null
        }

        // Security regression: the MariaDB root password must reach the container
        // via docker's OWN environment (bare `--env NAME` + execFile { env }), and
        // must NEVER appear in the docker argv. If it did, a failed `docker run`
        // would reject with the secret embedded in err.cmd/err.message, which
        // upstream error logging (precheck's console.log(err)) would print.
        it('passes MYSQL_ROOT_PASSWORD via docker env, never in the argv', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            await ds.buildDatabaseModule('bitcoin', 'mainnet')

            // The enquirer Password prompt is stubbed to resolve 'rootpass'.
            const ROOT_PW = 'rootpass'
            const runCall = stubs.execFileAsync.getCalls().find(c =>
                c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
            expect(runCall, 'docker run call not found').to.not.be.undefined

            const runArgs = runCall.args[1]
            const runOpts = runCall.args[2] || {}

            // 1) The secret must not appear anywhere in the command line.
            expect(runArgs.some(a => String(a).includes(ROOT_PW)), 'secret leaked into docker argv').to.be.false
            expect(runArgs.some(a => /^MYSQL_ROOT_PASSWORD=/.test(String(a))), 'inline --env NAME=value leaks the secret').to.be.false
            // 2) The bare env name is forwarded so docker reads it from its env.
            expect(runArgs).to.include('MYSQL_ROOT_PASSWORD')
            // 3) The value is supplied through the child process environment.
            expect(runOpts.env, 'docker run env not set').to.be.an('object')
            expect(runOpts.env.MYSQL_ROOT_PASSWORD).to.equal(ROOT_PW)
        })

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

        it('defaults max-connections to 1000 when the env var is unset (multi-chain saturation guard)', async function () {
            const saved = process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS
            delete process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS
            try {
                const stubs = makeStubs()
                stubs.execFileAsync.onFirstCall().rejects(new Error('No such container'))
                stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
                const ds = loadDatabaseService(stubs)
                await ds.buildDatabaseModule('bitcoin', 'mainnet')

                const runArgs = findDockerRunArgs(stubs.execFileAsync)
                expect(runArgs, 'docker run call not found').to.not.be.null
                expect(runArgs).to.include('--max-connections=1000')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS
                else process.env.XCHAIN_NODE_DB_MAX_CONNECTIONS = saved
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
                // max-connections is deliberately NOT omitted when unset: it falls back to
                // the 1000 default (see the saturation-guard test above).
                expect(runArgs).to.include('--max-connections=1000')
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

        it('passes -D database arg when database is specified', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: 'OK' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseIsReady('root', 'rootpass', 'xchain_node')
            expect(result).to.be.true
            const dockerCall = stubs.execFileAsync.getCalls().find(c =>
                c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1].includes('mariadb'))
            expect(dockerCall.args[1]).to.include('-D')
            expect(dockerCall.args[1]).to.include('xchain_node')
        })

        it('passes the password via MYSQL_PWD env, never in argv', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: 'OK' })
            const ds = loadDatabaseService(stubs)
            await ds.checkIfDatabaseIsReady('root', 's3cret-pw')
            const dockerCall = stubs.execFileAsync.getCalls().find(c =>
                c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1].includes('mariadb'))
            expect(dockerCall.args[1]).to.include('MYSQL_PWD')
            expect(dockerCall.args[1].some(a => String(a).includes('s3cret-pw'))).to.be.false
            expect(dockerCall.args[2].env.MYSQL_PWD).to.equal('s3cret-pw')
        })
    })

    // -------------------------------------------------------------------
    // getDatabaseHostPort
    // -------------------------------------------------------------------

    describe('getDatabaseHostPort()', function () {

        it('parses port from docker port output', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: '0.0.0.0:13306\n' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseHostPort()
            expect(result).to.equal(13306)
        })

        it('returns default port when docker port fails', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.rejects(new Error('no such container'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseHostPort()
            expect(result).to.equal(13306) // XCHAIN_NODE_DB_DEFAULT_PORT
        })

        it('returns default port when output has no port match', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: 'no port info\n' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseHostPort()
            expect(result).to.equal(13306)
        })
    })

    // -------------------------------------------------------------------
    // getDatabaseContainerId
    // -------------------------------------------------------------------

    describe('getDatabaseContainerId()', function () {

        it('returns container ID when inspect returns valid 64-char hex', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseContainerId()
            expect(result).to.equal(VALID_CONTAINER_ID)
        })

        it('returns null when inspect returns non-hex output', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: 'not-a-container-id\n' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseContainerId()
            expect(result).to.be.null
        })

        it('returns null when inspect command throws', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.rejects(new Error('container not found'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseContainerId()
            expect(result).to.be.null
        })
    })

    // -------------------------------------------------------------------
    // getExternalDbConfig
    // -------------------------------------------------------------------

    describe('getExternalDbConfig()', function () {

        let savedEnv = {}
        const ENV_KEYS = [
            'XCHAIN_NODE_EXTERNAL_DB_HOST',
            'XCHAIN_NODE_EXTERNAL_DB_PORT',
            'XCHAIN_NODE_EXTERNAL_DB_ROOT_USER',
            'XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD'
        ]

        beforeEach(function () {
            for (const k of ENV_KEYS) {
                savedEnv[k] = process.env[k]
                delete process.env[k]
            }
        })

        afterEach(function () {
            for (const k of ENV_KEYS) {
                if (savedEnv[k] === undefined) delete process.env[k]
                else process.env[k] = savedEnv[k]
            }
        })

        it('returns config from env vars when all four are set', async function () {
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = 'db.example.com'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = '3307'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'admin'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'test-pass'

            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            const result = await ds.getExternalDbConfig()

            expect(result.host).to.equal('db.example.com')
            expect(result.port).to.equal(3307)
            expect(result.root_user).to.equal('admin')
            expect(result.root_password).to.equal('test-pass')
        })

        it('returns saved config from credentials when ping succeeds', async function () {
            const savedCfg = { host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'test-pass' }
            const stubs = makeStubs({
                hasExternalDbConfig: sinon.stub().returns(true),
                loadExternalDbConfig: sinon.stub().returns(savedCfg)
            })
            // mariadb ping should succeed
            stubs.mariadb._fakeConn.query.resolves([])
            const ds = loadDatabaseService(stubs)
            const result = await ds.getExternalDbConfig()
            expect(result).to.deep.equal(savedCfg)
        })

        it('re-prompts interactively when saved config ping fails', async function () {
            const savedCfg = { host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'old-pass' }
            const stubs = makeStubs({
                hasExternalDbConfig: sinon.stub().returns(true),
                loadExternalDbConfig: sinon.stub().returns(savedCfg)
            })
            // First ping (saved config) fails; second ping (from prompt) succeeds
            stubs.mariadb.createConnection
                .onFirstCall().rejects(new Error('auth failed'))
                .resolves(stubs.mariadb._fakeConn)

            const ds = loadDatabaseService(stubs)
            const result = await ds.getExternalDbConfig()
            // Should have called saveExternalDbConfig after successful prompt
            expect(stubs.saveExternalDbConfig.calledOnce).to.be.true
            expect(result).to.be.an('object')
        })

        // #3143: the external-DB port must be validatePort-gated at the resolver,
        // so a malformed env value fails loud here rather than propagating NaN
        // into spawn('mariadb', '-P', ...) and every container's *_DB_PORT env.
        it('throws on a malformed external-DB port from env instead of returning NaN', async function () {
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = 'db.example.com'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = 'not-a-port'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'admin'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'test-pass'

            const ds = loadDatabaseService(makeStubs())
            let threw = null
            try { await ds.getExternalDbConfig() } catch (e) { threw = e }
            expect(threw, 'expected a thrown error for a bad port').to.be.an('error')
            expect(threw.message).to.match(/Invalid external-DB port/)
        })

        it('throws on an out-of-range external-DB port from env', async function () {
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = 'db.example.com'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = '70000'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'admin'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'test-pass'

            const ds = loadDatabaseService(makeStubs())
            let threw = null
            try { await ds.getExternalDbConfig() } catch (e) { threw = e }
            expect(threw, 'expected a thrown error for an out-of-range port').to.be.an('error')
            expect(threw.message).to.match(/Invalid external-DB port/)
        })
    })

    // -------------------------------------------------------------------
    // executeNativeMariaDbCommand
    // -------------------------------------------------------------------

    describe('executeNativeMariaDbCommand()', function () {

        const extCfg = { host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'test-pass' }

        it('returns empty string for DDL (non-array result)', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves({ affectedRows: 1 }) // non-array = DDL
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'CREATE DATABASE foo')
            expect(result).to.equal('')
        })

        it('returns empty string for SELECT without batch mode', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([{ col: 'val' }])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT 1')
            expect(result).to.equal('')
        })

        it('returns tab-delimited rows in batch mode (-B -N)', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([['3'], ['5']])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT id FROM tbl', '-B -N')
            expect(result).to.equal('3\n5')
        })

        it('returns tab-joined columns in batch mode for multi-column rows', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([['a', 'b', 'c']])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT a,b,c FROM tbl', '-B -N')
            expect(result).to.equal('a\tb\tc')
        })

        it('returns empty string for empty batch result', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT id FROM tbl', '-B -N')
            expect(result).to.equal('')
        })

        it('recognizes --batch flag', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([['1']])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT 1', '--batch --skip-column-names')
            expect(result).to.equal('1')
        })

        it('closes connection even when query throws', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.rejects(new Error('query error'))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.executeNativeMariaDbCommand(extCfg, 'SELECT 1')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.equal('query error')
            }
            expect(stubs.mariadb._fakeConn.end.calledOnce).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // askMariadbRootPassword
    // -------------------------------------------------------------------

    describe('askMariadbRootPassword()', function () {

        it('returns cached password immediately', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns('cached-pass')
            const ds = loadDatabaseService(stubs)
            const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
            expect(result).to.equal('cached-pass')
        })

        it('reads from external DB config when EXTERNAL_DB=true and not cached', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns(null)
            stubs.mariadb._fakeConn.query.resolves([])

            const saved = {
                XCHAIN_NODE_EXTERNAL_DB_HOST:          process.env.XCHAIN_NODE_EXTERNAL_DB_HOST,
                XCHAIN_NODE_EXTERNAL_DB_PORT:          process.env.XCHAIN_NODE_EXTERNAL_DB_PORT,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_USER:     process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD
            }
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = '127.0.0.1'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = '3306'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'root'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'external-root-pass'
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('external-root-pass')
                expect(stubs.setDbRootPassword.calledWith('external-root-pass')).to.be.true
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })

        it('reads from XCHAIN_NODE_DB_ROOT_PASSWORD env var when not cached and no container is running', async function () {
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'env-root-pass'
            try {
                const stubs = makeStubs()
                stubs.getDbRootPassword.returns(null)
                // No container up yet (fresh install): checkIfDatabaseModuleExists ->
                // getDatabaseContainerId's inspect call resolves a non-hex id, so it
                // returns null and there is nothing to verify the env override
                // against; it must be accepted as-is (uuid:2c5ec698).
                stubs.execFileAsync.resolves({ stdout: 'Error: No such object\n' })
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('env-root-pass')
                expect(stubs.setDbRootPassword.calledWith('env-root-pass')).to.be.true
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })

        it('verifies XCHAIN_NODE_DB_ROOT_PASSWORD against a running container before trusting it', async function () {
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'env-root-pass'
            try {
                const stubs = makeStubs()
                stubs.getDbRootPassword.returns(null)
                // Container IS running: inspect finds it, then the env password
                // must be verified with a ping before being trusted.
                stubs.execFileAsync
                    .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' }) // getDatabaseContainerId (inspect)
                    .onCall(1).resolves({ stdout: 'mysqld is alive\n' })       // ping with the env password
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('env-root-pass')
                expect(stubs.setDbRootPassword.calledWith('env-root-pass')).to.be.true
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })

        it('falls through to the container-env read when XCHAIN_NODE_DB_ROOT_PASSWORD does not verify', async function () {
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'stale-env-pass'
            try {
                const stubs = makeStubs()
                stubs.getDbRootPassword.returns(null)
                stubs.execFileAsync
                    .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })    // getDatabaseContainerId (inspect)
                    .onCall(1).resolves({ stdout: 'Access denied\n' })           // ping with the stale env password: fails
                    .onCall(2).resolves({ stdout: 'container-root-pass\n' })     // docker exec printenv
                    .onCall(3).resolves({ stdout: 'mysqld is alive\n' })         // ping with the container's real password
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('container-root-pass')
                expect(stubs.setDbRootPassword.calledWith('container-root-pass')).to.be.true
                expect(stubs.setDbRootPassword.calledWith('stale-env-pass')).to.be.false
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })

        it('reads root password from running container printenv', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns(null)
            // Flow (no env var XCHAIN_NODE_DB_ROOT_PASSWORD set):
            //   1. checkIfDatabaseModuleExists -> getDatabaseContainerId -> execFileAsync call 0 (inspect)
            //   2. getStatusFromContainer returns { State: { Status: 'running' } } -> dbContainerId found
            //   3. execFileAsync call 1 (docker exec printenv) -> 'container-root-pass\n'
            //   4. execFileAsync call 2 (docker exec mariadb-admin ping) -> 'mysqld is alive\n'
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // getDatabaseContainerId (inspect)
                .onCall(1).resolves({ stdout: 'container-root-pass\n' })    // docker exec printenv
                .onCall(2).resolves({ stdout: 'mysqld is alive\n' })        // docker exec mariadb-admin ping
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            try {
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('container-root-pass')
                expect(stubs.setDbRootPassword.calledWith('container-root-pass')).to.be.true
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })

        it('persists the container-env password to the credentials store on accept', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns(null)
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // getDatabaseContainerId (inspect)
                .onCall(1).resolves({ stdout: 'container-root-pass\n' })    // docker exec printenv
                .onCall(2).resolves({ stdout: 'mysqld is alive\n' })        // ping
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            try {
                const ds = loadDatabaseService(stubs)
                await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(stubs.saveDbRootPassword.calledWith('container-root-pass')).to.be.true
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })

        it('falls back to the credentials-store copy when the container has no MYSQL_ROOT_PASSWORD env', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns(null)
            stubs.loadDbRootPassword.returns('stored-root-pass')
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // getDatabaseContainerId (inspect)
                .onCall(1).rejects(new Error('printenv: MYSQL_ROOT_PASSWORD not set')) // container env missing
                .onCall(2).resolves({ stdout: 'mysqld is alive\n' })        // ping with the stored copy
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            try {
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('stored-root-pass')
                expect(stubs.setDbRootPassword.calledWith('stored-root-pass')).to.be.true
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })

        it('throws an actionable error instead of prompting when stdin is not a TTY', async function () {
            const stubs = makeStubs()
            stubs.getDbRootPassword.returns(null)
            stubs.loadDbRootPassword.returns(null)
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // getDatabaseContainerId (inspect)
                .onCall(1).rejects(new Error('printenv: MYSQL_ROOT_PASSWORD not set')) // container env missing
            const savedEnv = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })
            try {
                const ds = loadDatabaseService(stubs)
                let err = null
                try { await ds.askMariadbRootPassword('bitcoin', 'mainnet') } catch (e) { err = e }
                expect(err).to.be.an('error')
                expect(err.message).to.include('XCHAIN_NODE_DB_ROOT_PASSWORD')
                expect(err.message).to.include('no TTY')
            } finally {
                if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY)
                else delete process.stdin.isTTY
                if (savedEnv === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = savedEnv
            }
        })

        it('ignores a stale credentials-store copy and reaches the prompt on a TTY', async function () {
            let dbRootPassword = null
            const stubs = makeStubs()
            stubs.getDbRootPassword.callsFake(() => dbRootPassword)
            stubs.setDbRootPassword.callsFake(p => { dbRootPassword = p })
            stubs.loadDbRootPassword.returns('stale-stored-pass')
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // getDatabaseContainerId (inspect)
                .onCall(1).rejects(new Error('printenv: MYSQL_ROOT_PASSWORD not set')) // container env missing
                .onCall(2).resolves({ stdout: 'Access denied\n' })          // ping with the stale stored copy: fails
                .onCall(3).resolves({ stdout: 'mysqld is alive\n' })        // ping with the prompted answer
            const savedEnv = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
            try {
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                expect(result).to.equal('rootpass')                          // the prompt stub's answer
                expect(stubs.saveDbRootPassword.calledWith('rootpass')).to.be.true
                expect(stubs.setDbRootPassword.calledWith('stale-stored-pass')).to.be.false
            } finally {
                if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY)
                else delete process.stdin.isTTY
                if (savedEnv === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = savedEnv
            }
        })

        it('falls back to password prompt when no container found', async function () {
            // When no container exists, prompt runs and setDbRootPassword is called.
            // The while condition checks getDbRootPassword(); after prompt, we need
            // it to return the set value so the loop exits.
            let dbRootPassword = null
            const stubs = makeStubs()
            stubs.getDbRootPassword.callsFake(() => dbRootPassword)
            stubs.setDbRootPassword.callsFake(p => { dbRootPassword = p })
            // getDatabaseContainerId (in checkIfDatabaseModuleExists) rejects -> null container
            stubs.execFileAsync.rejects(new Error('no container'))
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            // The non-TTY guard fails fast before the prompt; force a TTY so
            // this test exercises the prompt path regardless of the runner.
            const savedIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
            try {
                const ds = loadDatabaseService(stubs)
                const result = await ds.askMariadbRootPassword('bitcoin', 'mainnet')
                // The prompt stub returns 'rootpass' and since no container exists,
                // setDbRootPassword is called directly and 'rootpass' returned
                expect(result).to.equal('rootpass')
                expect(dbRootPassword).to.equal('rootpass')
            } finally {
                if (savedIsTTY) Object.defineProperty(process.stdin, 'isTTY', savedIsTTY)
                else delete process.stdin.isTTY
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })
    })

    // -------------------------------------------------------------------
    // addUserPasswordToDatabase
    // -------------------------------------------------------------------

    describe('addUserPasswordToDatabase()', function () {

        it('creates database and user via docker when db does not exist', async function () {
            const stubs = makeStubs()
            // execFileAsync[0] = docker inspect (getDatabaseContainerId in checkIfDatabaseIsReady)
            // executeDockerMariaDbCommand pipes the SQL via stdin; branch on it.
            // dbCount = '0' → create DB + user + grant
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                // Return '0' for COUNT queries, '' for DDL
                if (sql.startsWith('SELECT COUNT')) return { stdout: '0\n' }
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            const result = await ds.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass'
            )
            expect(result).to.be.true
        })

        it('skips create when database already exists (dbCount != 0)', async function () {
            const stubs = makeStubs()
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                if (sql.startsWith('SELECT COUNT(SCHEMA_NAME)')) return { stdout: '1\n' } // DB already exists
                if (sql.startsWith('SELECT COUNT(*)')) return { stdout: '1\n' } // user already exists
                if (sql.startsWith('SHOW GRANTS')) {
                    // Include the full grant so it skips GRANT command too
                    return { stdout: "GRANT ALL PRIVILEGES ON 'XChain_BTC_Mainnet_Decoder'.* TO 'xchain_decoder_bitcoin_mainnet'@'%'\n" }
                }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            const result = await ds.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass'
            )
            expect(result).to.be.true
        })

        it('grants MVH test permissions when module is xchain-hub', async function () {
            const stubs = makeStubs()
            const executedCommands = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executedCommands.push(sql)
                if (sql.startsWith('SELECT COUNT')) return { stdout: '0\n' }
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            await ds.addUserPasswordToDatabase(
                'xchain-hub', 'bitcoin', 'mainnet',
                'xchain_node', 'xchain_node_user', 'test-pass'
            )
            const mvhGrant = executedCommands.find(c => c && c.includes('MVH'))
            expect(mvhGrant).to.exist
        })

        it('rotates the password via ALTER USER on the docker path when the user does not match', async function () {
            // userCount == 0 covers both "user absent" and "user exists with a different
            // password". The docker path must ALTER USER (not just CREATE USER IF NOT EXISTS,
            // a no-op for an existing user) so an existing install is migrated off the legacy
            // static password to the generated per-install one on the next update.
            const stubs = makeStubs()
            const executedCommands = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executedCommands.push(sql)
                if (sql.startsWith('SELECT COUNT(SCHEMA_NAME)')) return { stdout: '1\n' } // DB already exists
                if (sql.startsWith('SELECT COUNT(*)')) return { stdout: '0\n' }            // user missing OR password mismatch
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            await ds.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'rotated-pass'
            )
            const alter = executedCommands.find(c => c && /^ALTER USER .* IDENTIFIED BY 'rotated-pass'/.test(c))
            expect(alter, 'docker path must ALTER USER to force the new password').to.exist
        })

        it('throws when docker exec fails', async function () {
            const stubs = makeStubs()
            stubs.spawn.callsFake(fakeSpawn(() => ({ error: new Error('docker exec failed') })))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass'
                )
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.equal('docker exec failed')
            }
        })
    })

    // -------------------------------------------------------------------
    // addUserPasswordToDatabase: SQL-injection / quote-breakage safety
    // Provisioning DDL is built by string concatenation (identifiers cannot be
    // bound, the docker path pipes raw SQL), so the account password must be
    // emitted as a properly escaped literal and identifiers must be allowlisted.
    // -------------------------------------------------------------------

    describe('addUserPasswordToDatabase(): provisioning-SQL safety', function () {

        it('escapes a quote-containing password into a single well-formed string literal (docker path)', async function () {
            const stubs = makeStubs()
            const executedCommands = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executedCommands.push(sql)
                if (sql.startsWith('SELECT COUNT')) return { stdout: '0\n' }
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            // A password crafted to break out of the IDENTIFIED BY '...' literal
            // and inject a second statement executed as root.
            const evilPass = "x'; DROP DATABASE XChain_BTC_Mainnet_Decoder; --"
            const result = await ds.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', evilPass
            )
            expect(result).to.be.true

            const createUser = executedCommands.find(c => c && c.startsWith('CREATE USER'))
            expect(createUser, 'CREATE USER statement should have run').to.exist
            // The embedded quote is backslash-escaped, so the injected DROP stays
            // inside the string literal and never becomes a separate statement.
            expect(createUser).to.include("IDENTIFIED BY 'x\\'; DROP DATABASE XChain_BTC_Mainnet_Decoder; --'")
            expect(createUser).to.not.match(/IDENTIFIED BY 'x';\s*DROP DATABASE/)
        })

        it('leaves a plain password byte-for-byte unchanged (no behaviour drift for existing installs)', async function () {
            const stubs = makeStubs()
            const executedCommands = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executedCommands.push(sql)
                if (sql.startsWith('SELECT COUNT')) return { stdout: '0\n' }
                if (sql.startsWith('SHOW GRANTS')) return { stdout: 'GRANT USAGE ON *.* TO user\n' }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            await ds.addUserPasswordToDatabase(
                'xchain-decoder', 'bitcoin', 'mainnet',
                'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'plain-Pass_09'
            )
            const createUser = executedCommands.find(c => c && c.startsWith('CREATE USER'))
            expect(createUser).to.include("IDENTIFIED BY 'plain-Pass_09'")
        })

        it('rejects an injection-bearing database name before any SQL runs', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            try {
                await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    "XChain`; DROP DATABASE x; --", 'xchain_decoder_bitcoin_mainnet', 'test-pass'
                )
                expect.fail('should have thrown on unsafe database name')
            } catch (err) {
                expect(err.message).to.match(/Unsafe MariaDB database name/)
            }
            expect(stubs.spawn.called, 'no docker exec should run for a rejected identifier').to.be.false
        })

        it('rejects an injection-bearing user name before any SQL runs', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            try {
                await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    'XChain_BTC_Mainnet_Decoder', "u'@'%'; DROP USER root; --", 'test-pass'
                )
                expect.fail('should have thrown on unsafe user name')
            } catch (err) {
                expect(err.message).to.match(/Unsafe MariaDB database user/)
            }
            expect(stubs.spawn.called, 'no docker exec should run for a rejected identifier').to.be.false
        })
    })

    // -------------------------------------------------------------------
    // addUserPasswordToDatabase: EXTERNAL_DB path
    // -------------------------------------------------------------------

    describe('addUserPasswordToDatabase(): EXTERNAL_DB path', function () {

        function setExtEnv() {
            const saved = {}
            const env = {
                XCHAIN_NODE_EXTERNAL_DB_HOST:          '127.0.0.1',
                XCHAIN_NODE_EXTERNAL_DB_PORT:          '3306',
                XCHAIN_NODE_EXTERNAL_DB_ROOT_USER:     'root',
                XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: 'test-pass'
            }
            for (const [k, v] of Object.entries(env)) {
                saved[k] = process.env[k]
                process.env[k] = v
            }
            return saved
        }

        function restoreEnv(saved) {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
        }

        it('creates database and user via native mariadb when EXTERNAL_DB=true', async function () {
            const stubs = makeStubs()
            // batch mode query returns '0' (db doesn't exist, user doesn't exist)
            stubs.mariadb._fakeConn.query.resolves([['0']])
            const saved = setExtEnv()
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass',
                    true  // inDocker=true but EXTERNAL_DB overrides
                )
                expect(result).to.be.true
                expect(stubs.mariadb.createConnection.called).to.be.true
            } finally {
                restoreEnv(saved)
            }
        })

        it('skips creates when db and user already exist (EXTERNAL_DB)', async function () {
            const stubs = makeStubs()
            // Return '1' for all COUNT queries (already exist) and full grant for SHOW GRANTS
            let queryCount = 0
            stubs.mariadb._fakeConn.query.callsFake((sql) => {
                queryCount++
                if (sql.includes('SELECT COUNT')) return Promise.resolve([['1']])
                if (sql.includes('SHOW GRANTS')) {
                    return Promise.resolve([["GRANT ALL PRIVILEGES ON 'XChain_BTC_Mainnet_Decoder'.* TO 'xchain_decoder_bitcoin_mainnet'@'%'"]])
                }
                return Promise.resolve([])
            })
            const saved = setExtEnv()
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass',
                    true
                )
                expect(result).to.be.true
            } finally {
                restoreEnv(saved)
            }
        })

        it('grants MVH permissions for hub module via native mariadb (EXTERNAL_DB)', async function () {
            const stubs = makeStubs()
            const queries = []
            stubs.mariadb._fakeConn.query.callsFake((sql) => {
                queries.push(sql)
                if (sql.includes('SELECT COUNT')) return Promise.resolve([['0']])
                if (sql.includes('SHOW GRANTS')) return Promise.resolve([['GRANT USAGE ON *.* TO user']])
                return Promise.resolve([])
            })
            const saved = setExtEnv()
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true, HUB_MODULE_NAME: 'xchain-hub' })
                await ds.addUserPasswordToDatabase(
                    'xchain-hub', 'bitcoin', 'mainnet',
                    'xchain_node', 'xchain_node_user', 'test-pass', true
                )
                const mvhQuery = queries.find(q => q && q.includes('MVH'))
                expect(mvhQuery).to.exist
            } finally {
                restoreEnv(saved)
            }
        })

        it('throws when native mariadb command fails (EXTERNAL_DB)', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.rejects(new Error('native query error'))
            const saved = setExtEnv()
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass', true
                )
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.equal('native query error')
            } finally {
                restoreEnv(saved)
            }
        })
    })

    // -------------------------------------------------------------------
    // resetDatabases
    // -------------------------------------------------------------------

    describe('resetDatabases()', function () {

        it('drops and recreates each database module', async function () {
            const stubs = makeStubs()
            const executed = []
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                executed.push(sql)
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            await ds.resetDatabases('bitcoin', 'mainnet')
            // Should have executed DROP + CREATE for decoder and indexer
            const dropCmds = executed.filter(c => c && c.includes('DROP DATABASE'))
            expect(dropCmds.length).to.be.greaterThan(0)
        })
    })

    // -------------------------------------------------------------------
    // setDatabaseParameters
    // -------------------------------------------------------------------

    describe('setDatabaseParameters()', function () {

        it('iterates installed coins+networks and adds DB users', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            stubs.spawn.callsFake(fakeSpawn((sql) => {
                if (sql.startsWith('SELECT COUNT')) return { stdout: '1\n' } // already exists
                if (sql.startsWith('SHOW GRANTS')) {
                    return { stdout: "GRANT ALL PRIVILEGES ON 'XChain_BTC_Mainnet_Decoder'.* TO 'xchain_decoder_bitcoin_mainnet'@'%'\nGRANT ALL PRIVILEGES ON 'XChain_BTC_Mainnet_Indexer'.* TO 'xchain_indexer_bitcoin_mainnet'@'%'\n" }
                }
                return { stdout: '' }
            }))
            const ds = loadDatabaseService(stubs)
            const result = await ds.setDatabaseParameters()
            expect(result).to.be.true
            expect(stubs.addContainerToNetwork.called).to.be.true
        })

        it('throws and logs when coin network processing fails', async function () {
            const stubs = makeStubs()
            stubs.addContainerToNetwork.rejects(new Error('network error'))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.setDatabaseParameters()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.equal('network error')
            }
        })

        // : this is the ONLY step that writes the freshly-minted decoder /
        // indexer password into MariaDB, and both callers run it right after a
        // buildAndUp. An empty iteration used to return true, so the caller's
        // throw-on-error guard never fired and the install reported success
        // while the new container crash-looped on ER_ACCESS_DENIED.
        it('refuses to run against an unconfigured module registry', async function () {
            const stubs = makeStubs()
            stubs.db.assertReady.throws(new Error('MariaDbStore is not connected'))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.setDatabaseParameters()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.match(/not connected/)
            }
            expect(stubs.addContainerToNetwork.called).to.be.false
        })

        it('throws instead of reporting success when no coin/network is installed', async function () {
            const stubs = makeStubs()
            stubs.getInstalledCoinsAndNetworks.resolves({})
            const ds = loadDatabaseService(stubs)
            try {
                await ds.setDatabaseParameters()
                expect.fail('an empty iteration must not read as success')
            } catch (err) {
                expect(err.message).to.match(/no installed coin\/network/)
            }
        })

        it('throws when the registry lists a coin but holds no decoder/indexer container', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ds = loadDatabaseService(stubs)
            try {
                await ds.setDatabaseParameters()
                expect.fail('provisioning zero accounts must not read as success')
            } catch (err) {
                expect(err.message).to.match(/provisioned no MariaDB account/)
                expect(err.message).to.match(/bitcoin/)
            }
        })
    })

    // -------------------------------------------------------------------
    // buildDatabaseModule: EXTERNAL_DB path
    // -------------------------------------------------------------------

    describe('buildDatabaseModule(): EXTERNAL_DB path', function () {

        it('pings external MariaDB and returns true when reachable', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([])
            const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true, EXTERNAL_DB_HOST: '127.0.0.1', EXTERNAL_DB_PORT: 3306, EXTERNAL_DB_ROOT_USER: 'root' })

            // getExternalDbConfig will use env vars
            const saved = {
                XCHAIN_NODE_EXTERNAL_DB_HOST:          process.env.XCHAIN_NODE_EXTERNAL_DB_HOST,
                XCHAIN_NODE_EXTERNAL_DB_PORT:          process.env.XCHAIN_NODE_EXTERNAL_DB_PORT,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_USER:     process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD
            }
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = '127.0.0.1'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = '3306'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'root'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'test-pass'
            try {
                const result = await ds.buildDatabaseModule('bitcoin', 'mainnet')
                expect(result).to.be.true
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })

        it('throws descriptive error when external MariaDB is unreachable', async function () {
            const stubs = makeStubs()
            stubs.mariadb.createConnection.rejects(new Error('ECONNREFUSED'))
            const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true, EXTERNAL_DB_HOST: 'bad-host', EXTERNAL_DB_PORT: 3306, EXTERNAL_DB_ROOT_USER: 'root' })

            const saved = {
                XCHAIN_NODE_EXTERNAL_DB_HOST:          process.env.XCHAIN_NODE_EXTERNAL_DB_HOST,
                XCHAIN_NODE_EXTERNAL_DB_PORT:          process.env.XCHAIN_NODE_EXTERNAL_DB_PORT,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_USER:     process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD
            }
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = 'bad-host'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = '3306'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'root'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'test-pass'
            try {
                await ds.buildDatabaseModule('bitcoin', 'mainnet')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Cannot reach external MariaDB')
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })
    })

    // -------------------------------------------------------------------
    // buildDatabaseModule: existing container, no coin/network
    // -------------------------------------------------------------------

    describe('buildDatabaseModule(): no coin/network', function () {

        it('returns true without network join when coin+network are empty', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            // Pass empty coin/network so the addContainerToNetwork branch is skipped
            const result = await ds.buildDatabaseModule('', '')
            expect(result).to.be.true
            expect(stubs.addContainerToNetwork.called).to.be.false
        })

        it('throws string error when addContainerToNetwork fails on existing container', async function () {
            const stubs = makeStubs()
            stubs.addContainerToNetwork.rejects(new Error('network unavailable'))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.buildDatabaseModule('bitcoin', 'mainnet')
                expect.fail('should have thrown')
            } catch (err) {
                // Source throws a plain string, not an Error object
                expect(err).to.include('There was a problem trying to add the db container to the network')
            }
        })

        it('appends DB data dir volume mount when XCHAIN_NODE_DB_DATA_DIR is set', async function () {
            const saved = process.env.XCHAIN_NODE_DB_DATA_DIR
            process.env.XCHAIN_NODE_DB_DATA_DIR = '/mnt/nvme/mysql'
            try {
                const stubs = makeStubs()
                stubs.execFileAsync
                    .onFirstCall().rejects(new Error('No such container')) // getDatabaseContainerId
                    .resolves({ stdout: VALID_CONTAINER_ID + '\n' })
                const ds = loadDatabaseService(stubs)
                await ds.buildDatabaseModule('bitcoin', 'mainnet')

                const runCall = stubs.execFileAsync.getCalls().find(c =>
                    c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
                expect(runCall, 'docker run call not found').to.exist
                const args = runCall.args[1]
                const vIdx = args.indexOf('-v')
                expect(vIdx).to.be.greaterThan(-1)
                expect(args[vIdx + 1]).to.equal('/mnt/nvme/mysql:/var/lib/mysql')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_DATA_DIR
                else process.env.XCHAIN_NODE_DB_DATA_DIR = saved
            }
        })
    })

    // -------------------------------------------------------------------
    // ensureDatabasePool
    // -------------------------------------------------------------------

    describe('ensureDatabasePool()', function () {

        it('is a no-op when db is already ready', async function () {
            const stubs = makeStubs()
            stubs.db.isReady.returns(true)
            const ds = loadDatabaseService(stubs)
            await ds.ensureDatabasePool()
            expect(stubs.db.createDatabase.called).to.be.false
        })

        it('creates database pool when not ready (docker path)', async function () {
            const stubs = makeStubs()
            stubs.db.isReady.returns(false)
            stubs.hasCredentials.returns(true)
            stubs.loadCredentials.returns({ user: 'testuser', password: 'test-pass', database: 'xchain_node' })
            // execFileAsync calls: inspect (checkIfDatabaseIsReady for existing creds),
            // then docker port (getDatabaseHostPort)
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // inspect in getDatabaseContainerId
                .onCall(1).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // inspect in checkIfDatabaseIsReady
                .onCall(2).resolves({ stdout: 'OK' })                        // mariadb SELECT 1 → ready
                .resolves({ stdout: '0.0.0.0:13306\n' })                    // docker port
            const ds = loadDatabaseService(stubs)
            await ds.ensureDatabasePool()
            expect(stubs.db.createDatabase.calledOnce).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // ensureXchainNodeAccess: EXTERNAL_DB path
    // -------------------------------------------------------------------

    describe('ensureXchainNodeAccess(): EXTERNAL_DB path', function () {

        function extEnv() {
            return {
                XCHAIN_NODE_EXTERNAL_DB_HOST:          'db.example.com',
                XCHAIN_NODE_EXTERNAL_DB_PORT:          '3306',
                XCHAIN_NODE_EXTERNAL_DB_ROOT_USER:     'root',
                XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: 'test-pass'
            }
        }

        function setExtEnv(env) {
            const saved = {}
            for (const [k, v] of Object.entries(env)) {
                saved[k] = process.env[k]
                process.env[k] = v
            }
            return saved
        }

        function restoreEnv(saved) {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
        }

        it('returns existing creds when they work against external MariaDB', async function () {
            const existing = { user: 'xchain_node_testuser', password: 'test-pass', database: 'xchain_node' }
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(true),
                loadCredentials: sinon.stub().returns(existing)
            })
            stubs.mariadb._fakeConn.query.resolves([])
            const saved = setExtEnv(extEnv())
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.ensureXchainNodeAccess()
                expect(result).to.deep.equal(existing)
                expect(stubs.saveCredentials.called).to.be.false
            } finally {
                restoreEnv(saved)
            }
        })

        it('reprovisions via native commands when existing creds fail on external MariaDB', async function () {
            const existing = { user: 'xchain_node_testuser', password: 'old-pass', database: 'xchain_node' }
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(true),
                loadCredentials: sinon.stub().returns(existing)
            })
            // getExternalDbConfig uses env vars path (no mariadb connection opened).
            // ensureXchainNodeAccess tries mariadb.createConnection for existing.user check -> fails.
            // executeNativeMariaDbCommand DDL calls -> succeed.
            let connCallCount = 0
            stubs.mariadb.createConnection.callsFake(() => {
                connCallCount++
                if (connCallCount === 1) return Promise.reject(new Error('auth failed')) // existing creds check
                return Promise.resolve(stubs.mariadb._fakeConn)                          // DDL commands
            })
            stubs.mariadb._fakeConn.query.resolves([])
            const saved = setExtEnv(extEnv())
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.ensureXchainNodeAccess()
                expect(stubs.saveCredentials.called).to.be.true
                expect(result.user).to.equal('xchain_node_testuser')
                expect(result.database).to.equal('xchain_node')
            } finally {
                restoreEnv(saved)
            }
        })

        it('provisions fresh creds when no existing credentials stored', async function () {
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(false)
            })
            stubs.mariadb._fakeConn.query.resolves([])
            const saved = setExtEnv(extEnv())
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.ensureXchainNodeAccess()
                expect(result.user).to.equal('xchain_node_testuser')
                expect(result.password).to.equal('test-generated-pass')
                expect(stubs.saveCredentials.calledOnce).to.be.true
            } finally {
                restoreEnv(saved)
            }
        })
    })

    // -------------------------------------------------------------------
    // ensureXchainNodeAccess: docker path
    // -------------------------------------------------------------------

    describe('ensureXchainNodeAccess()', function () {

        it('returns existing working credentials without reprovisioning', async function () {
            const existing = { user: 'xchain_node_testuser', password: 'test-pass', database: 'xchain_node' }
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(true),
                loadCredentials: sinon.stub().returns(existing)
            })
            // checkIfDatabaseIsReady for existing creds returns true
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // inspect (in getDatabaseContainerId)
                .onCall(1).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // inspect again
                .resolves({ stdout: 'OK' })                                  // mariadb responds
            const ds = loadDatabaseService(stubs)
            const result = await ds.ensureXchainNodeAccess()
            expect(result).to.deep.equal(existing)
            expect(stubs.saveCredentials.called).to.be.false
        })

        it('reprovisions when stored credentials no longer work', async function () {
            const existing = { user: 'xchain_node_testuser', password: 'old-pass', database: 'xchain_node' }
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(true),
                loadCredentials: sinon.stub().returns(existing)
            })
            // Flow:
            //   1. getDatabaseContainerId (call 0) -> valid container ID
            //   2. checkIfDatabaseIsReady(existing.user, existing.password, ...) ->
            //      getDatabaseContainerId (call 1) -> valid ID, then mariadb SELECT fails (calls 2-11)
            //   3. askMariadbRootPassword returns the CACHED password (this test
            //      never overrides getDbRootPassword, so it stays the makeStubs()
            //      default 'rootpass') and returns before reaching env-var /
            //      ping-verification logic (uuid:2c5ec698) -> no extra exec calls
            //   4. checkIfDatabaseIsReady("root", rootPassword) ->
            //      getDatabaseContainerId (call 12) -> valid ID, then mariadb SELECT succeeds (call 13)
            //   5. DDL via executeDockerMariaDbCommand (execFile callback style)
            let callCount = 0
            stubs.execFileAsync.callsFake((cmd, args) => {
                callCount++
                // Inspect calls (docker inspect) → always succeed
                if (Array.isArray(args) && args.includes('inspect')) {
                    return Promise.resolve({ stdout: VALID_CONTAINER_ID + '\n' })
                }
                // After 12+ calls, let root mariadb check pass (call 13)
                if (callCount > 12) {
                    return Promise.resolve({ stdout: 'OK' })
                }
                // Existing-creds mariadb checks fail
                return Promise.reject(new Error('auth failed'))
            })
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'root-pass'
            try {
                stubs.spawn.callsFake(fakeSpawn(() => ({ stdout: '' })))
                const ds = loadDatabaseService(stubs)
                const result = await ds.ensureXchainNodeAccess()
                expect(stubs.saveCredentials.called).to.be.true
                expect(result.user).to.equal('xchain_node_testuser')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })

        it('throws when container not found and no credentials', async function () {
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(false)
            })
            stubs.execFileAsync.rejects(new Error('no container'))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.ensureXchainNodeAccess()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('MariaDB container not found')
            }
        })

        it('throws "MariaDB is not responding" when root checkIfDatabaseIsReady returns false', async function () {
            // Force: no existing creds, container found, but root mariadb check fails all retries
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(false)
            })
            // getDatabaseContainerId (inspect) → valid, then all mariadb checks fail → ready=false
            stubs.execFileAsync.callsFake((cmd, args) => {
                if (Array.isArray(args) && args.includes('inspect')) {
                    return Promise.resolve({ stdout: VALID_CONTAINER_ID + '\n' })
                }
                return Promise.reject(new Error('mariadb not responding'))
            })
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'root-pass'
            try {
                const ds = loadDatabaseService(stubs)
                await ds.ensureXchainNodeAccess()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('MariaDB is not responding')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })
    })
})
