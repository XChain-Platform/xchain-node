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

const fs         = require('fs')
const path       = require('path')
const sinon      = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

const TestEnv        = require('../../integration/helpers/test-env')
const CommandCapture = require('../../integration/helpers/command-capture')
const HttpCapture    = require('../../integration/helpers/http-capture')

const ROOT = path.join(__dirname, '..', '..', '..')

/**
 * E2EEnv: wires all xchain-node services together with stubbed
 * child_process / axios / blessed, but real config generation,
 * real LevelDB state (in-memory), and real service-list expansion.
 *
 * Usage:
 *   const env = new E2EEnv()
 *   await env.setup()
 *   env.setupDefaultRoutes()
 *   const cli = env.createCLI()
 *   await cli.moduleOps.installModules(serviceList, 'master')
 *   // ... assertions ...
 *   await env.teardown()
 */
class E2EEnv extends TestEnv {
    constructor() {
        super()
        this.capture = null
        this.http = null
        this._containerCounter = 0
    }

    async setup() {
        await super.setup()
        this.capture = new CommandCapture()
        this.http = new HttpCapture()
        return this
    }

    /**
     * Generate a unique fake 64-char container ID for each docker run call.
     */
    nextContainerId() {
        this._containerCounter++
        const hex = this._containerCounter.toString(16).padStart(4, '0')
        return ('c' + hex).repeat(16).substring(0, 64)
    }

    /**
     * Set up default CommandCapture routes for all Docker commands.
     * Each `docker run` returns a unique container ID.
     * Each `docker kill/rm/stop/start/restart` echoes back the container ID.
     */
    setupDefaultRoutes() {
        const self = this

        // docker build always succeeds
        this.capture.when(/docker build/).returns({ stdout: '' })

        // docker run returns a unique container ID each time
        this.capture.when(/docker run/).respondsWith(() => {
            return { stdout: self.nextContainerId() + '\n' }
        })

        // docker kill/rm/stop/start/restart echo back the container ID
        const extractId = (cmd) => {
            const parts = cmd.trim().split(/\s+/)
            return { stdout: parts[parts.length - 1] }
        }
        this.capture.when(/docker kill/).respondsWith(extractId)
        this.capture.when(/docker rm/).respondsWith(extractId)
        this.capture.when(/docker stop/).respondsWith(extractId)
        this.capture.when(/docker start/).respondsWith(extractId)
        this.capture.when(/docker restart/).respondsWith(extractId)

        // docker network inspect: return success with gateway info.
        // createDockerNetwork checks if network exists first, and if inspect succeeds
        // it skips creation (which is fine for tests, since the network "already exists").
        // addUserPasswordToDatabase also needs getDockerNetworkInspect to return gateway info.
        this.capture.when(/docker network inspect/).returns({
            stdout: JSON.stringify([{
                Name: 'xchain-node',
                IPAM: { Config: [{ Gateway: '172.18.0.1' }] }
            }])
        })

        // docker network create succeeds (called when inspect fails, but with our
        // setup inspect always succeeds so createDockerNetwork skips creation)
        this.capture.when(/docker network create/).returns({ stdout: '' })

        // docker inspect --type container --format {{.Id}}: the DB fail-fast
        // precheck (getDatabaseContainerId, 32224ab) expects a bare 64-hex id;
        // the generic inspect route below would feed it a JSON blob and the
        // precheck would abort installs with "MariaDB container not found".
        // Must be registered BEFORE the generic route (first match wins).
        this.capture.when(/docker inspect --type container --format/).returns({
            stdout: 'd'.repeat(64) + '\n'
        })

        // docker inspect (container) returns running status
        this.capture.when(/docker inspect(?! .*network)/).respondsWith(() => {
            return {
                stdout: JSON.stringify([{
                    State: { Status: 'running' },
                    NetworkSettings: {
                        Ports: {},
                        Networks: {
                            'xchain-node': { Gateway: '172.18.0.1' }
                        }
                    }
                }])
            }
        })

        // docker --version
        this.capture.when(/docker --version/).returns({
            stdout: 'Docker version 24.0.0, build abc123'
        })

        // docker ps
        this.capture.when(/docker ps/).returns({ stdout: '' })

        // docker pull / docker tag (for MariaDB)
        this.capture.when(/docker pull/).returns({ stdout: '' })
        this.capture.when(/docker tag/).returns({ stdout: '' })

        // docker exec (for MariaDB commands): return success
        this.capture.when(/docker exec/).returns({ stdout: '0' })

        // docker logs
        this.capture.when(/docker logs/).returns({ stdout: 'log output' })

        // docker wait
        this.capture.when(/docker wait/).returns({ stdout: '0' })

        // git clone succeeds AND creates its destination, the way real git does.
        // cloneGit stages a rewrite-clone in a sibling directory and swaps it in
        // only once git reports success , so a route that produced no
        // directory would leave the swap with nothing to move into place.
        this.capture.when(/git clone/).respondsWith((cmd) => {
            const parts = cmd.trim().split(/\s+/)
            const destination = parts[parts.length - 1]
            self.writeFakeModuleAt(destination, path.basename(destination).split('.')[0])
            return { stdout: '' }
        })

        // git rev-parse (branch check)
        this.capture.when(/git.*rev-parse/).returns({ stdout: 'master\n' })

        // HTTP: hub ping succeeds
        this.http.when(/127\.0\.0\.1/).returns({
            data: { result: true }
        })
    }

    /**
     * Write a config file and create fake module directories for a full stack.
     */
    setupFullStack(coin, network) {
        this.writeConfigFile(`${coin}-${network}`, '')
        this.createFakeModule('xchain-encoder')
        this.createFakeModule('xchain-decoder')
        this.createFakeModule('xchain-utxo-tracker')
        this.createFakeModule('xchain-indexer')
        this.createFakeModule('xchain-regtest-miner')
        this.createFakeModule('xchain-hub')
        this.createFakeModule('xchain-explorer')
        this.createFakeModule('xchain-e2e-test')
        this.createFakeModule('xchain-sync')
        // Staged into dependent build contexts by cpSync (5c82dba); installs
        // lstat it even though no container is built from it directly.
        this.createFakeModule('xchain-vm')
    }

    /**
     * Create a fully-wired CLI with all services connected through stubs.
     * Returns { moduleOps, ModuleService, DockerService, ConfigService, DatabaseService, StatusService }
     */
    createCLI() {
        const self = this
        const capture = this.capture
        const http = this.http

        // Patched constants
        const patchedConstants = Object.assign({}, require(path.join(ROOT, 'src/config/constants')), {
            configDir: this.configDir,
            moduleDir: this.moduleDir,
            dataDir: this.dataDir,
            tmpDir: path.join(this.tmpDir, 'tmp'),
            containersFilesDir: path.join(this.tmpDir, 'tmp', 'containers_files')
        })

        // ConfigService with patched paths.
        // removeModuleDir/removeModuleTmpDir are no-ops so nothing deletes the
        // fake module dirs out from under buildAndUp's checkIfModuleExists check.
        // (cloneGit's rewrite path no longer deletes them at all: it stages the
        // clone and swaps it in, and the fake `git clone` route materializes the
        // staged copy.)
        const RealConfigService = proxyquire(path.join(ROOT, 'src/services/ConfigService'), {
            '../config/constants': patchedConstants
        })
        const ConfigService = Object.assign({}, RealConfigService, {
            removeModuleDir: () => {},
            removeModuleTmpDir: () => {}
        })

        const execFileStub = capture.createExecFileStub()
        const execFileAsyncStub = capture.createExecFileAsyncStub()
        const spawnStub = capture.createSpawnStub()
        const spawnSyncStub = capture.createSpawnSyncStub()

        // Custom spawn that auto-closes for docker logs (prevents hangs)
        const autoCloseSpawnStub = function (command, args, options) {
            const child = spawnStub(command, args, options)
            // Auto-emit 'close' on next tick so logContainer/spawn-based tests don't hang
            process.nextTick(() => child.emit('close', 0))
            return child
        }

        // DockerService
        const DockerService = proxyquire(path.join(ROOT, 'src/services/DockerService'), {
            'child_process': {
                execFile: execFileStub,
                spawn: autoCloseSpawnStub,
                spawnSync: spawnSyncStub
            },
            'util': { promisify: () => execFileAsyncStub },
            '../config/constants': patchedConstants,
            'blessed': {
                screen: () => ({ key: () => {}, on: () => {}, render: () => {}, destroy: () => {} }),
                text: () => {},
                log: () => ({ log: () => {} })
            }
        })

        // StatusService: uses real logic but with stubbed Docker.
        // Override statusChanged to avoid lazy require of real HubService/ExplorerService
        const { setStatusUpdated } = require(path.join(ROOT, 'src/state'))
        const RealStatusService = proxyquire(path.join(ROOT, 'src/services/StatusService'), {
            '../config/constants': patchedConstants,
            './DockerService': DockerService,
            './VersionService': {
                checkRemoteNodeVersion: async () => true,
                getLocalNodeVersion: async () => '0.0.1',
                getContainerNodeVersion: async () => '0.0.1',
                getLocalModuleVersion: async () => '0.0.1',
                getContainerModuleVersion: async () => '0.0.1'
            },
            './ModuleService': {
                getModuleBranch: async () => 'master'
            }
        })
        const StatusService = Object.assign({}, RealStatusService, {
            statusChanged: async () => { setStatusUpdated(false) }
        })

        // HubConnector stub
        function StubHubConnector() {
            this.ping = async () => true
            this.updateConfig = async () => true
        }

        // ExplorerConnector stub
        function StubExplorerConnector() {
            this.ping = async () => true
            this.updateConfig = async () => true
        }

        // HubService
        const HubService = proxyquire(path.join(ROOT, 'src/services/HubService'), {
            '../config/constants': patchedConstants,
            './ConfigService': ConfigService,
            './StatusService': StatusService,
            './DockerService': DockerService,
            './ModuleService': {
                cloneGit: async () => true,
                buildAndUp: async () => TestEnv.fakeContainerId('hub')
            },
            '../HubConnector.js': StubHubConnector,
            '../ExplorerConnector.js': StubExplorerConnector
        })

        // ExplorerService
        const ExplorerService = proxyquire(path.join(ROOT, 'src/services/ExplorerService'), {
            '../config/constants': patchedConstants,
            './ConfigService': ConfigService,
            './StatusService': StatusService,
            './DockerService': DockerService,
            './ModuleService': {
                cloneGit: async () => true,
                buildAndUp: async () => TestEnv.fakeContainerId('exp')
            },
            '../HubConnector.js': StubHubConnector,
            '../ExplorerConnector.js': StubExplorerConnector
        })

        // DatabaseService pipes SQL to `docker exec -i ... mariadb` over STDIN
        // via spawn (secret-leak hardening: SQL and passwords stay out of argv),
        // so its child needs a writable stdin and a routed stdout+close. '0'
        // satisfies both consumers: the schema-count check (0 -> CREATE) and
        // generic command success.
        const dbSpawnStub = function (command, args, options) {
            const child = spawnStub(command, args, options)
            child.stdin = { on: () => {}, end: () => {} }
            process.nextTick(() => {
                child.stdout.emit('data', '0')
                child.emit('close', 0)
            })
            return child
        }

        // DbCredentialDrift runs `docker inspect` through its OWN require of
        // child_process, so DatabaseService's stub map does not reach it and the
        // guard reads whatever containers the HOST actually has. On a CI venue
        // carrying a container from another config store that is a real refusal,
        // which failed all five install-path E2E cases on test-host while passing on
        // a laptop with no such container . Stubbed at the same seam, so
        // the guard still runs, against this harness's containers.
        const DbCredentialDrift = proxyquire(path.join(ROOT, 'src/services/DbCredentialDrift'), {
            'child_process': { execFile: execFileStub },
            'util': { promisify: () => execFileAsyncStub }
        })

        // DatabaseService
        const DatabaseService = proxyquire(path.join(ROOT, 'src/services/DatabaseService'), {
            'child_process': { execFile: execFileStub, spawn: dbSpawnStub },
            'util': { promisify: () => execFileAsyncStub },
            './DbCredentialDrift': DbCredentialDrift,
            '../config/constants': patchedConstants,
            './ConfigService': ConfigService,
            './DockerService': DockerService,
            './StatusService': StatusService,
            'enquirer': {
                Password: function () {
                    this.run = async () => 'testrootpw'
                }
            }
        })

        // VersionService
        const VersionService = {
            checkAllRemoteVersions: async () => true,
            checkRemoteNodeVersion: async () => true,
            getLocalNodeVersion: async () => '0.0.1',
            getContainerNodeVersion: async () => '0.0.1',
            getLocalModuleVersion: async () => '0.0.1',
            getContainerModuleVersion: async () => '0.0.1'
        }

        // ModuleService: must also stub 'util' because getModuleBranch does
        // promisify(execFile) inline, and our execFile stub lacks the custom promisify symbol
        const ModuleService = proxyquire(path.join(ROOT, 'src/services/ModuleService'), {
            'child_process': { execFile: execFileStub },
            'util': { promisify: () => execFileAsyncStub },
            '../config/constants': patchedConstants,
            './ConfigService': ConfigService,
            './DockerService': DockerService,
            './StatusService': StatusService,
            './DatabaseService': DatabaseService,
            // Same seam as DatabaseService above: installModule now runs the drift
            // guard ahead of buildAndUp too, so an unstubbed copy would read the
            // HOST's containers and fail install cases on a venue .
            './DbCredentialDrift': DbCredentialDrift,
            './VersionService': VersionService,
            './NodeService': {
                buildCryptoNode: async () => true,
                getCryptoNode: async () => true
            },
            './ExplorerService': {
                installExplorerModule: async () => true
            }
        })

        // moduleOperations: the main entry point.
        // Must also stub 'util' because resetModules uses promisify(execFile) at top level
        const moduleOps = proxyquire(path.join(ROOT, 'src/operations/moduleOperations'), {
            'child_process': { execFile: execFileStub },
            'util': { promisify: () => execFileAsyncStub },
            'fs': Object.assign({}, require('fs'), { existsSync: () => false }),
            '../config/constants': patchedConstants,
            '../services/ConfigService': ConfigService,
            '../services/DockerService': DockerService,
            '../services/DatabaseService': DatabaseService,
            '../services/ModuleService': ModuleService,
            '../services/StatusService': StatusService
        })

        return {
            moduleOps,
            ModuleService,
            DockerService,
            ConfigService,
            DatabaseService,
            StatusService,
            HubService,
            ExplorerService
        }
    }
}

module.exports = E2EEnv
