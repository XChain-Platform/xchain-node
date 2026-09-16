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
    // installModule: DB module path
    // -------------------------------------------------------------------
moduleSuite('installModule(): DB module', function () {

        it('calls buildDatabaseModule and statusChanged for DB module', async function () {
            const stubs = makeStubs()
            const buildDatabaseStub = sinon.stub().resolves(true)
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
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-database'),
                    getDockerNetwork: sinon.stub().returns('xchain-node'),
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
                './database_service': {
                    setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves(),
                    buildDatabaseModule: buildDatabaseStub
                },
                './version_service': {
                    getLocalNodeVersion: sinon.stub().resolves(null),
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './node_service': {
                    buildCryptoNode: sinon.stub().resolves(true),
                    getCryptoNode: sinon.stub().resolves()
                },
                './explorer_service': {
                    installExplorerModule: sinon.stub().resolves(true)
                }
            })
            const result = await ms.installModule('database', 'bitcoin', 'mainnet')
            expect(buildDatabaseStub.calledOnce).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
            expect(result).to.be.true
        })

        })

moduleSuite('installModule(): DB module', function () {it('throws when buildDatabaseModule fails', async function () {
            const stubs = makeStubs()
            const buildDatabaseStub = sinon.stub().rejects(new Error('DB build failed'))
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
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-database'),
                    getDockerNetwork: sinon.stub().returns('xchain-node'),
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
                './database_service': {
                    setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves(),
                    buildDatabaseModule: buildDatabaseStub
                },
                './version_service': {
                    getLocalNodeVersion: sinon.stub().resolves(null),
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './node_service': {
                    buildCryptoNode: sinon.stub().resolves(true),
                    getCryptoNode: sinon.stub().resolves()
                },
                './explorer_service': {
                    installExplorerModule: sinon.stub().resolves(true)
                }
            })
            try {
                await ms.installModule('database', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('DB build failed')
            }
        })
    })

    // -------------------------------------------------------------------
    // installModule: EXPLORER module path
    // -------------------------------------------------------------------
moduleSuite('installModule(): explorer module', function () {

        it('calls installExplorerModule and statusChanged', async function () {
            const stubs = makeStubs()
            const installExplorerStub = sinon.stub().resolves(true)
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
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-xchain-explorer'),
                    getDockerNetwork: sinon.stub().returns('xchain-node'),
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
                './database_service': {
                    setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves()
                },
                './version_service': {
                    getLocalNodeVersion: sinon.stub().resolves(null),
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './node_service': {
                    buildCryptoNode: sinon.stub().resolves(true),
                    getCryptoNode: sinon.stub().resolves()
                },
                './explorer_service': {
                    installExplorerModule: installExplorerStub
                }
            })
            const result = await ms.installModule('xchain-explorer', null, null)
            expect(installExplorerStub.calledOnce).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // installModule: generic module, skip-when-version-present
    // -------------------------------------------------------------------
moduleSuite('installModule(): generic module, container version already known', function () { it('returns false when container version is already set and remoteUpdate=false', async function () {
            const stubs = makeStubs()
            // Provide a last status that has a container_version
            const ms = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => ({
                        bitcoin: {
                            mainnet: {
                                'xchain-encoder': { container_version: '1.0.0' }
                            }
                        }
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
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-bitcoin-mainnet-xchain-encoder'),
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
                './database_service': {
                    setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves()
                },
                './version_service': {
                    getLocalNodeVersion: sinon.stub().resolves('1.0.0'),
                    getLocalModuleVersion: sinon.stub().resolves('1.0.0'),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './node_service': {
                    buildCryptoNode: sinon.stub().resolves(true),
                    getCryptoNode: sinon.stub().resolves()
                },
                './explorer_service': {
                    installExplorerModule: sinon.stub().resolves(true)
                }
            })
            const result = await ms.installModule('xchain-encoder', 'bitcoin', 'mainnet', false)
            expect(result).to.be.false
        }) })

    // -------------------------------------------------------------------
    // installModule: generic module full build path
    // -------------------------------------------------------------------
moduleSuite('installModule(): generic module full build', function () {

        it('clones, builds, and returns containerId for a fresh generic module', async function () {
            const stubs = makeStubs()
            const containerId = 'f'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (cmd === 'git' && args[0] === 'clone') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            const result = await ms.installModule('xchain-encoder', 'bitcoin', 'mainnet', true)
            expect(result).to.equal(containerId)
            expect(stubs.statusChanged.called).to.be.true
        })

        it('throws when cloneGit fails during installModule', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (cmd === 'git') { cb(new Error('clone error')) }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.installModule('xchain-encoder', 'bitcoin', 'mainnet', true)
                expect.fail()
            } catch (err) {
                expect(err).to.include('Error cloning')
            }
        })
    })

    // -------------------------------------------------------------------
    // buildAndUp: port validation + hub/sync/indexer/regtest branches
    // -------------------------------------------------------------------
moduleSuite('buildAndUp(): module-specific port/volume branches', function () {

        it('includes port mapping for xchain-hub', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-hub', 'bitcoin', 'mainnet')
            expect(runArgs).to.include('-p')
            expect(runArgs.some(a => typeof a === 'string' && a.startsWith('10000:'))).to.be.true
        })

        it('includes two port mappings for xchain-explorer', async function () {
            const stubs = makeStubs()
            // xchain-explorer has LIBRARY_BUNDLES=['xchain-vm'], so buildAndUp clones + stages it first.
            stubs.fs.cpSync = sinon.stub()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (cmd === 'git') { cb(null) } // handle cloneGit for xchain-vm
                else if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-explorer', null, null)
            // Should have two -p args
            const pCount = runArgs.filter(a => a === '-p').length
            expect(pCount).to.equal(2)
        })

        it('includes port mapping for xchain-sync', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-sync', null, null)
            expect(runArgs).to.include('-p')
        })

        })
