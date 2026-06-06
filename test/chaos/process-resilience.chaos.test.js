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

function makeStubs() {
    return {
        execFile: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub()
        }
    }
}

function loadModuleService(stubs, opts = {}) {
    return proxyquire('../../src/services/ModuleService', {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs || {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub()
        },
        '../state': {
            db: opts.db || {
                insertModuleContainer: sinon.stub().resolves(true),
                getModuleContainer: sinon.stub().resolves(null),
                removeModuleContainer: sinon.stub().resolves(true)
            },
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './ConfigService': {
            getModuleDir: (mod) => '/modules/' + mod,
            getModuleTmpDir: (mod) => '/tmp/' + mod,
            moduleDirExists: sinon.stub().returns(false),
            checkIfModuleExists: sinon.stub().returns(true),
            removeModuleDir: sinon.stub(),
            removeModuleTmpDir: sinon.stub(),
            createModuleTmpDir: sinon.stub(),
            getDockerContainerImageName: (mod, coin, net) => {
                if (['database', 'xchain-hub', 'xchain-explorer', 'xchain-sync'].includes(mod)) {
                    return 'xchain-node-' + mod
                }
                return 'xchain-node-' + coin + '-' + net + '-' + mod
            },
            getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
            validatePort: () => true,
            getDefaultConfig: sinon.stub().resolves({
                'NETWORK': 'bitcoin-regtest',
                'NODE_PORT': 18444,
                'ENCODER_PORT': 3003,
                'ENCODER_API_PORT': 3003
            })
        },
        './StatusService': {
            statusChanged: opts.statusChanged || sinon.stub().resolves(),
            getStatus: sinon.stub().resolves({})
        },
        './DockerService': {
            killContainer: opts.killContainer || sinon.stub().resolves(true),
            removeContainer: opts.removeContainer || sinon.stub().resolves(true),
            getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } })
        },
        './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
    })
}

describe('Chaos: Process Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // -------------------------------------------------------------------
    // Experiment 11: Async error propagation (SIG-04)
    // -------------------------------------------------------------------

    describe('Experiment 11: Async error propagation', function () {

        it('propagates rejection from docker build failure', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(new Error('Unexpected build error'))
                }
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error creating Docker image')
                expect(err).to.include('Unexpected build error')
            }
        })

        it('propagates string errors from docker run', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(new Error('Container run error'))
                }
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Error creating the container')
            }
        })

        it('propagates rejection from statusChanged()', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')
            const containerId = 'a'.repeat(64)

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, containerId + '\n')
                }
            })

            const ms = loadModuleService(stubs, {
                statusChanged: sinon.stub().rejects(new Error('Status update failed'))
            })

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err.message).to.equal('Status update failed')
            }
        })

        it('handles rejection from killContainer during overwrite gracefully', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')
            const containerId = 'b'.repeat(64)

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, containerId + '\n')
                }
            })

            const ms = loadModuleService(stubs, {
                killContainer: sinon.stub().rejects(new Error('container not running')),
                removeContainer: sinon.stub().resolves(true)
            })

            // killContainer failure should be caught (container may not be running)
            const result = await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest', 'old-container-id')
            expect(result).to.equal(containerId)
        })

        it('propagates rejection from removeContainer during overwrite', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                }
            })

            const ms = loadModuleService(stubs, {
                killContainer: sinon.stub().resolves(true),
                removeContainer: sinon.stub().rejects(new Error('container in use'))
            })

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest', 'old-container-id')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err.message).to.equal('container in use')
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment: Empty container ID propagation (LDB-03 → CMD)
    // -------------------------------------------------------------------

    describe('Experiment: Empty container ID propagation', function () {

        it('rejects when docker run returns whitespace-only container ID', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, '   \n')
                }
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })

        it('rejects when docker run returns container ID with non-hex characters', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    // 64 chars but includes 'g' which is not hex
                    cb(null, 'g'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })

        it('accepts valid 64-char hex container ID', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')
            const validId = 'abcdef0123456789'.repeat(4)

            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let cb
                if (typeof rest[0] === 'function') cb = rest[0]
                else cb = rest[1]
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, validId + '\n')
                }
            })
            const ms = loadModuleService(stubs)

            const result = await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
            expect(result).to.equal(validId)
        })
    })

    // -------------------------------------------------------------------
    // Experiment: cloneGit + buildAndUp error chain
    // -------------------------------------------------------------------

    describe('Experiment: Multi-step operation error propagation', function () {

        it('cloneGit error prevents buildAndUp from running', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            // cloneGit will fail (module doesn't have URL)
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('nonexistent-module')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include("doesn't have an url")
            }

            // No docker commands should have been called
            expect(stubs.execFile.called).to.be.false
        })

        it('module not found error before any docker operations', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: { insertModuleContainer: sinon.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(false), // Module not found
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: () => 'test',
                    getDockerNetwork: () => 'test',
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
                './DockerService': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves() },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
            })

            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err).to.equal('module not found')
            }

            // No docker commands should have been called
            expect(stubs.execFile.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // Experiment: uninstallModule error scenarios
    // -------------------------------------------------------------------

    describe('Experiment: Uninstall resilience', function () {

        it('throws when trying to uninstall the database module', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.uninstallModule('bitcoin', 'mainnet', 'database')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err).to.include('manually removed')
            }
        })

        it('returns true when module is not found in status (already uninstalled)', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            const result = await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // Experiment: Precheck failure cascade
    // -------------------------------------------------------------------

    describe('Experiment: Precheck failure cascade', function () {

        it('Docker check failure stops all subsequent precheck steps', async function () {
            const checkDocker = sinon.stub().rejects(new Error('Docker not available'))
            const createNetwork = sinon.stub()
            const createDb = sinon.stub()

            const precheck = proxyquire('../../src/precheck', {
                './config/constants': {
                    dataDir: '/tmp/test-data',
                    moduleDir: '/tmp/test-modules',
                    tmpDir: '/tmp/test-tmp',
                    containersFilesDir: '/tmp/test-containers'
                },
                './state': {
                    db: { createDatabase: createDb },
                    isVerbose: () => false
                },
                './services/DockerService': {
                    checkDockerInstalledAndReachable: checkDocker,
                    createDockerNetwork: createNetwork
                },
                './services/ConfigService': { getDockerNetwork: () => 'xchain-node' },
                './services/VersionService': { checkAllRemoteVersions: sinon.stub() },
                './services/StatusService': { getStatus: sinon.stub() },
                './services/HubService': { installHubModule: sinon.stub(), updateHub: sinon.stub() },
                './services/ExplorerService': { updateExplorer: sinon.stub() },
                'fs': {
                    existsSync: sinon.stub().returns(true),
                    mkdirSync: sinon.stub()
                }
            })

            try {
                await precheck.preCheck()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Docker is not installed')
            }

            // No subsequent steps should have been called
            expect(createDb.called).to.be.false
            expect(createNetwork.called).to.be.false
        })

        it('Directory creation failure does not throw (mkdirSync creates dirs)', function () {
            const fsStub = {
                existsSync: sinon.stub().returns(false),
                mkdirSync: sinon.stub()
            }

            const precheck = proxyquire('../../src/precheck', {
                './config/constants': {
                    dataDir: '/tmp/test-data',
                    moduleDir: '/tmp/test-modules',
                    tmpDir: '/tmp/test-tmp',
                    containersFilesDir: '/tmp/test-containers'
                },
                './state': { db: { createDatabase: sinon.stub() }, isVerbose: () => false },
                './services/DockerService': {
                    checkDockerInstalledAndReachable: sinon.stub(),
                    createDockerNetwork: sinon.stub()
                },
                './services/ConfigService': { getDockerNetwork: () => 'xchain-node' },
                './services/VersionService': { checkAllRemoteVersions: sinon.stub() },
                './services/StatusService': { getStatus: sinon.stub() },
                './services/HubService': { installHubModule: sinon.stub(), updateHub: sinon.stub() },
                './services/ExplorerService': { updateExplorer: sinon.stub() },
                'fs': fsStub
            })

            precheck.createDirectories()
            expect(fsStub.mkdirSync.callCount).to.equal(4)
        })

        it('Network creation failure throws with descriptive message', async function () {
            const precheck = proxyquire('../../src/precheck', {
                './config/constants': {
                    dataDir: '/tmp/test-data',
                    moduleDir: '/tmp/test-modules',
                    tmpDir: '/tmp/test-tmp',
                    containersFilesDir: '/tmp/test-containers'
                },
                './state': {
                    db: { createDatabase: sinon.stub().resolves() },
                    isVerbose: () => false
                },
                './services/DockerService': {
                    checkDockerInstalledAndReachable: sinon.stub().resolves(true),
                    createDockerNetwork: sinon.stub().rejects(new Error('network error'))
                },
                './services/ConfigService': { getDockerNetwork: () => 'xchain-node' },
                './services/VersionService': { checkAllRemoteVersions: sinon.stub() },
                './services/StatusService': { getStatus: sinon.stub().resolves({}) },
                './services/HubService': { installHubModule: sinon.stub(), updateHub: sinon.stub() },
                './services/ExplorerService': { updateExplorer: sinon.stub() },
                'fs': {
                    existsSync: sinon.stub().returns(true),
                    mkdirSync: sinon.stub()
                }
            })

            try {
                await precheck.preCheck()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('error trying to create the base xchain network')
            }
        })

        it('Hub install failure throws with descriptive message', async function () {
            const precheck = proxyquire('../../src/precheck', {
                './config/constants': {
                    dataDir: '/tmp/test-data',
                    moduleDir: '/tmp/test-modules',
                    tmpDir: '/tmp/test-tmp',
                    containersFilesDir: '/tmp/test-containers'
                },
                './state': {
                    db: { createDatabase: sinon.stub().resolves() },
                    isVerbose: () => false
                },
                './services/DockerService': {
                    checkDockerInstalledAndReachable: sinon.stub().resolves(true),
                    createDockerNetwork: sinon.stub().resolves(true)
                },
                './services/ConfigService': { getDockerNetwork: () => 'xchain-node' },
                './services/VersionService': { checkAllRemoteVersions: sinon.stub() },
                './services/StatusService': { getStatus: sinon.stub().resolves({}) },
                './services/HubService': {
                    installHubModule: sinon.stub().rejects(new Error('hub install failed')),
                    updateHub: sinon.stub()
                },
                './services/ExplorerService': { updateExplorer: sinon.stub() },
                'fs': {
                    existsSync: sinon.stub().returns(true),
                    mkdirSync: sinon.stub()
                }
            })

            try {
                await precheck.preCheck()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('error trying to install the hub module')
            }
        })
    })
})
