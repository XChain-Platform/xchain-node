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
const { proxyquireDockerService } = require('../../helpers/docker_service_loader')
const path       = require('path')

const E2EEnv = require('../helpers/e2e-env')
const TestEnv = require('../../integration/helpers/test-env')
const CommandCapture = require('../../integration/helpers/command-capture')
const { filterCommandParameters } = require('../../../src/services/config_service')

const ROOT = path.join(__dirname, '../../..')

let env, cli

async function setupEnv() {
    env = new E2EEnv()
    await env.setup()

    const state = require('../../../src/state')
    state.setDbRootPassword('testrootpw')
}

async function teardownEnv() {
    await env.teardown()
}

describe('E2E: Error Handling (Scenario 4.10)', function () {
    this.timeout(30000)
    beforeEach(setupEnv)
    afterEach(teardownEnv)

    // E2E-060: Docker unreachable
    describe('E2E-060: Docker unreachable during precheck', function () {

        it('throws descriptive error when docker --version fails', async function () {
            const capture = new CommandCapture()
            capture.when(/docker --version/).returns({
                error: new Error('command not found'),
                stdout: '', stderr: ''
            })

            const patchedConstants = Object.assign({}, require(path.join(ROOT, 'src/config/index')), {
                configDir: env.configDir,
                moduleDir: env.moduleDir,
                dataDir: env.dataDir,
                tmpDir: path.join(env.tmpDir, 'tmp'),
                containersFilesDir: path.join(env.tmpDir, 'tmp', 'containers_files')
            })

            const DockerService = proxyquireDockerService(path.join(ROOT, 'src/services/docker_service'), {
                'child_process': {
                    execFile: capture.createExecFileStub(),
                    spawn: capture.createSpawnStub(),
                    spawnSync: capture.createSpawnSyncStub()
                },
                'util': { promisify: () => capture.createExecFileAsyncStub() },
                '../config/index': patchedConstants,
                'blessed': {
                    screen: () => ({ key: () => {}, on: () => {}, render: () => {}, destroy: () => {} }),
                    text: () => {},
                    log: () => ({ log: () => {} })
                }
            })

            const precheck = proxyquire(path.join(ROOT, 'src/precheck'), {
                './config/index': patchedConstants,
                './services/docker_service': DockerService,
                './services/config_service': { getDockerNetwork: () => 'xchain-node' },
                './services/version_service': { checkAllRemoteVersions: async () => true },
                './services/status_service': { getStatus: async () => ({}) },
                './services/hub_service': { installHubModule: async () => true, updateHub: async () => true },
                './services/explorer_service': { updateExplorer: async () => true }
            })

            try {
                await precheck.preCheck(false)
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Docker is not installed or is unreachable')
            }
        })
    })
})

describe('E2E: Error Handling (Scenario 4.10)', function () {
    this.timeout(30000)
    beforeEach(setupEnv)
    afterEach(teardownEnv)
    // E2E-061: Docker build failure
    describe('E2E-061: Docker run failure leaves no LevelDB entry', function () {

        it('no container ID stored when docker run fails', async function () {
            env.setupDefaultRoutes()
            env.setupFullStack('bitcoin', 'regtest')

            env.capture._routes = env.capture._routes.filter(r => {
                if (r.pattern instanceof RegExp) return !r.pattern.test('docker run -d')
                return true
            })
            env.capture.when(/docker run/).returns({
                error: new Error('Error: container failed to start'),
                stdout: '', stderr: 'Error'
            })

            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'regtest')

            try {
                await cli.moduleOps.installModules(serviceList, 'master')
            } catch {
                // Expected to fail
            }

            // No container ID should be in LevelDB for the encoder
            const encoderEntry = await env.getModule('xchain-encoder', 'bitcoin', 'regtest')
            expect(encoderEntry).to.be.null
        })
    })
})

describe('E2E: Error Handling (Scenario 4.10)', function () {
    this.timeout(30000)
    beforeEach(setupEnv)
    afterEach(teardownEnv)
    // E2E-062: Missing module directory
    describe('E2E-062: Missing module directory', function () {

        it('buildAndUp throws "module not found" when module dir missing', async function () {
            env.setupDefaultRoutes()
            // Do NOT call setupFullStack; no fake modules created
            env.writeConfigFile('bitcoin-regtest', '')

            cli = env.createCLI()

            try {
                await cli.ModuleService.buildAndUp('xchain-encoder', 'bitcoin', 'regtest')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err).to.equal('module not found')
            }
        })
    })
})

describe('E2E: Error Handling (Scenario 4.10)', function () {
    this.timeout(30000)
    beforeEach(setupEnv)
    afterEach(teardownEnv)
    // E2E-063: Git clone failure
    describe('E2E-063: Git clone failure propagates error', function () {

        it('cloneGit propagates git clone error', async function () {
            env.setupDefaultRoutes()
            env.writeConfigFile('bitcoin-regtest', '')

            // Override git clone to fail
            // Override: docker run fails (after build succeeds)
            env.capture._routes = env.capture._routes.filter(r => {
                if (r.pattern instanceof RegExp) return !r.pattern.test('git clone')
                return true
            })
            env.capture.when(/git clone/).returns({
                error: new Error('Repository not found'),
                stdout: '', stderr: 'fatal: repository not found'
            })

            cli = env.createCLI()

            try {
                await cli.ModuleService.cloneGit('xchain-encoder', false, false, 'master')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err).to.include('Error cloning project')
            }
        })
    })
})

describe('E2E: Error Handling (Scenario 4.10)', function () {
    this.timeout(30000)
    beforeEach(setupEnv)
    afterEach(teardownEnv)
    // E2E-064: Start with no installed modules
    describe('E2E-064: Start with empty LevelDB', function () {

        it('startModules succeeds gracefully with no installed modules', async function () {
            env.setupDefaultRoutes()
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            const result = await cli.moduleOps.startModules(serviceList)
            expect(result).to.be.true

            // No docker start commands should have been issued
            const startCmds = env.capture.findCommands(/docker start/)
            expect(startCmds).to.have.lengthOf(0)
        })
    })
})

describe('E2E: Error Handling (Scenario 4.10)', function () {
    this.timeout(30000)
    beforeEach(setupEnv)
    afterEach(teardownEnv)
    // E2E-065: Stop with no installed modules
    describe('E2E-065: Stop with empty LevelDB', function () {

        it('stopModules succeeds gracefully with no installed modules', async function () {
            env.setupDefaultRoutes()
            cli = env.createCLI()

            const serviceList = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            const result = await cli.moduleOps.stopModules(serviceList)
            expect(result).to.be.true

            const stopCmds = env.capture.findCommands(/docker stop/)
            expect(stopCmds).to.have.lengthOf(0)
        })
    })
})
