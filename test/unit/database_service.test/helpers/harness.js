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
const { configStub } = require('../../../helpers/config_stub')

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

// The `docker exec ... mariadb -u <user> -e 'SELECT 1'` attempts a readiness or
// credential probe actually made, filtered out of the docker inspect / port /
// run traffic that shares the same execFileAsync stub. Pass `user` to count the
// attempts made as ONE account when a flow probes with two.
function mariadbAttempts(stubs, user = null) {
    return stubs.execFileAsync.getCalls().filter((c) => {
        const args = c.args[1]
        if (!Array.isArray(args) || !args.includes('mariadb')) return false
        if (!user) return true
        return args[args.indexOf('-u') + 1] === user
    })
}

function makeStubs(overrides = {}) {
    // execFileAsync is what the source uses (via promisify(execFile)) for all
    // docker inspect / docker port / docker pull / docker run calls.
    // Default: return a valid 64-char hex container ID (simulates a running DB
    // container found via `docker inspect`).
    const execFileAsync = sinon.stub().resolves({ stdout: VALID_CONTAINER_ID + '\n' })

    // Fake mariadb connection used in executeNativeMariaDbCommand / pingMariaDb
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
            setModuleContainer: sinon.stub().resolves(true)
        },
        getInstalledCoinsAndNetworks: sinon.stub().resolves({ bitcoin: ['mainnet'] }),
        getDbRootPassword: sinon.stub().returns('rootpass'),
        setDbRootPassword: sinon.stub(),
        statusChanged: sinon.stub().resolves(),
        getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } }),
        forceRemoveContainerByName: sinon.stub().resolves(true),
        // Default 'gone': docker positively reports the DB container absent, the
        // only state the install branch is allowed to force-remove from.
        probeContainerPresenceByName: sinon.stub().resolves('gone'),
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
        assertNoDbCredentialDrift: sinon.stub().resolves([]),
        ...overrides
    }
}

// configValues merges into the getDefaultConfig() result, for tests that need a
// key the shared default does not carry (e.g. HUB_DB_NAME).
// configServiceOverrides replaces individual ConfigService exports (getModuleDatabaseName
// for the identifier-allowlist cases), applied last so it wins over the defaults below.
function makeDefaultConstants(constants) {
    // Built from the REAL config home, not from nothing: this stub is
    // noCallThru, and every environment name it does not carry would read
    // undefined inside the service under test.
    return configStub({
        DB_MODULE_NAME: 'database',
        HUB_MODULE_NAME: 'xchain-hub',
        XChainService: {
            XCHAIN_DECODER: 'xchain-decoder',
            XCHAIN_INDEXER: 'xchain-indexer'
        },
        SEP: '-',
        CoinTickerSymbol: { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' },
        EXTERNAL_DB: false,
        EXTERNAL_DB_HOST: '127.0.0.1',
        EXTERNAL_DB_PORT: 3306,
        EXTERNAL_DB_ROOT_USER: 'root',
        // The DB container's own --health-start-period, shared with the hub and
        // explorer healthcheck descriptors whose probes SELECT 1 against it. Read
        // from the real module rather than restated here: this stub is noCallThru,
        // so a name missing from it reaches buildDatabaseModule as undefined and
        // lands in the docker run args as an undefined element.
        DEPENDENCY_HEALTH_START_PERIOD: require('../../../../src/config').DEPENDENCY_HEALTH_START_PERIOD,
        ...constants
    })
}

function makeConfigService(configValues, configServiceOverrides) {
    return {
        getDefaultConfig: sinon.stub().resolves({
            'DB_PORT': 3306,
            'HUB_PORT': 10000,
            'DECODER_DB_NAME': 'XChain_BTC_Mainnet_Decoder',
            'DECODER_DB_USER': 'xchain_decoder_bitcoin_mainnet',
            'DECODER_DB_PASS': 'test-pass',
            'INDEXER_DB_NAME': 'XChain_BTC_Mainnet_Indexer',
            'INDEXER_DB_USER': 'xchain_indexer_bitcoin_mainnet',
            'INDEXER_DB_PASS': 'test-pass',
            ...configValues
        }),
        getDockerContainerImageName: (mod) => 'xchain-node-' + mod,
        getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
        getModuleDatabaseName: (mod, coin, net) => 'XChain_BTC_Mainnet_Decoder',
        validatePort: require('../../../../src/services/config_service').validatePort,
        ...configServiceOverrides
    }
}

function makeCoreStubs(stubs, defaultConstants, configService) {
    return {
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
        // sleep is stubbed to keep the suite fast; redactSecrets is passed through
        // real so what the assertions see is the text an operator would see.
        '../utils/helpers': {
            sleep: sinon.stub().resolves(),
            redactSecrets: require('../../../../src/utils/helpers').redactSecrets
        },
        '../config/index': defaultConstants,
        './config_service': configService
    }
}

function makeOperationalStubs(stubs) {
    return {
        './docker_service': {
            getStatusFromContainer: stubs.getStatusFromContainer,
            getDockerNetworkInspect: stubs.getDockerNetworkInspect,
            addContainerToNetwork: stubs.addContainerToNetwork,
            forceRemoveContainerByName: stubs.forceRemoveContainerByName,
            probeContainerPresenceByName: stubs.probeContainerPresenceByName
        },
        // buildDatabaseModule lazy-requires this for the multi-stack host-port
        // pre-flight; stub it so the install branch doesn't load the real
        // (LevelDB-backed) ModuleService. Default: no conflict (resolves).
        './module_service': {
            assertNoHostPortConflicts: stubs.assertNoHostPortConflicts
        },
        './status_service': {
            statusChanged: stubs.statusChanged,
            getInstalledCoinsAndNetworks: stubs.getInstalledCoinsAndNetworks
        },
        // setDatabaseParameters refuses to rotate when a running container carries a
        // different password. Stub it clean by default so the provisioning
        // tests stay about provisioning; DbCredentialDrift.test.js owns the guard, and
        // the drift-refusal case below overrides this stub.
        './db_credential_drift': {
            assertNoDbCredentialDrift: stubs.assertNoDbCredentialDrift,
            isDbCredentialDriftError: (err) => !!err && err.code === 'DB_CREDENTIAL_DRIFT'
        },
        './credentials_service': {
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
    }
}

function loadDatabaseService(stubs, constants = {}, configValues = {}, configServiceOverrides = {}) {
    const defaultConstants = makeDefaultConstants(constants)
    const configService = makeConfigService(configValues, configServiceOverrides)
    return proxyquire('../../../../src/services/database_service', {
        ...makeCoreStubs(stubs, defaultConstants, configService),
        ...makeOperationalStubs(stubs)
    })
}

module.exports = {
    sinon,
    expect,
    VALID_CONTAINER_ID,
    fakeSpawn,
    mariadbAttempts,
    makeStubs,
    loadDatabaseService
}
