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
 // Every host-reaching seam the install path hit, in call order (see
 // sealLazyRequireSeams). Empty after an install means the seals are not
 // wired and the real implementations ran against the host instead.
 this.hostSeamCalls = []
 this._sealedSeams = []
    }

    async setup() {
        await super.setup()
        this.capture = new CommandCapture()
        this.http = new HttpCapture()
 this.hostSeamCalls = []
 this.sealBootstrapSeam()
        return this
    }

 /**
 * Replace `names` on an already-loaded service's exports object for the
 * lifetime of this env, recording every call on hostSeamCalls.
 *
 * WHY this and not another proxyquire stub map: the install path reaches
 * several services through a `require` evaluated at CALL time, and
 * proxyquire only intercepts requires made while the proxied module is
 * being LOADED. Every runtime require therefore resolves to the real
 * singleton no matter what createCLI() passes, and a "fully stubbed"
 * install ends up talking to the host. Patching the exports object closes
 * exactly those seams while leaving module identity, and every other
 * function on the module, alone.
 */
 _sealSeam(modulePath, replacements) {
 const self = this
 const target = require(path.join(ROOT, modulePath))
 const saved = {}
 for (const [name, impl] of Object.entries(replacements)) {
 saved[name] = target[name]
 target[name] = function (...args) {
 self.hostSeamCalls.push({ module: path.basename(modulePath), name, args })
 return impl.apply(this, args)
 }
 }
 this._sealedSeams.push({ target, saved })
 return target
 }

 /**
 * BootstrapService is required at call time by installModule and by
 * moduleOperations, so the real module runs with the real ConfigService,
 * DockerService and DatabaseService behind it: a stubbed install issued
 * `docker inspect`/`docker exec` against whatever containers the HOST has
 * (a venue carrying a resident regtest stack answers with real ones) and
 * fetched https://sync.xchain.io over the network, which is the unbounded
 * latency that pushed a random case in this suite past the mocha ceiling.
 *
 * The freshness answers stay the ones a real fresh install would get, so
 * the install still walks its restore branch; only the restore itself is
 * a no-op.
 */
 sealBootstrapSeam() {
 const BootstrapService = require(path.join(ROOT, 'src/services/BootstrapService'))
 this._sealSeam('src/services/BootstrapService', {
 utxoTrackerVolumeFreshness: async () => BootstrapService.FRESHNESS_EMPTY,
 mariaDbModuleFreshness: async () => BootstrapService.FRESHNESS_EMPTY,
 ensureBootstrapUtxoTracker: async () => false,
 ensureBootstrapMariaDb: async () => false,
 downloadBootstrap: async () => null
 })
 }

 /**
 * The two remaining call-time seams, sealed once createCLI() has built the
 * patched ConfigService they have to answer from:
 *
 * - ConfigService.dbPasswordCanRotate runtime-requires DatabaseService,
 * whose getDatabaseContainerId runs `docker inspect` on the host. A box
 * with a resident xchain-node-database answers yes and the install mints
 * generated credentials; a box without one answers no and it uses the
 * static defaults. Answer from the harness's own docker routes instead,
 * which present a database container on every venue.
 * - StatusService.probeServiceHealthPayload runtime-requires
 * child_process AND the real ConfigService, then `docker exec`s wget
 * into the container. Against the host that reads the resident stack's
 * config file and probes its live services. Sealed at
 * BootstrapHealthGate.probeServiceStatus, which is the one function that
 * reaches the container, and it raises the same "no status probe
 * succeeded" a container-less venue raises.
 */
 sealLazyRequireSeams(patchedConfigService) {
 const dbContainerId = 'd'.repeat(64)
 this._sealSeam('src/services/DatabaseService', {
 getDatabaseContainerId: async () => dbContainerId
 })
 this._sealSeam('src/services/BootstrapHealthGate', {
 probeServiceStatus: async () => { throw new Error('no status probe succeeded') }
 })
 // getDefaultConfig is the one real-ConfigService read those seams (and
 // any other call-time require of it) make; point it at the copy wired
 // to this env's temp config dir so no venue's config file is read.
 this._sealSeam('src/services/ConfigService', {
 getDefaultConfig: (...args) => patchedConfigService.getDefaultConfig(...args)
 })
 }

 /**
 * Names of the host-reaching seams this install hit, as "Module.fn",
 * deduplicated and in first-call order.
 */
 hostSeamCallNames() {
 return [...new Set(this.hostSeamCalls.map(c => `${c.module.replace(/\.js$/, '')}.${c.name}`))]
 }

 restoreHostSeams() {
 for (const { target, saved } of this._sealedSeams.reverse()) {
 for (const [name, fn] of Object.entries(saved)) target[name] = fn
 }
 this._sealedSeams = []
 }

 async teardown() {
 this.restoreHostSeams()
 return super.teardown()
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
        // only once git reports success, so a route that produced no
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

 // Must happen before the first install: these seals are what keeps the
 // call-time requires below from reaching the host's docker and config.
 this.sealLazyRequireSeams(ConfigService)

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
        // which failed all five install-path E2E cases there while passing on
        // a laptop with no such container. Stubbed at the same seam, so
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
            // HOST's containers and fail install cases on a venue.
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
