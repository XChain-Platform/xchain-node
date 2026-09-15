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

moduleSuite('installModule(): node: checkRemoteNodeVersion called when coin not in remoteVersions', function () {it('throws when getCryptoNode fails', async function () {
            const stubs = makeStubs()
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
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './node_service': {
                    buildCryptoNode: sinon.stub().resolves(true),
                    getCryptoNode: sinon.stub().rejects(new Error('getCryptoNode failed'))
                },
                './explorer_service': { installExplorerModule: sinon.stub().resolves(true) }
            })
            try {
                await ms.installModule('node', 'bitcoin', 'mainnet', false)
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('getCryptoNode failed')
            }
        })
    })

    // -------------------------------------------------------------------
    // containerExistsByName: catch path (docker inspect rejects → false)
    // -------------------------------------------------------------------
// Same full-install path as the describe above: 1.2s on a CI runner, so
// the budget is stated rather than left to the 2s default.
moduleSuite('containerExistsByName(): via singleton installModule with inspect rejection', function () { this.timeout(10000); it('treats docker inspect rejection as container-not-present (proceeds with install)', async function () {
            const stubs = makeStubs()
            const containerId = 'b'.repeat(64)
            // execFile stub: docker inspect → error (container not found), git → ok, docker build/run → ok
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (cmd === 'docker' && args[0] === 'inspect') { cb(new Error('not found'), '', '') }
                else if (cmd === 'git' || (cmd === 'docker' && args[0] === 'build')) { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            // Use a util stub so execFileAsync resolves with {stdout} shape for containerExistsByName
            const sinon3 = require('sinon'); let asyncCallCount = 0
            const ms = proxyquireCallThru('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'util': {
                    promisify: () => async (cmd, args) => {
                        asyncCallCount++
                        // containerExistsByName calls docker inspect; simulate rejection
                        if (cmd === 'docker' && args && args[0] === 'inspect') throw new Error('no such container')
                        return { stdout: '', stderr: '' }
                    }
                },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db, getRemoteModuleVersions: () => ({}), getLastStatus: () => null
                },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod, getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon3.stub().returns(false), checkIfModuleExists: sinon3.stub().returns(true),
                    removeModuleDir: sinon3.stub(), removeModuleTmpDir: sinon3.stub(),
                    createModuleTmpDir: sinon3.stub(),
                    getDockerContainerImageName: (mod) => `xchain-node-${mod}`,
                    getDockerNetwork: () => 'xchain-node',
                    validatePort: () => true,
                    getDefaultConfig: sinon3.stub().resolves({ HUB_PORT: 10000 })
                },
                './status_service': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                // getPublishedHostPorts must be stubbed: this load calls through, and
                // HUB_PORT below is published as a host port, so the real probe would
                // shell out to the host's docker and fail wherever 10000 is taken.
                './docker_service': { killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName, getPublishedHostPorts: stubs.getPublishedHostPorts, checkBuildKitAvailable: stubs.checkBuildKitAvailable },
                './database_service': { setDatabaseParameters: sinon3.stub().resolves(), setHubDatabaseParameters: sinon3.stub().resolves() },
                './version_service': { getLocalNodeVersion: sinon3.stub().resolves(null), getLocalModuleVersion: sinon3.stub().resolves(null), checkRemoteNodeVersion: sinon3.stub().resolves() },
                './node_service': { buildCryptoNode: sinon3.stub().resolves(true), getCryptoNode: sinon3.stub().resolves() },
                './explorer_service': { installExplorerModule: sinon3.stub().resolves(true) },
                // Another load that bypasses loadModuleService, and it installs the
                // HUB, so the guard fires: stub it here too (see loadModuleService).
                './hub_consensus_env_guard': { assertNoHubConsensusEnvDrift: sinon3.stub().resolves([]), isHubConsensusEnvDriftError: () => false },
                // Same reasoning as loadModuleService: this hub install also runs
                // the DB-credential-drift pre-flight, which shells out to
                // `docker ps` for real unless stubbed.
                './db_credential_drift': { assertNoDbCredentialDrift: sinon3.stub().resolves([]), assertNoHubDbCredentialDrift: sinon3.stub().resolves([]) }
            })
            // With inspect rejection, containerExistsByName returns false → proceeds with install
            const result = await ms.installModule('xchain-hub', null, null, false)
            // Should proceed past the singleton guard and call git clone + docker build + docker run
            expect(stubs.execFile.getCalls().some(c => c.args[0] === 'git')).to.be.true
        }) })

moduleSuite('getModuleBranch()', function () {

        it('returns trimmed branch name from git rev-parse', async function () {
            // getModuleBranch uses execFileAsync = promisify(execFile).
            // The real execFile has util.promisify.custom returning {stdout,stderr}.
            // We use a custom proxyquire that replaces util.promisify with one
            // that returns an async function yielding {stdout, stderr}.
            const sinon2 = require('sinon')
            const execFileStub = sinon2.stub()
            const gitResolve = sinon2.stub().resolves({ stdout: 'feature/test\n', stderr: '' })
            const ms2 = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: execFileStub },
                'util': {
                    promisify: (fn) => {
                        // Return an async function that resolves {stdout, stderr}
                        return async (...args) => gitResolve(...args)
                    }
                },
                'fs': { existsSync: sinon2.stub(), rmSync: sinon2.stub(), mkdirSync: sinon2.stub(), readFileSync: sinon2.stub(), cpSync: sinon2.stub() },
                '../state': {
                    db: { setModuleContainer: sinon2.stub().resolves(true), getModuleContainer: sinon2.stub().resolves(null), deleteModuleContainer: sinon2.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon2.stub().returns(false),
                    checkIfModuleExists: sinon2.stub().returns(true),
                    removeModuleDir: sinon2.stub(),
                    removeModuleTmpDir: sinon2.stub(),
                    createModuleTmpDir: sinon2.stub(),
                    getDockerContainerImageName: sinon2.stub().returns('img'),
                    getDockerNetwork: sinon2.stub().returns('net'),
                    validatePort: () => true,
                    getDefaultConfig: sinon2.stub().resolves({})
                },
                './status_service': { statusChanged: sinon2.stub().resolves(), getStatus: sinon2.stub().resolves({}) },
                './docker_service': { killContainer: sinon2.stub().resolves(true), removeContainer: sinon2.stub().resolves(true), forceRemoveContainerByName: sinon2.stub().resolves(true) },
                './database_service': { setDatabaseParameters: sinon2.stub().resolves() },
                './version_service': { getLocalNodeVersion: sinon2.stub().resolves(null), getLocalModuleVersion: sinon2.stub().resolves(null), checkRemoteNodeVersion: sinon2.stub().resolves() },
                './node_service': { buildCryptoNode: sinon2.stub().resolves(true), getCryptoNode: sinon2.stub().resolves() },
                './explorer_service': { installExplorerModule: sinon2.stub().resolves(true) }
            })
            const branch = await ms2.getModuleBranch('xchain-encoder')
            expect(branch).to.equal('feature/test')
        })
    })

    // -------------------------------------------------------------------
    // assertNoHostPortConflicts: multi-stack host-port collision guard
    // -------------------------------------------------------------------
moduleSuite('assertNoHostPortConflicts()', function () {

        it('resolves when no host ports are requested', async function () {
            const ms = loadModuleService(makeStubs())
            await ms.assertNoHostPortConflicts([], 'self')
        })

        it('resolves when requested ports are free on the host', async function () {
            const stubs = makeStubs()
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([['9999', new Set(['some-other'])]]))
            const ms = loadModuleService(stubs)
            await ms.assertNoHostPortConflicts(['-p', '80:8080', '-p', '443:8443'], 'self')
        })

        it('throws naming the conflicting container when a host port is taken', async function () {
            const stubs = makeStubs()
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([['80', new Set(['xchain-node-explorer'])]]))
            const ms = loadModuleService(stubs)
            let threw = null
            try {
                await ms.assertNoHostPortConflicts(['-p', '80:8080'], 'newprefix-explorer')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.include('host port 80')
            expect(threw.message).to.include('xchain-node-explorer')
        })

        it('does NOT flag the container being re-created (selfName excluded)', async function () {
            const stubs = makeStubs()
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([['80', new Set(['xchain-node-explorer'])]]))
            const ms = loadModuleService(stubs)
            await ms.assertNoHostPortConflicts(['-p', '80:8080'], 'xchain-node-explorer')
        })

        it('parses IP-scoped publish specs (IP:HOST:CONTAINER)', async function () {
            const stubs = makeStubs()
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([['13306', new Set(['xchain-node-database'])]]))
            const ms = loadModuleService(stubs)
            let threw = null
            try {
                await ms.assertNoHostPortConflicts(['-p', '127.0.0.1:13306:3306'], 'self')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.include('13306')
        })

        })

moduleSuite('assertNoHostPortConflicts()', function () {it('reports every conflicting port, not just the first', async function () {
            const stubs = makeStubs()
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([
                ['80',  new Set(['stackA-explorer'])],
                ['443', new Set(['stackA-explorer'])]
            ]))
            const ms = loadModuleService(stubs)
            let threw = null
            try {
                await ms.assertNoHostPortConflicts(['-p', '80:8080', '-p', '443:8443'], 'stackB-explorer')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.include('host port 80')
            expect(threw.message).to.include('host port 443')
        })
    })

    // -------------------------------------------------------------------
    // Venue independence of the suite itself
    // -------------------------------------------------------------------
moduleSuite('unit-suite venue independence', function () {

        it('trips the guard instead of probing the host when a call-through load forgets the stub', async function () {
            const stubs = makeStubs()
            const ms = proxyquireCallThru('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': { db: stubs.db, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                // Deliberately omits getPublishedHostPorts, the mistake this guard catches.
                './docker_service': { killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName }
            })
            let threw = null
            try {
                await ms.assertNoHostPortConflicts(['-p', '3001:3001'], 'self')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.include('stub DockerService.getPublishedHostPorts')
        })

        it('leaves proxyquire in noCallThru mode after a call-through load', async function () {
            const stubs = makeStubs()
            proxyquireCallThru('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                './docker_service': { getPublishedHostPorts: stubs.getPublishedHostPorts }
            })
            // The flip must not outlive that one load: a plain proxyquire with the same
            // partial stub has to shadow the whole dependency, so the missing probe reads
            // as undefined rather than falling back to the real (here guarded) export.
            const ms = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': { db: stubs.db, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                './docker_service': { killContainer: stubs.killContainer }
            })
            let threw = null
            try {
                await ms.assertNoHostPortConflicts(['-p', '3001:3001'], 'self')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(TypeError)
        })
    })

    // -------------------------------------------------------------------
    // cloneGit: non-destructive rewrite
    // -------------------------------------------------------------------
