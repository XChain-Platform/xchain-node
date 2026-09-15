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

const {
    sinon, configStub, expect, proxyquire, modulesUrls, XChainService,
    DEFAULT_NODE_PREFIX, DEPENDENCY_HEALTH_START_PERIOD, makeStubs,
    loadModuleService, stubDockerCreate, runArgsOf, inspectMemoryBytes,
    captureConsole, proxyquireCallThru, moduleSuite
} = require('./support/helpers')

moduleSuite('buildAndUp(): module-specific port/volume branches', function () {it('rejects when container ID returned is not a valid 64-char hex', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { cb(null, 'bad-id\n') }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })

        it('rejects when setModuleContainer returns false', async function () {
            const stubs = makeStubs()
            stubs.db.setModuleContainer.resolves(false)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { cb(null, 'a'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('problem trying to store')
            }
        })

        it('skips db insert for onlyExecution=true and resolves containerId directly', async function () {
            const stubs = makeStubs()
            const containerId = 'c'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { cb(null, containerId + '\n') }
            })
            const ms = loadModuleService(stubs)
            const result = await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)
            expect(result).to.equal(containerId)
            expect(stubs.db.setModuleContainer.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // containerExistsByName (via installModule singleton path with remoteUpdate=true)
    // -------------------------------------------------------------------
moduleSuite('containerExistsByName() via installModule', function () {
        // A full singleton installModule takes 1.2-1.5s on a CI runner (measured
        // 2026-09-08 at two consecutive commits), which sits under the 2s gate
        // timeout only while the runner is idle; three concurrent gate runs
        // pushed it over. The budget states what the path costs, not a hope.
        this.timeout(10000)

        it('rebuilds singleton when remoteUpdate=true even if container exists', async function () {
            const stubs = makeStubs()
            const containerId = 'e'.repeat(64)
            // inspect → container exists, but remoteUpdate=true bypasses singleton guard
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (cmd === 'docker' && args[0] === 'inspect') { cb(null, { stdout: containerId + '\n' }) }
                else if (cmd === 'git') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            const result = await ms.installModule('xchain-hub', null, null, true)
            // remoteUpdate=true → should call git clone and return container ID
            expect(stubs.execFile.getCalls().some(c => c.args[0] === 'git')).to.be.true
            expect(result).to.equal(containerId)
        })
    })

    // -------------------------------------------------------------------
    // getModuleBranch
    // -------------------------------------------------------------------
    // -------------------------------------------------------------------
    // installModule: BootstrapService lazy-require paths (utxo-tracker / decoder fresh)
    // -------------------------------------------------------------------
moduleSuite('installModule(): bootstrap paths via @global proxyquire', function () {

        it('calls ensureBootstrapUtxoTracker when utxo-tracker volume was fresh', async function () {
            const sinon3 = require('sinon')
            const ensureBootstrapUtxoTrackerStub = sinon3.stub().resolves()
            const utxoTrackerVolumeFreshnessStub = sinon3.stub().resolves('empty') // confirmed empty = fresh
            const containerId = 'f'.repeat(64)
            const execFileStub = sinon3.stub()
            execFileStub.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (cmd === 'git') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            const configStub = {
                getModuleDir: (mod) => '/modules/' + mod, getModuleTmpDir: (mod) => '/tmp/' + mod,
                moduleDirExists: sinon3.stub().returns(false), checkIfModuleExists: sinon3.stub().returns(true),
                removeModuleDir: sinon3.stub(), removeModuleTmpDir: sinon3.stub(),
                createModuleTmpDir: sinon3.stub(),
                getDockerContainerImageName: (mod, coin, net) => `${coin}-${net}-${mod}`,
                getDockerNetwork: (coin, net) => `net-${coin}-${net}`,
                validatePort: () => true,
                getDefaultConfig: sinon3.stub().resolves({
                    UTXO_TRACKER_PORT: 3001, UTXO_TRACKER_API_PORT: 3001,
                    UTXO_TRACKER_BOOTSTRAP_VOLUME: '/bootstrap'
                })
            }
            const ms = proxyquireCallThru('../../../src/services/module_service', {
                'child_process': { execFile: execFileStub },
                // renameSync must be stubbed under a call-through load: cloneGit's
                // rewrite path stages the clone and swaps it in, and a
                // call-through would rename real paths on the test host.
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub(), renameSync: sinon3.stub() },
                '../state': {
                    db: { setModuleContainer: sinon3.stub().resolves(true), getModuleContainer: sinon3.stub().resolves(null), deleteModuleContainer: sinon3.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}), getLastStatus: () => null
                },
                './config_service': configStub,
                './status_service': { statusChanged: sinon3.stub().resolves(), getStatus: sinon3.stub().resolves({}) },
                './docker_service': { killContainer: sinon3.stub().resolves(true), removeContainer: sinon3.stub().resolves(true), forceRemoveContainerByName: sinon3.stub().resolves(true), getPublishedHostPorts: sinon3.stub().resolves(new Map()), checkBuildKitAvailable: sinon3.stub().resolves(true) },
                './database_service': { setDatabaseParameters: sinon3.stub().resolves(), setHubDatabaseParameters: sinon3.stub().resolves() },
                './bootstrap_service': {
                    utxoTrackerVolumeFreshness: utxoTrackerVolumeFreshnessStub,
                    FRESHNESS_EMPTY: 'empty',
                    ensureBootstrapUtxoTracker: ensureBootstrapUtxoTrackerStub,
                    mariaDbModuleFreshness: sinon3.stub().resolves('populated'),
                    ensureBootstrapMariaDb: sinon3.stub().resolves()
                },
                './version_service': { getLocalNodeVersion: sinon3.stub().resolves(null), getLocalModuleVersion: sinon3.stub().resolves(null), checkRemoteNodeVersion: sinon3.stub().resolves() },
                './node_service': { buildCryptoNode: sinon3.stub().resolves(true), getCryptoNode: sinon3.stub().resolves() },
                './explorer_service': { installExplorerModule: sinon3.stub().resolves(true) }
            })
            const result = await ms.installModule('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
            expect(utxoTrackerVolumeFreshnessStub.calledOnce).to.be.true
            expect(ensureBootstrapUtxoTrackerStub.calledOnce).to.be.true
            expect(result).to.equal(containerId)
        })

        })

moduleSuite('installModule(): bootstrap paths via @global proxyquire', function () {it('calls ensureBootstrapMariaDb when decoder DB was fresh', async function () {
            const sinon3 = require('sinon')
            const ensureBootstrapMariaDbStub = sinon3.stub().resolves()
            const mariaDbModuleFreshnessStub = sinon3.stub().resolves('empty') // confirmed empty = fresh
            const setDatabaseParametersStub = sinon3.stub().resolves()
            const containerId = 'a'.repeat(64)
            const execFileStub = sinon3.stub()
            execFileStub.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (cmd === 'git') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            const configStub = {
                getModuleDir: (mod) => '/modules/' + mod, getModuleTmpDir: (mod) => '/tmp/' + mod,
                moduleDirExists: sinon3.stub().returns(false), checkIfModuleExists: sinon3.stub().returns(true),
                removeModuleDir: sinon3.stub(), removeModuleTmpDir: sinon3.stub(),
                createModuleTmpDir: sinon3.stub(),
                getDockerContainerImageName: (mod, coin, net) => `${coin}-${net}-${mod}`,
                getDockerNetwork: (coin, net) => `net-${coin}-${net}`,
                validatePort: () => true,
                getDefaultConfig: sinon3.stub().resolves({ DECODER_PORT: 3002, DECODER_API_PORT: 3002, DECODER_BOOTSTRAP_VOLUME: '/bootstrap' })
            }
            const ms = proxyquireCallThru('../../../src/services/module_service', {
                'child_process': { execFile: execFileStub },
                // renameSync must be stubbed under a call-through load: cloneGit's
                // rewrite path stages the clone and swaps it in, and a
                // call-through would rename real paths on the test host.
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub(), renameSync: sinon3.stub() },
                '../state': {
                    db: { setModuleContainer: sinon3.stub().resolves(true), getModuleContainer: sinon3.stub().resolves(null), deleteModuleContainer: sinon3.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}), getLastStatus: () => null
                },
                './config_service': configStub,
                './status_service': { statusChanged: sinon3.stub().resolves(), getStatus: sinon3.stub().resolves({}) },
                './docker_service': { killContainer: sinon3.stub().resolves(true), removeContainer: sinon3.stub().resolves(true), forceRemoveContainerByName: sinon3.stub().resolves(true), getPublishedHostPorts: sinon3.stub().resolves(new Map()), checkBuildKitAvailable: sinon3.stub().resolves(true) },
                './database_service': { setDatabaseParameters: setDatabaseParametersStub },
                // Stubbed for the same reason DockerService.getPublishedHostPorts is:
                // the real guard shells out to `docker inspect` and would read
                // whatever containers the venue happens to be running.
                './db_credential_drift': { assertNoDbCredentialDrift: sinon3.stub().resolves([]) },
                './bootstrap_service': {
                    utxoTrackerVolumeFreshness: sinon3.stub().resolves('populated'),
                    FRESHNESS_EMPTY: 'empty',
                    ensureBootstrapUtxoTracker: sinon3.stub().resolves(),
                    mariaDbModuleFreshness: mariaDbModuleFreshnessStub,
                    ensureBootstrapMariaDb: ensureBootstrapMariaDbStub
                },
                './version_service': { getLocalNodeVersion: sinon3.stub().resolves(null), getLocalModuleVersion: sinon3.stub().resolves(null), checkRemoteNodeVersion: sinon3.stub().resolves() },
                './node_service': { buildCryptoNode: sinon3.stub().resolves(true), getCryptoNode: sinon3.stub().resolves() },
                './explorer_service': { installExplorerModule: sinon3.stub().resolves(true) }
            })
            const result = await ms.installModule('xchain-decoder', 'bitcoin', 'mainnet', true)
            expect(mariaDbModuleFreshnessStub.calledOnce).to.be.true
            expect(setDatabaseParametersStub.calledOnce).to.be.true
            expect(ensureBootstrapMariaDbStub.calledOnce).to.be.true
            expect(result).to.equal(containerId)
        }) })
        // uuid:7037604f: ensureBootstrapMariaDb reaches DROP DATABASE, so only a
        // CONFIRMED empty store may authorise it. An inspection failure during a
        // rolling update answers unknown, which must leave a populated store
        // untouched.

moduleSuite('installModule(): bootstrap paths via @global proxyquire', function () {it('does NOT call ensureBootstrapMariaDb when the decoder DB freshness is unknown', async function () {
            const sinon3 = require('sinon')
            const ensureBootstrapMariaDbStub = sinon3.stub().resolves()
            const mariaDbModuleFreshnessStub = sinon3.stub().resolves('unknown')
            const containerId = 'a'.repeat(64)
            const execFileStub = sinon3.stub()
            execFileStub.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (cmd === 'git') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            const configStub = {
                getModuleDir: (mod) => '/modules/' + mod,
                getModuleTmpDir: (mod) => '/tmp/' + mod,
                moduleDirExists: sinon3.stub().returns(false),
                checkIfModuleExists: sinon3.stub().returns(true),
                removeModuleDir: sinon3.stub(),
                removeModuleTmpDir: sinon3.stub(),
                createModuleTmpDir: sinon3.stub(),
                getDockerContainerImageName: (mod, coin, net) => `${coin}-${net}-${mod}`,
                getDockerNetwork: (coin, net) => `net-${coin}-${net}`,
                validatePort: () => true,
                getDefaultConfig: sinon3.stub().resolves({
                    DECODER_PORT: 3002, DECODER_API_PORT: 3002,
                    DECODER_BOOTSTRAP_VOLUME: '/bootstrap'
                })
            }
            const ms = proxyquireCallThru('../../../src/services/module_service', {
                'child_process': { execFile: execFileStub },
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub(), renameSync: sinon3.stub() },
                '../state': {
                    db: { setModuleContainer: sinon3.stub().resolves(true), getModuleContainer: sinon3.stub().resolves(null), deleteModuleContainer: sinon3.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './config_service': configStub,
                './status_service': { statusChanged: sinon3.stub().resolves(), getStatus: sinon3.stub().resolves({}) },
                './docker_service': { killContainer: sinon3.stub().resolves(true), removeContainer: sinon3.stub().resolves(true), forceRemoveContainerByName: sinon3.stub().resolves(true), getPublishedHostPorts: sinon3.stub().resolves(new Map()), checkBuildKitAvailable: sinon3.stub().resolves(true) },
                './database_service': { setDatabaseParameters: sinon3.stub().resolves() },
                './db_credential_drift': { assertNoDbCredentialDrift: sinon3.stub().resolves([]) },
                './bootstrap_service': {
                    utxoTrackerVolumeFreshness: sinon3.stub().resolves('populated'),
                    FRESHNESS_EMPTY: 'empty',
                    ensureBootstrapUtxoTracker: sinon3.stub().resolves(),
                    mariaDbModuleFreshness: mariaDbModuleFreshnessStub,
                    ensureBootstrapMariaDb: ensureBootstrapMariaDbStub,
                    forceBootstrapRequested: () => false
                },
                './version_service': { getLocalNodeVersion: sinon3.stub().resolves(null), getLocalModuleVersion: sinon3.stub().resolves(null), checkRemoteNodeVersion: sinon3.stub().resolves() },
                './node_service': { buildCryptoNode: sinon3.stub().resolves(true), getCryptoNode: sinon3.stub().resolves() },
                './explorer_service': { installExplorerModule: sinon3.stub().resolves(true) }
            })
            const result = await ms.installModule('xchain-decoder', 'bitcoin', 'mainnet', true)
            expect(mariaDbModuleFreshnessStub.calledOnce).to.be.true
            expect(ensureBootstrapMariaDbStub.called).to.be.false
            expect(result).to.equal(containerId)
        }) })

        // uuid:cb0bd3be: the drift guard belongs before buildAndUp kills and
        // replaces the container. A refusal must leave the working decoder intact
        // and able to authenticate with MariaDB.

moduleSuite('installModule(): bootstrap paths via @global proxyquire', function () {it('refuses a drifting decoder update before tearing the container down', async function () {
            const sinon3 = require('sinon'), driftError = new Error('Refusing to rotate the bitcoin mainnet MariaDB accounts')
            driftError.code = 'DB_CREDENTIAL_DRIFT'
            const assertNoDbCredentialDriftStub = sinon3.stub().rejects(driftError), setDatabaseParametersStub = sinon3.stub().resolves()
            const killContainerStub = sinon3.stub().resolves(true), removeContainerStub = sinon3.stub().resolves(true), forceRemoveContainerByNameStub = sinon3.stub().resolves(true)
            const cloneExecFileStub = sinon3.stub()
            cloneExecFileStub.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, '')
            })
            const configStub = {
                getModuleDir: (mod) => '/modules/' + mod, getModuleTmpDir: (mod) => '/tmp/' + mod,
                moduleDirExists: sinon3.stub().returns(false), checkIfModuleExists: sinon3.stub().returns(true),
                removeModuleDir: sinon3.stub(), removeModuleTmpDir: sinon3.stub(),
                createModuleTmpDir: sinon3.stub(), getDockerContainerImageName: (mod, coin, net) => `${coin}-${net}-${mod}`,
                getDockerNetwork: (coin, net) => `net-${coin}-${net}`,
                validatePort: () => true,
                getDefaultConfig: sinon3.stub().resolves({ DECODER_PORT: 3002, DECODER_API_PORT: 3002, DECODER_DB_PASS: 'rotated-decoder-pass', INDEXER_DB_PASS: 'indexer-pass' })
            }
            const ms = proxyquireCallThru('../../../src/services/module_service', {
                'child_process': { execFile: cloneExecFileStub },
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub(), renameSync: sinon3.stub() },
                '../state': {
                    db: { setModuleContainer: sinon3.stub().resolves(true), getModuleContainer: sinon3.stub().resolves(null), deleteModuleContainer: sinon3.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}), getLastStatus: () => null
                },
                './config_service': configStub,
                './status_service': { statusChanged: sinon3.stub().resolves(), getStatus: sinon3.stub().resolves({}) },
                './docker_service': { killContainer: killContainerStub, removeContainer: removeContainerStub, forceRemoveContainerByName: forceRemoveContainerByNameStub, getPublishedHostPorts: sinon3.stub().resolves(new Map()), checkBuildKitAvailable: sinon3.stub().resolves(true) },
                './database_service': { setDatabaseParameters: setDatabaseParametersStub, setHubDatabaseParameters: sinon3.stub().resolves() },
                './db_credential_drift': { assertNoDbCredentialDrift: assertNoDbCredentialDriftStub },
                './bootstrap_service': {
                    utxoTrackerVolumeFreshness: sinon3.stub().resolves('populated'), FRESHNESS_EMPTY: 'empty',
                    ensureBootstrapUtxoTracker: sinon3.stub().resolves(), mariaDbModuleFreshness: sinon3.stub().resolves('populated'),
                    ensureBootstrapMariaDb: sinon3.stub().resolves()
                },
                './version_service': { getLocalNodeVersion: sinon3.stub().resolves(null), getLocalModuleVersion: sinon3.stub().resolves(null), checkRemoteNodeVersion: sinon3.stub().resolves() },
                './node_service': { buildCryptoNode: sinon3.stub().resolves(true), getCryptoNode: sinon3.stub().resolves() },
                './explorer_service': { installExplorerModule: sinon3.stub().resolves(true) }
            })

            let thrown = null
            try { await ms.installModule('xchain-decoder', 'bitcoin', 'mainnet', true, 'old-container-id') }
            catch (err) { thrown = err }

            expect(thrown).to.not.equal(null)
            expect(thrown.code).to.equal('DB_CREDENTIAL_DRIFT')
            expect(assertNoDbCredentialDriftStub.calledOnce).to.be.true
            // The container under rebuild is excluded, or the guard would refuse the
            // very rebuild that clears its own stale password.
            expect(assertNoDbCredentialDriftStub.firstCall.args[3])
                .to.deep.equal({ excludeModules: ['xchain-decoder'] })
            // Nothing was torn down, re-cloned, or provisioned: the refusal is
            // worth having only if it leaves the working stack running.
            expect(killContainerStub.called).to.be.false
            expect(removeContainerStub.called).to.be.false
            expect(forceRemoveContainerByNameStub.called).to.be.false
            expect(setDatabaseParametersStub.called).to.be.false
            expect(cloneExecFileStub.called).to.be.false
        }) })
