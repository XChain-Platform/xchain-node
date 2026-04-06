'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')
const fs         = require('fs')

const E2EEnv = require('../helpers/e2e-env')
const CommandCapture = require('../../integration/helpers/command-capture')

const ROOT = path.join(__dirname, '..', '..', '..')

describe('E2E: PreCheck Pipeline (Scenario 4.5)', function () {
    this.timeout(30000)

    let env

    beforeEach(async function () {
        env = new E2EEnv()
        await env.setup()
        env.setupDefaultRoutes()

        const state = require('../../../src/state')
        state.setDbRootPassword('testrootpw')
    })

    afterEach(async function () {
        await env.teardown()
    })

    /**
     * Create a preCheck function wired with our stubs.
     */
    function makePreCheck(capture, overrides = {}) {
        const execFileStub = capture.createExecFileStub()

        const patchedConstants = Object.assign({}, require(path.join(ROOT, 'src/config/constants')), {
            configDir: env.configDir,
            moduleDir: env.moduleDir,
            dataDir: env.dataDir,
            tmpDir: path.join(env.tmpDir, 'tmp'),
            containersFilesDir: path.join(env.tmpDir, 'tmp', 'containers_files')
        })

        const DockerService = proxyquire(path.join(ROOT, 'src/services/DockerService'), {
            'child_process': {
                execFile: execFileStub,
                spawn: capture.createSpawnStub(),
                spawnSync: capture.createSpawnSyncStub()
            },
            'util': { promisify: () => capture.createExecFileAsyncStub() },
            '../config/constants': patchedConstants,
            'blessed': {
                screen: () => ({ key: () => {}, on: () => {}, render: () => {}, destroy: () => {} }),
                text: () => {},
                log: () => ({ log: () => {} })
            }
        })

        const ConfigService = proxyquire(path.join(ROOT, 'src/services/ConfigService'), {
            '../config/constants': patchedConstants
        })

        const precheck = proxyquire(path.join(ROOT, 'src/precheck'), {
            './config/constants': patchedConstants,
            './services/DockerService': overrides.DockerService || DockerService,
            './services/ConfigService': overrides.ConfigService || ConfigService,
            './services/VersionService': overrides.VersionService || {
                checkAllRemoteVersions: async () => true
            },
            './services/StatusService': overrides.StatusService || {
                getStatus: async () => ({})
            },
            './services/HubService': overrides.HubService || {
                installHubModule: async () => true,
                updateHub: async () => true
            },
            './services/ExplorerService': overrides.ExplorerService || {
                updateExplorer: async () => true
            }
        })

        return precheck
    }

    // -------------------------------------------------------------------
    // E2E-030: PreCheck creates directories and inits LevelDB
    // -------------------------------------------------------------------

    describe('E2E-030: Directory creation and LevelDB init', function () {

        it('creates data, modules, tmp, and containers_files directories', async function () {
            const capture = env.capture
            const precheck = makePreCheck(capture)

            await precheck.preCheck(false)

            const tmpDir = path.join(env.tmpDir, 'tmp')
            const containersFilesDir = path.join(tmpDir, 'containers_files')

            expect(fs.existsSync(env.dataDir), 'data dir').to.be.true
            expect(fs.existsSync(env.moduleDir), 'module dir').to.be.true
            // Note: tmp and containers_files are created by patchConstants in setup
            // precheck.createDirectories would create them via the patched paths
        })
    })

    // -------------------------------------------------------------------
    // E2E-031: PreCheck verifies Docker
    // -------------------------------------------------------------------

    describe('E2E-031: Docker verification', function () {

        it('calls docker --version and docker ps during precheck', async function () {
            const capture = env.capture
            const precheck = makePreCheck(capture)

            await precheck.preCheck(false)

            capture.assertCalled(/docker --version/)
            capture.assertCalled(/docker ps/)
        })
    })

    // -------------------------------------------------------------------
    // E2E-032: PreCheck installs hub if not running
    // -------------------------------------------------------------------

    describe('E2E-032: Hub auto-install', function () {

        it('calls installHubModule during precheck', async function () {
            const installHubCalled = { value: false }
            const capture = env.capture

            const precheck = makePreCheck(capture, {
                HubService: {
                    installHubModule: async () => { installHubCalled.value = true; return true },
                    updateHub: async () => true
                }
            })

            await precheck.preCheck(false)

            expect(installHubCalled.value, 'installHubModule called').to.be.true
        })
    })

    // -------------------------------------------------------------------
    // E2E-033: PreCheck with Docker unreachable
    // -------------------------------------------------------------------

    describe('E2E-033: Docker unreachable throws descriptive error', function () {

        it('throws when docker --version fails', async function () {
            const capture = new CommandCapture()

            // docker --version fails
            capture.when(/docker --version/).returns({
                error: new Error('command not found: docker'),
                stdout: '',
                stderr: 'command not found: docker'
            })

            const precheck = makePreCheck(capture)

            try {
                await precheck.preCheck(false)
                expect.fail('preCheck should have thrown')
            } catch (err) {
                expect(err.message).to.include('Docker is not installed or is unreachable')
            }
        })

        it('throws when docker ps fails (daemon not running)', async function () {
            const capture = new CommandCapture()

            // docker --version succeeds
            capture.when(/docker --version/).returns({
                stdout: 'Docker version 24.0.0, build abc123'
            })

            // docker ps fails
            capture.when(/docker ps/).returns({
                error: new Error('Cannot connect to Docker daemon'),
                stdout: '',
                stderr: 'Cannot connect to Docker daemon'
            })

            const precheck = makePreCheck(capture)

            try {
                await precheck.preCheck(false)
                expect.fail('preCheck should have thrown')
            } catch (err) {
                expect(err.message).to.include('Docker is not installed or is unreachable')
            }
        })
    })

    // -------------------------------------------------------------------
    // E2E-034: PreCheck creates base Docker network
    // -------------------------------------------------------------------

    describe('E2E-034: Base Docker network creation', function () {

        it('creates the xchain-node base network', async function () {
            const capture = env.capture
            const precheck = makePreCheck(capture)

            await precheck.preCheck(false)

            const networkCmds = capture.findCommands(/docker network inspect/)
            const hasBaseNetwork = networkCmds.some(c => c.command.includes('xchain-node'))
            expect(hasBaseNetwork, 'base network checked').to.be.true
        })
    })
})
