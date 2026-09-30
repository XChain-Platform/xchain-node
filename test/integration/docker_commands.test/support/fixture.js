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

const fs = require('fs')
const proxyquire = require('proxyquire').noCallThru()
const { proxyquireDockerService } = require('../../../helpers/docker_service_loader')

const { configStub } = require('../../../helpers/config_stub')
const TestEnv        = require('../../helpers/test-env')
const CommandCapture = require('../../helpers/command-capture')

function configureCapture(capture) {
    const containerId = TestEnv.fakeContainerId('c')

    capture.when(/docker build/).returns({ stdout: '' })
    capture.when(/docker run/).returns({ stdout: containerId + '\n' })
    // Echo back the container ID from the command for kill/rm
    // so DockerService's stdout === containerId check passes
    const extractId = (cmd) => {
        const parts = cmd.trim().split(/\s+/)
        return { stdout: parts[parts.length - 1] }
    }
    capture.when(/docker (kill|stop)/).respondsWith(extractId)
    capture.when(/docker rm/).respondsWith(extractId)
    // `git clone` is mocked out (no real network/process runs), but
    // buildAndUp's LIBRARY_BUNDLES staging (ea43475) does a REAL
    // fs.cpSync from the cloned module's directory into the parent
    // module's build context (ModuleService.js buildAndUp, ~line 787).
    // Without this route the clone destination never materializes on
    // disk, and that cpSync throws ENOENT for every module that bundles
    // a library (xchain-indexer/xchain-explorer -> xchain-vm). This is a
    // test-fixture gap, not a source defect: materialize an empty
    // placeholder directory so the real copy has something to read.
    capture.when(/git clone/).respondsWith((cmd) => {
        const parts = cmd.trim().split(/\s+/)
        const destination = parts[parts.length - 1]
        fs.mkdirSync(destination, { recursive: true })
        return { stdout: '' }
    })

    return containerId
}

function makePatchedDockerService(capture) {
    const execFileStub = capture.createExecFileStub()
    const execFileAsyncStub = capture.createExecFileAsyncStub()

    const PatchedDockerService = proxyquireDockerService(require.resolve('../../../../src/services/docker_service'), {
        'child_process': {
            execFile: execFileStub,
            spawn: capture.createSpawnStub(),
            spawnSync: capture.createSpawnSyncStub()
        },
        'util': { promisify: () => execFileAsyncStub },
        'blessed': {
            screen: () => ({ key: () => {}, on: () => {}, render: () => {}, destroy: () => {} }),
            text: () => {},
            log: () => ({ log: () => {} })
        }
    })

    return { PatchedDockerService, execFileStub, execFileAsyncStub }
}

/**
 * Creates a ModuleService with:
 * - Patched ConfigService (using env temp dirs for configDir/moduleDir)
 * - Stubbed child_process (via capture)
 * - Stubbed StatusService and DatabaseService
 * - Real config generation logic
 */
function makeBuildAndUp(env, capture) {
    const containerId = configureCapture(capture)
    const patchedConstants = configStub({
        configDir: env.configDir,
        moduleDir: env.moduleDir,
        dataDir: env.dataDir
    })

    const PatchedConfigService = proxyquire('../../../../src/services/config_service', {
        '../config/index': patchedConstants
    })
    const { PatchedDockerService, execFileStub, execFileAsyncStub } = makePatchedDockerService(capture)

    const ModuleService = proxyquire('../../../../src/services/module_service', {
        'child_process': { execFile: execFileStub },
        'util': { promisify: () => execFileAsyncStub },
        '../config/index': patchedConstants,
        './config_service': PatchedConfigService,
        './docker_service': PatchedDockerService,
        './status_service': {
            statusChanged: async () => true,
            getStatus: async () => ({})
        },
        './database_service': {
            setDatabaseParameters: async () => true
        }
    })

    return { ModuleService, containerId }
}

function dockerSuite(title, registerTests) {
    let env, capture

    describe('Integration: Docker Command Construction', function () {
        this.timeout(15000)

        beforeEach(async function () {
            env = new TestEnv()
            await env.setup()
            capture = new CommandCapture()
        })

        afterEach(async function () {
            await env.teardown()
        })

        describe(title, function () {
            registerTests(() => ({
                env,
                capture,
                fakeContainerId: TestEnv.fakeContainerId,
                makeBuildAndUp: () => makeBuildAndUp(env, capture)
            }))
        })
    })
}

module.exports = { dockerSuite }
