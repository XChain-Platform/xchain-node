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

moduleSuite('buildAndUp(): module-specific port/volume branches', function () {it('includes port mapping for xchain-regtest-miner', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-regtest-miner', 'bitcoin', 'mainnet')
            expect(runArgs).to.include('-p')
        })

        it('includes port mapping for xchain-indexer and invokes cpSync filter for bundled libs', async function () {
            const stubs = makeStubs()
            // xchain-indexer has LIBRARY_BUNDLES=['xchain-vm'], so buildAndUp clones xchain-vm first.
            let capturedFilter = null
            stubs.fs.cpSync = sinon.stub().callsFake((src, dest, opts) => {
                if (opts && opts.filter) capturedFilter = opts.filter
            })
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
            await ms.buildAndUp(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet')
            expect(runArgs).to.include('-p')
            expect(runArgs.some(a => typeof a === 'string' && a.includes('3004'))).to.be.true
            // Verify filter function logic: excluded dirs should return false
            expect(capturedFilter).to.be.a('function')
            expect(capturedFilter('/path/to/node_modules')).to.be.false
            expect(capturedFilter('/path/to/.git')).to.be.false
            expect(capturedFilter('/path/to/test')).to.be.false
            expect(capturedFilter('/path/to/bench')).to.be.false
            expect(capturedFilter('/path/to/reports')).to.be.false
            expect(capturedFilter('/path/to/src/index.js')).to.be.true
        }) })

moduleSuite('buildAndUp(): module-specific port/volume branches', function () {it('mounts the capability config DIRECTORY when HUB_CAPABILITY_CONFIG is set', async function () {
            const stubs = makeStubs()
            const capsHostDir = '/host/validator/hub-caps'
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            // Use proxyquire with ValidatorService stub + HUB_CAPABILITY_CONFIG in env
            const ms2 = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}), getLastStatus: () => null
                },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod, getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false), checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(), removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: (mod, coin, net) => {
                        if (mod === 'xchain-hub') return 'xchain-node-xchain-hub'
                        return `xchain-node-${coin}-${net}-${mod}`
                    },
                    getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
                    validatePort: (v) => { const p = parseInt(v, 10); return p >= 1 && p <= 65535 },
                    getDefaultConfig: sinon.stub().resolves({ HUB_PORT: 10000, HUB_CAPABILITY_CONFIG: '/container/caps.json' })
                },
                './status_service': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './docker_service': {
                    killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName,
                    removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName,
                    getStatusFromContainer: stubs.getStatusFromContainer, getPublishedHostPorts: stubs.getPublishedHostPorts
                },
                './database_service': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
                './validator_service': {
                    getCapabilityConfigMountDir: () => capsHostDir, getSignerMountDir: () => null,
                    CAPS_CONTAINER_DIR: '/validator', SIGNER_CONTAINER_DIR: '/XChainHub/operator-signer'
                },
                './version_service': { getLocalNodeVersion: sinon.stub().resolves(null), getLocalModuleVersion: sinon.stub().resolves(null), checkRemoteNodeVersion: sinon.stub().resolves() },
                './node_service': { buildCryptoNode: sinon.stub().resolves(true), getCryptoNode: sinon.stub().resolves() },
                './explorer_service': { installExplorerModule: sinon.stub().resolves(true) },
                // This load bypasses loadModuleService, so it needs the guard stub of
                // its own; without it the test reads whatever hub container the host
                // is running (see loadModuleService for the full note).
                './hub_consensus_env_guard': {
                    assertNoHubConsensusEnvDrift: sinon.stub().resolves([]),
                    isHubConsensusEnvDriftError: () => false
                }
            })
            await ms2.buildAndUp('xchain-hub', 'bitcoin', 'mainnet')
            // Should have a volume mount for the capability config, and it must be
            // the containing DIRECTORY: a single-file bind mount permanently breaks
            // `docker cp` against this container.
            expect(runArgs).to.include('-v')
            expect(runArgs).to.include(capsHostDir + ':/validator:ro')
        }) })

moduleSuite('buildAndUp(): module-specific port/volume branches', function () {it('rejects when port value is invalid (non-numeric)', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else { cb(null, '') }
            })
            // Use a custom stub where validatePort returns false
            const ms2 = proxyquire('../../../src/services/module_service', {
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
                    getDockerContainerImageName: () => 'xchain-node-bitcoin-mainnet-xchain-encoder',
                    getDockerNetwork: () => 'xchain-node-bitcoin-mainnet',
                    validatePort: () => false, // always invalid
                    getDefaultConfig: sinon.stub().resolves({
                        ENCODER_PORT: 99999,
                        ENCODER_API_PORT: 99999
                    })
                },
                './status_service': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './docker_service': { killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
                './database_service': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
                './version_service': { getLocalNodeVersion: sinon.stub().resolves(null), getLocalModuleVersion: sinon.stub().resolves(null), checkRemoteNodeVersion: sinon.stub().resolves() },
                './node_service': { buildCryptoNode: sinon.stub().resolves(true), getCryptoNode: sinon.stub().resolves() },
                './explorer_service': { installExplorerModule: sinon.stub().resolves(true) }
            })
            try {
                await ms2.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Invalid port value')
            }
        })

        })

moduleSuite('buildAndUp(): module-specific port/volume branches', function () {it('runs the host-port preflight BEFORE docker build so a conflict fails fast', async function () {
            const stubs = makeStubs()
            // ENCODER_PORT/ENCODER_API_PORT both resolve to 3003 (see makeStubs'
            // getDefaultConfig); report that host port as already published by a
            // differently-named container so assertNoHostPortConflicts rejects.
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([['3003', new Set(['other-stack-container'])]]))
            let buildInvoked = false
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { buildInvoked = true; cb(null) }
                else if (args[0] === 'run') { cb(null, 'a'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('Should have rejected on host port conflict')
            } catch (err) {
                expect(String(err)).to.include('Host port conflict')
            }
            expect(buildInvoked).to.be.false
        })

        it('includes --restart unless-stopped for non-execution containers', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, false)
            expect(runArgs).to.include('--restart')
            expect(runArgs).to.include('unless-stopped')
        })

        it('omits --restart for onlyExecution containers', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)
            expect(runArgs).to.not.include('--restart')
        })

        })

moduleSuite('buildAndUp(): module-specific port/volume branches', function () {it('rejects when docker build fails', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(new Error('build failed')) }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Error creating Docker image')
            }
        })

        // xchain-hub issue 23: on a buildx-less host the legacy builder died on
        // the module Dockerfiles' optional COPY glob after the clone and the DB
        // provisioning had already run. The probe has to refuse BEFORE the
        // build and name the missing package.
        it('refuses to build on a host without buildx and never invokes docker build', async function () {
            const stubs = makeStubs()
            stubs.checkBuildKitAvailable = sinon.stub().rejects(
                "Docker's buildx plugin is not installed: sudo apt install docker-buildx-plugin")
            let buildInvoked = false
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') { buildInvoked = true; cb(null) }
                else if (args[0] === 'run') { cb(null, 'f'.repeat(64) + '\n') }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('Should have rejected without buildx')
            } catch (err) {
                expect(String(err)).to.include('Error creating Docker image')
                expect(String(err)).to.include('docker-buildx-plugin')
            }
            expect(buildInvoked).to.be.false
        })

        })

moduleSuite('buildAndUp(): module-specific port/volume branches', function () {it('runs docker build with DOCKER_BUILDKIT=1 even when the host exports DOCKER_BUILDKIT=0', async function () {
            const stubs = makeStubs()
            let buildOpts = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { buildOpts = opts; cb(null) }
                else if (args[0] === 'run') { cb(null, 'c'.repeat(64) + '\n') }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            const prior = process.env.DOCKER_BUILDKIT
            process.env.DOCKER_BUILDKIT = '0'
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            } finally {
                if (prior === undefined) delete process.env.DOCKER_BUILDKIT
                else process.env.DOCKER_BUILDKIT = prior
            }
            expect(stubs.checkBuildKitAvailable.calledOnce).to.be.true
            expect(buildOpts).to.be.an('object')
            expect(buildOpts.env).to.be.an('object')
            expect(buildOpts.env.DOCKER_BUILDKIT).to.equal('1')
        })

        it('rejects when docker run fails', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { cb(new Error('run failed')) }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Error creating the container')
            }
        })

        })
