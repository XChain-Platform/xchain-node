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

function loadModuleOperations(stubs) {
    return proxyquire('../../../src/operations/module_operations', {
        '../config/index': require('../../../src/config'),
        '../state': {
            db: stubs.db
        },
        '../services/config_service': {
            getDockerContainerImageName: (m, c, n) => `xchain-node-${c}-${n}-${m}`,
            filterCommandParameters: require('../../../src/services/config_service').filterCommandParameters,
            getDockerNetwork: (c, n) => `xchain-node-${c}-${n}`
        },
        '../services/docker_service': {
            createDockerNetwork: sinon.stub().resolves(true),
            killContainer: sinon.stub().resolves(true),
            removeContainer: stubs.removeContainer || sinon.stub().resolves(true),
            stopContainer: sinon.stub().resolves(true),
            startContainer: sinon.stub().resolves(true),
            restartContainer: sinon.stub().resolves(true),
            execContainer: sinon.stub().resolves(''),
            shellContainer: sinon.stub().resolves(true),
            logContainer: sinon.stub().resolves(true),
            startDockerMonitor: sinon.stub().resolves(true),
            waitContainer: stubs.waitContainer || sinon.stub().resolves(0),
            saveContainerLogs: stubs.saveContainerLogs || sinon.stub().resolves(true)
        },
        '../services/database_service': {
            buildDatabaseModule: sinon.stub().resolves(true),
            resetDatabases: sinon.stub().resolves(true)
        },
        '../services/module_service': {
            cloneGit: sinon.stub().resolves(true),
            getModuleBranch: sinon.stub().resolves('master'),
            installModule: stubs.installModule || sinon.stub().resolves('a'.repeat(64)),
            uninstallModule: sinon.stub().resolves(true)
        },
        '../services/status_service': {
            statusChanged: sinon.stub().resolves()
        }
    })
}

function describeBoundaryTests(title, defineTests) {
    describe('Boundary Tests', function () {
        afterEach(function () {
            sinon.restore()
        })

        describe(title, defineTests)
    })
}

// 6. Grep/testName escaping (Fix 5)
describeBoundaryTests('moduleOperations: grep/testName handling', function () {
    it('passes grep pattern as separate array element', async function () {
        let capturedDockerCmdArgs = null
        const stubs = {
            db: { getModuleContainer: sinon.stub().resolves('abc123') },
            waitContainer: sinon.stub().resolves(0),
            saveContainerLogs: sinon.stub().resolves(true),
            removeContainer: sinon.stub().resolves(true),
            installModule: sinon.stub().callsFake((mod, coin, net, remoteUpdate, overwrite, onlyExec, branch, dockerCmdArgs) => {
                capturedDockerCmdArgs = dockerCmdArgs
                return Promise.resolve('a'.repeat(64))
            })
        }

        const ops = loadModuleOperations(stubs)
        await ops.runE2ETest('bitcoin', 'regtest', 'order', 'test "injection"')

        expect(capturedDockerCmdArgs).to.include('--grep')
        expect(capturedDockerCmdArgs).to.include('test "injection"')
    })

    it('passes backslashes in grep pattern unescaped', async function () {
        let capturedDockerCmdArgs = null
        const stubs = {
            db: { getModuleContainer: sinon.stub().resolves('abc123') },
            waitContainer: sinon.stub().resolves(0),
            saveContainerLogs: sinon.stub().resolves(true),
            removeContainer: sinon.stub().resolves(true),
            installModule: sinon.stub().callsFake((mod, coin, net, remoteUpdate, overwrite, onlyExec, branch, dockerCmdArgs) => {
                capturedDockerCmdArgs = dockerCmdArgs
                return Promise.resolve('a'.repeat(64))
            })
        }

        const ops = loadModuleOperations(stubs)
        await ops.runE2ETest('bitcoin', 'regtest', 'order', 'path\\test')

        expect(capturedDockerCmdArgs).to.include('--grep')
        expect(capturedDockerCmdArgs).to.include('path\\test')
    })
})
describeBoundaryTests('moduleOperations: grep/testName handling', function () {
    it('includes testName in file path array element', async function () {
        let capturedDockerCmdArgs = null
        const stubs = {
            db: { getModuleContainer: sinon.stub().resolves('abc123') },
            waitContainer: sinon.stub().resolves(0),
            saveContainerLogs: sinon.stub().resolves(true),
            removeContainer: sinon.stub().resolves(true),
            installModule: sinon.stub().callsFake((mod, coin, net, remoteUpdate, overwrite, onlyExec, branch, dockerCmdArgs) => {
                capturedDockerCmdArgs = dockerCmdArgs
                return Promise.resolve('a'.repeat(64))
            })
        }

        const ops = loadModuleOperations(stubs)
        await ops.runE2ETest('bitcoin', 'regtest', 'test"name', null)

        expect(capturedDockerCmdArgs.some(a => a.includes('test"name.test.js'))).to.be.true
    })

    it('handles null grep and null testName', async function () {
        let capturedDockerCmdArgs = null
        const stubs = {
            db: { getModuleContainer: sinon.stub().resolves('abc123') },
            waitContainer: sinon.stub().resolves(0),
            saveContainerLogs: sinon.stub().resolves(true),
            removeContainer: sinon.stub().resolves(true),
            installModule: sinon.stub().callsFake((mod, coin, net, remoteUpdate, overwrite, onlyExec, branch, dockerCmdArgs) => {
                capturedDockerCmdArgs = dockerCmdArgs
                return Promise.resolve('a'.repeat(64))
            })
        }

        const ops = loadModuleOperations(stubs)
        await ops.runE2ETest('bitcoin', 'regtest', null, null)

        // dockerCmdArgs is null when testName is null, so grep is not appended
        expect(capturedDockerCmdArgs).to.be.null
    })
})

describeBoundaryTests('moduleOperations: grep/testName handling', function () {
    it('does not add --grep when testName is null even if grep is set', async function () {
        let capturedDockerCmdArgs = null
        const stubs = {
            db: { getModuleContainer: sinon.stub().resolves('abc123') },
            waitContainer: sinon.stub().resolves(0),
            saveContainerLogs: sinon.stub().resolves(true),
            removeContainer: sinon.stub().resolves(true),
            installModule: sinon.stub().callsFake((mod, coin, net, remoteUpdate, overwrite, onlyExec, branch, dockerCmdArgs) => {
                capturedDockerCmdArgs = dockerCmdArgs
                return Promise.resolve('a'.repeat(64))
            })
        }

        const ops = loadModuleOperations(stubs)
        await ops.runE2ETest('bitcoin', 'regtest', null, 'some pattern')

        expect(capturedDockerCmdArgs).to.be.null
    })
})
