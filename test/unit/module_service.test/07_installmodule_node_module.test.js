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

    // -------------------------------------------------------------------
    // installModule: NODE_MODULE_NAME paths
    // -------------------------------------------------------------------
moduleSuite('installModule(): node module', function () {

        it('builds crypto node when no container version and localNodeVersion is null', async function () {
            const stubs = makeStubs()
            const buildCryptoNodeStub = sinon.stub().resolves(true)
            const getCryptoNodeStub = sinon.stub().resolves()
            const ms = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({ 'node-bitcoin': { tag_name: 'v25.0.0' } }),
                    getLastStatus: () => null
                },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-bitcoin-mainnet-node'),
                    getDockerNetwork: sinon.stub().returns('xchain-node-bitcoin-mainnet'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './status_service': {
                    statusChanged: stubs.statusChanged,
                    getStatus: stubs.getStatus
                },
                './docker_service': {
                    killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName,
                    removeContainer: stubs.removeContainer,
                    forceRemoveContainerByName: stubs.forceRemoveContainerByName,
                    getStatusFromContainer: stubs.getStatusFromContainer
                },
                './database_service': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
                './version_service': {
                    getLocalNodeVersion: sinon.stub().resolves(null),
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './node_service': {
                    buildCryptoNode: buildCryptoNodeStub,
                    getCryptoNode: getCryptoNodeStub
                },
                './explorer_service': { installExplorerModule: sinon.stub().resolves(true) }
            })
            const result = await ms.installModule('node', 'bitcoin', 'mainnet', false)
            expect(getCryptoNodeStub.calledOnce).to.be.true
            expect(buildCryptoNodeStub.calledOnce).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
            expect(result).to.be.true
        })

        })

moduleSuite('installModule(): node module', function () {it('returns false when node container_version already set and remoteUpdate=false', async function () {
            const stubs = makeStubs()
            const ms = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => ({
                        bitcoin: { mainnet: { node: { container_version: 'v25.0.0' } } }
                    })
                },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('node'),
                    getDockerNetwork: sinon.stub().returns('net'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './status_service': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './docker_service': { killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
                './database_service': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
                './version_service': { getLocalNodeVersion: sinon.stub().resolves('v25.0.0'), getLocalModuleVersion: sinon.stub().resolves(null), checkRemoteNodeVersion: sinon.stub().resolves() },
                './node_service': { buildCryptoNode: sinon.stub().resolves(true), getCryptoNode: sinon.stub().resolves() },
                './explorer_service': { installExplorerModule: sinon.stub().resolves(true) }
            })
            const result = await ms.installModule('node', 'bitcoin', 'mainnet', false)
            expect(result).to.be.false
        })

        })

moduleSuite('installModule(): node module', function () {it('skips getCryptoNode when localNodeVersion already set and remoteUpdate=false', async function () {
            const stubs = makeStubs()
            const getCryptoNodeStub = sinon.stub().resolves()
            const buildCryptoNodeStub = sinon.stub().resolves(true)
            const ms = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('node'),
                    getDockerNetwork: sinon.stub().returns('net'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './status_service': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './docker_service': { killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
                './database_service': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
                './version_service': {
                    getLocalNodeVersion: sinon.stub().resolves('v25.0.0'), // has local version
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './node_service': { buildCryptoNode: buildCryptoNodeStub, getCryptoNode: getCryptoNodeStub },
                './explorer_service': { installExplorerModule: sinon.stub().resolves(true) }
            })
            const result = await ms.installModule('node', 'bitcoin', 'mainnet', false)
            expect(getCryptoNodeStub.called).to.be.false
            expect(buildCryptoNodeStub.calledOnce).to.be.true
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // installModule: explorer error path
    // -------------------------------------------------------------------
moduleSuite('installModule(): explorer error path', function () {

        it('throws when installExplorerModule fails', async function () {
            const stubs = makeStubs()
            const ms = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('explorer'),
                    getDockerNetwork: sinon.stub().returns('net'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './status_service': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './docker_service': { killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
                './database_service': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
                './version_service': { getLocalNodeVersion: sinon.stub().resolves(null), getLocalModuleVersion: sinon.stub().resolves(null), checkRemoteNodeVersion: sinon.stub().resolves() },
                './node_service': { buildCryptoNode: sinon.stub().resolves(true), getCryptoNode: sinon.stub().resolves() },
                './explorer_service': { installExplorerModule: sinon.stub().rejects(new Error('explorer install failed')) }
            })
            try {
                await ms.installModule('xchain-explorer', null, null, false)
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('explorer install failed')
            }
        })
    })

    // -------------------------------------------------------------------
    // installModule: branch switch when module already on different branch
    // -------------------------------------------------------------------
moduleSuite('installModule(): branch switch path', function () { it('reclones when existing branch differs from requested branch', async function () {
            const sinon3 = require('sinon')
            const containerId = 'd'.repeat(64)
            const execFileStub = sinon3.stub()
            const cloneCallArgs = []
            execFileStub.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (cmd === 'git') {
                    cloneCallArgs.push(args)
                    cb(null)
                }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            // getModuleBranch uses promisify(execFile) → needs util stub
            const currentBranchStub = sinon3.stub().resolves({ stdout: 'master\n', stderr: '' })
            const moduleDirExistsStub = sinon3.stub().returns(true)
            const ms = proxyquireCallThru('../../../src/services/module_service', {
                'child_process': { execFile: execFileStub },
                'util': { promisify: () => async (...args) => currentBranchStub(...args) },
                // renameSync must be stubbed under a call-through load: cloneGit's
                // rewrite path stages the clone and swaps it in, and a
                // call-through would rename real paths on the test host.
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub(), renameSync: sinon3.stub() },
                '../state': {
                    db: { setModuleContainer: sinon3.stub().resolves(true), getModuleContainer: sinon3.stub().resolves(null), deleteModuleContainer: sinon3.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}), getLastStatus: () => null
                },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod, getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: moduleDirExistsStub,
                    checkIfModuleExists: sinon3.stub().returns(true),
                    removeModuleDir: sinon3.stub(),
                    removeModuleTmpDir: sinon3.stub(),
                    createModuleTmpDir: sinon3.stub(),
                    getDockerContainerImageName: (mod, coin, net) => `${coin}-${net}-${mod}`,
                    getDockerNetwork: (coin, net) => `net-${coin}-${net}`,
                    validatePort: () => true,
                    getDefaultConfig: sinon3.stub().resolves({ ENCODER_PORT: 3003, ENCODER_API_PORT: 3003 })
                },
                './status_service': { statusChanged: sinon3.stub().resolves(), getStatus: sinon3.stub().resolves({}) },
                './docker_service': { killContainer: sinon3.stub().resolves(true), removeContainer: sinon3.stub().resolves(true), forceRemoveContainerByName: sinon3.stub().resolves(true), getPublishedHostPorts: sinon3.stub().resolves(new Map()), checkBuildKitAvailable: sinon3.stub().resolves(true) },
                './database_service': { setDatabaseParameters: sinon3.stub().resolves(), setHubDatabaseParameters: sinon3.stub().resolves() },
                './version_service': {
                    getLocalNodeVersion: sinon3.stub().resolves(null),
                    getLocalModuleVersion: sinon3.stub().resolves('1.0.0'), // has local version → won't remoteUpdate clone
                    checkRemoteNodeVersion: sinon3.stub().resolves()
                },
                './node_service': { buildCryptoNode: sinon3.stub().resolves(true), getCryptoNode: sinon3.stub().resolves() },
                './explorer_service': { installExplorerModule: sinon3.stub().resolves(true) }
            })
            // Module has localVersion (so won't clone on remoteUpdate=false), dir exists, but branch differs
            const result = await ms.installModule('xchain-encoder', 'bitcoin', 'mainnet', false, null, false, 'feature/new')
            // Should have called git clone (branch switch)
            const cloneCalls = execFileStub.getCalls().filter(c => c.args[0] === 'git')
            expect(cloneCalls.length).to.be.greaterThan(0)
            expect(result).to.equal(containerId)
        }) })

    // -------------------------------------------------------------------
    // uninstallModule: deleteModuleContainer returns false
    // -------------------------------------------------------------------
moduleSuite('uninstallModule(): deleteModuleContainer returns false', function () {

        it('throws when deleteModuleContainer returns false after successful container removal', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({
                bitcoin: {
                    mainnet: {
                        'xchain-encoder': {
                            container_id: 'enc-789',
                            status: { State: { Status: 'exited' } }
                        }
                    }
                }
            })
            stubs.db.deleteModuleContainer.resolves(null) // falsy → triggers throw
            const ms = loadModuleService(stubs)
            try {
                await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
                expect.fail()
            } catch (err) {
                // The catch block at line 466 rethrows "There was a problem trying to kill a container"
                expect(err).to.include('problem')
            }
        })
    })

    // -------------------------------------------------------------------
    // installModule: NODE path: checkRemoteNodeVersion when not in remoteVersions
    // -------------------------------------------------------------------
moduleSuite('installModule(): node: checkRemoteNodeVersion called when coin not in remoteVersions', function () {

        it('calls checkRemoteNodeVersion when coin not in remote versions map', async function () {
            const stubs = makeStubs()
            const checkRemoteNodeVersionStub = sinon.stub().resolves()
            const getCryptoNodeStub = sinon.stub().resolves()
            const buildCryptoNodeStub = sinon.stub().resolves(true)
            // getRemoteModuleVersions returns a map that includes the coin only after checkRemoteNodeVersion
            let callCount = 0
            const getRemoteModuleVersionsStub = () => {
                callCount++
                if (callCount <= 1) {
                    return {} // first call: coin not present → triggers checkRemoteNodeVersion
                }
                return { 'node-bitcoin': { tag_name: 'v25.0.0' } } // second call: populated
            }
            const ms = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: getRemoteModuleVersionsStub,
                    getLastStatus: () => null
                },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('node'),
                    getDockerNetwork: sinon.stub().returns('net'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './status_service': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './docker_service': { killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
                './database_service': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
                './version_service': {
                    getLocalNodeVersion: sinon.stub().resolves(null),
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: checkRemoteNodeVersionStub
                },
                './node_service': { buildCryptoNode: buildCryptoNodeStub, getCryptoNode: getCryptoNodeStub },
                './explorer_service': { installExplorerModule: sinon.stub().resolves(true) }
            })
            const result = await ms.installModule('node', 'bitcoin', 'mainnet', false)
            expect(checkRemoteNodeVersionStub.calledOnce).to.be.true
            expect(result).to.be.true
        })

        })
