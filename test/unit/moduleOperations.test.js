'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubs() {
    return {
        db: {
            getModuleContainer: sinon.stub().resolves('container-id-123'),
            removeModuleContainer: sinon.stub().resolves(true)
        },
        createDockerNetwork: sinon.stub().resolves(true),
        killContainer: sinon.stub().resolves(true),
        removeContainer: sinon.stub().resolves(true),
        forceRemoveContainerByName: sinon.stub().resolves(true),
        stopContainer: sinon.stub().resolves(true),
        startContainer: sinon.stub().resolves(true),
        restartContainer: sinon.stub().resolves(true),
        execContainer: sinon.stub().resolves('exec-output'),
        shellContainer: sinon.stub().resolves(true),
        logContainer: sinon.stub().resolves(true),
        startDockerMonitor: sinon.stub().resolves(true),
        waitContainer: sinon.stub().resolves(0),
        saveContainerLogs: sinon.stub().resolves(true),
        buildDatabaseModule: sinon.stub().resolves(true),
        resetDatabases: sinon.stub().resolves(true),
        cloneGit: sinon.stub().resolves(true),
        getModuleBranch: sinon.stub().resolves('master'),
        installModule: sinon.stub().resolves('new-container-id'),
        uninstallModule: sinon.stub().resolves(true),
        statusChanged: sinon.stub().resolves(),
        execFile: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(false)
        }
    }
}

function loadOperations(stubs) {
    return proxyquire('../../src/operations/moduleOperations', {
        '../config/constants': require('../../src/config/constants'),
        '../state': { db: stubs.db },
        '../services/ConfigService': {
            getDockerContainerImageName: (mod, coin, net) => `${coin}-${net}-${mod}`,
            filterCommandParameters: require('../../src/services/ConfigService').filterCommandParameters,
            getDockerNetwork: (coin, net) => 'xchain-node-' + coin + '-' + net
        },
        '../services/DockerService': {
            createDockerNetwork: stubs.createDockerNetwork,
            killContainer: stubs.killContainer,
            removeContainer: stubs.removeContainer,
            forceRemoveContainerByName: stubs.forceRemoveContainerByName,
            stopContainer: stubs.stopContainer,
            startContainer: stubs.startContainer,
            restartContainer: stubs.restartContainer,
            execContainer: stubs.execContainer,
            shellContainer: stubs.shellContainer,
            logContainer: stubs.logContainer,
            startDockerMonitor: stubs.startDockerMonitor,
            waitContainer: stubs.waitContainer,
            saveContainerLogs: stubs.saveContainerLogs
        },
        '../services/DatabaseService': {
            buildDatabaseModule: stubs.buildDatabaseModule,
            resetDatabases: stubs.resetDatabases
        },
        '../services/ModuleService': {
            cloneGit: stubs.cloneGit,
            getModuleBranch: stubs.getModuleBranch,
            installModule: stubs.installModule,
            uninstallModule: stubs.uninstallModule
        },
        '../services/StatusService': {
            statusChanged: stubs.statusChanged
        },
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs,
        'util': {
            promisify: (fn) => async (...args) => {
                // execFileAsync calls: resolve with empty stdout for docker run --rm
                return new Promise((resolve, reject) => {
                    fn(...args, (err, stdout, stderr) => {
                        if (err) reject(err)
                        else resolve(stdout || '')
                    })
                })
            }
        }
    })
}

describe('moduleOperations', function () {

    // -------------------------------------------------------------------
    // installModules
    // -------------------------------------------------------------------

    describe('installModules()', function () {

        it('creates Docker network for each coin/network pair', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { bitcoin: { mainnet: ['xchain-encoder'] } }
            await ops.installModules(servicesList)
            expect(stubs.createDockerNetwork.calledOnce).to.be.true
        })

        it('builds database before installing modules', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { bitcoin: { mainnet: ['xchain-encoder'] } }
            await ops.installModules(servicesList)
            expect(stubs.buildDatabaseModule.calledBefore(stubs.installModule)).to.be.true
        })

        it('calls installModule for each module in the list', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } }
            await ops.installModules(servicesList)
            expect(stubs.installModule.callCount).to.equal(2)
        })

        it('handles multiple coins and networks', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = {
                bitcoin: { mainnet: ['xchain-encoder'], testnet: ['xchain-encoder'] },
                dogecoin: { mainnet: ['xchain-encoder'] }
            }
            await ops.installModules(servicesList)
            expect(stubs.installModule.callCount).to.equal(3)
            expect(stubs.createDockerNetwork.callCount).to.equal(3)
        })

        it('skips network creation and database for shared services (empty coin/network)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { '': { '': ['xchain-explorer'] } }
            await ops.installModules(servicesList)
            expect(stubs.createDockerNetwork.called).to.be.false
            expect(stubs.buildDatabaseModule.called).to.be.false
            expect(stubs.installModule.calledOnce).to.be.true
        })

        it('returns true on success', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.installModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // updateModules
    // -------------------------------------------------------------------

    describe('updateModules()', function () {

        it('fetches existing container ID before updating', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.db.getModuleContainer.calledWith('xchain-encoder', 'bitcoin', 'mainnet')).to.be.true
        })

        it('rebuilds non-node modules via installModule (which re-clones internally)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.installModule.calledWith('xchain-encoder', 'bitcoin', 'mainnet', true)).to.be.true
        })

        it('handles the node module via installModule (built from releases, not git-cloned)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.be.true
        })

        it('passes container ID to installModule for replacement', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            const installCall = stubs.installModule.firstCall
            expect(installCall.args[4]).to.equal('container-id-123') // overwriteContainerId
        })

        it('tears down the existing node container by name before rebuilding', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            // getDockerContainerImageName stub renders as `${coin}-${net}-${mod}`
            expect(stubs.forceRemoveContainerByName.calledWith('bitcoin-mainnet-node')).to.be.true
            expect(stubs.forceRemoveContainerByName.calledBefore(stubs.installModule)).to.be.true
        })

        it('recreates the node even when its container is missing (no silent no-op)', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null) // node container crashed/removed
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true, null)).to.be.true
        })

        it('still skips a NON-node module whose container is missing', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.installModule.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // uninstallModules
    // -------------------------------------------------------------------

    describe('uninstallModules()', function () {

        it('calls uninstallModule for each module', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(stubs.uninstallModule.callCount).to.equal(2)
        })

        it('continues on error for individual modules', async function () {
            const stubs = makeStubs()
            stubs.uninstallModule.onFirstCall().rejects(new Error('fail'))
            stubs.uninstallModule.onSecondCall().resolves(true)
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(result).to.be.true
            expect(stubs.uninstallModule.callCount).to.equal(2)
        })

        it('returns true even when all modules fail', async function () {
            const stubs = makeStubs()
            stubs.uninstallModule.rejects(new Error('fail'))
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // startModules
    // -------------------------------------------------------------------

    describe('startModules()', function () {

        it('looks up container ID and calls startContainer', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.startModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.db.getModuleContainer.calledOnce).to.be.true
            expect(stubs.startContainer.calledWith('container-id-123')).to.be.true
        })

        it('skips module when container ID is not found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.startModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.startContainer.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // stopModules
    // -------------------------------------------------------------------

    describe('stopModules()', function () {

        it('looks up container ID and calls stopContainer', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.stopContainer.calledWith('container-id-123')).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // restartModules
    // -------------------------------------------------------------------

    describe('restartModules()', function () {

        it('calls restartContainer and statusChanged', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.restartModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.restartContainer.calledWith('container-id-123')).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // execModules
    // -------------------------------------------------------------------

    describe('execModules()', function () {

        it('passes command to execContainer', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.execModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'ls -la')
            expect(stubs.execContainer.calledWith('container-id-123', ['ls', '-la'])).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // shellModule
    // -------------------------------------------------------------------

    describe('shellModule()', function () {

        it('calls shellContainer for the first module only', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.shellModule({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(stubs.shellContainer.calledOnce).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // logModules
    // -------------------------------------------------------------------

    describe('logModules()', function () {

        it('calls logContainer with follow=true by default', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.logContainer.calledOnce).to.be.true
            expect(stubs.logContainer.firstCall.args[1]).to.be.true
        })

        it('passes follow=false when specified', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, false)
            expect(stubs.logContainer.firstCall.args[1]).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // monitorModules
    // -------------------------------------------------------------------

    describe('monitorModules()', function () {

        it('collects container IDs and passes to startDockerMonitor', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.monitorModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(stubs.startDockerMonitor.calledOnce).to.be.true
            const containerIds = stubs.startDockerMonitor.firstCall.args[0]
            expect(containerIds).to.have.length(2)
        })
    })

    // -------------------------------------------------------------------
    // shellModule — error path
    // -------------------------------------------------------------------

    describe('shellModule() — error path', function () {

        it('continues after shellContainer error and returns true', async function () {
            const stubs = makeStubs()
            stubs.shellContainer.rejects(new Error('shell failed'))
            const ops = loadOperations(stubs)
            const result = await ops.shellModule({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })

        it('returns true when no container found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.shellModule({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.shellContainer.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // updateModules — branch handling
    // -------------------------------------------------------------------

    describe('updateModules() — branch handling', function () {

        it('skips module when container ID is not found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.installModule.called).to.be.false
        })

        // The branch must reach installModule (7th arg) — installModule re-clones on the
        // remoteUpdate path, so a null branch there clobbers the requested branch with the
        // default. Regression for `update <svc> <chain> <net> <branch>` deploying master.
        it('threads the provided branch through to installModule', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'feature/test')
            expect(stubs.installModule.calledWith(
                'xchain-encoder', 'bitcoin', 'mainnet', true, 'container-id-123', false, 'feature/test'
            )).to.be.true
        })

        it('falls back to getModuleBranch (current branch) when no branch specified', async function () {
            const stubs = makeStubs()
            stubs.getModuleBranch.resolves('feature/existing')
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.getModuleBranch.calledOnce).to.be.true
            expect(stubs.installModule.calledWith(
                'xchain-encoder', 'bitcoin', 'mainnet', true, 'container-id-123', false, 'feature/existing'
            )).to.be.true
        })

        it('proceeds with null branch if getModuleBranch throws', async function () {
            const stubs = makeStubs()
            stubs.getModuleBranch.rejects(new Error('not a git repo'))
            const ops = loadOperations(stubs)
            const result = await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.installModule.calledWith(
                'xchain-encoder', 'bitcoin', 'mainnet', true, 'container-id-123', false, null
            )).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // uninstallModules — includeShared=true
    // -------------------------------------------------------------------

    describe('uninstallModules() — includeShared', function () {

        it('skips shared modules by default', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['database', 'xchain-encoder'] } })
            // database is in sharedModules → skipped
            // xchain-encoder is uninstalled
            expect(stubs.uninstallModule.callCount).to.equal(1)
            expect(stubs.uninstallModule.firstCall.args[2]).to.equal('xchain-encoder')
        })

        it('includes shared modules when includeShared=true', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['database', 'xchain-encoder'] } }, true)
            expect(stubs.uninstallModule.callCount).to.equal(2)
        })

        it('skips module when container ID is null', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.uninstallModule.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // runE2ETest
    // -------------------------------------------------------------------

    describe('runE2ETest()', function () {

        it('installs e2e module, waits, saves logs, removes container', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            stubs.waitContainer.resolves(0)
            const ops = loadOperations(stubs)
            const result = await ops.runE2ETest('bitcoin', 'mainnet')
            expect(stubs.installModule.calledOnce).to.be.true
            expect(stubs.waitContainer.calledWith('e2e-container-id')).to.be.true
            expect(stubs.saveContainerLogs.calledWith('e2e-container-id')).to.be.true
            expect(stubs.removeContainer.calledWith('e2e-container-id')).to.be.true
            expect(result.exitCode).to.equal(0)
            expect(result.logFile).to.be.a('string')
        })

        it('builds mocha docker args when testName is provided', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet', 'myTest', null)
            const installArgs = stubs.installModule.firstCall.args
            const dockerCmdArgs = installArgs[7]
            expect(dockerCmdArgs).to.include('mocha')
            expect(dockerCmdArgs.some(a => a.includes('myTest'))).to.be.true
        })

        it('includes --grep when grep is provided with testName', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet', 'myTest', 'my grep pattern')
            const dockerCmdArgs = stubs.installModule.firstCall.args[7]
            expect(dockerCmdArgs).to.include('--grep')
            expect(dockerCmdArgs).to.include('my grep pattern')
        })

        it('uses npm run script when script is provided', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet', null, null, 'test:sdk')
            const dockerCmdArgs = stubs.installModule.firstCall.args[7]
            expect(dockerCmdArgs).to.deep.equal(['npm', 'run', 'test:sdk'])
        })

        it('passes null dockerCmdArgs when no testName or script', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet')
            const dockerCmdArgs = stubs.installModule.firstCall.args[7]
            expect(dockerCmdArgs).to.be.null
        })
    })

    // -------------------------------------------------------------------
    // resetModules
    // -------------------------------------------------------------------

    describe('resetModules()', function () {

        it('resets all services when service=all', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('all', 'bitcoin', 'mainnet')
            await clock.tickAsync(6000) // advance past 5000ms bounce delay
            clock.restore()
            const result = await promise
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.true
            expect(stubs.startContainer.called).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
        })

        it('only resets node data when service=node', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('node', 'bitcoin', 'mainnet')
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.true
            // No bounce candidates for node-only reset
        })

        it('stops and resets utxo-tracker when service=xchain-utxo-tracker', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'mainnet')
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.true
        })

        it('resets decoder: stops, resets DB, and bounces', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet')
            await clock.tickAsync(6000)
            clock.restore()
            const result = await promise
            expect(result).to.be.true
            expect(stubs.resetDatabases.calledOnce).to.be.true
            expect(stubs.restartContainer.called).to.be.true // bounce
        })

        it('resets node data when nodeDataPath exists', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(true) // nodeDataPath exists
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('node', 'bitcoin', 'mainnet')
            expect(result).to.be.true
            // execFile called for docker run --rm to clear data
            expect(stubs.execFile.called).to.be.true
            const call = stubs.execFile.firstCall
            expect(call.args[0]).to.equal('docker')
        })

        it('continues when stopContainer throws', async function () {
            const stubs = makeStubs()
            stubs.stopContainer.rejects(new Error('stop failed'))
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('node', 'bitcoin', 'mainnet')
            expect(result).to.be.true // errors are caught/swallowed
        })
    })

    // -------------------------------------------------------------------
    // logModules — no containers case
    // -------------------------------------------------------------------

    describe('logModules() — no containers', function () {

        it('prints "No service was selected" when no containers found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null) // no containers
            const ops = loadOperations(stubs)
            const result = await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.logContainer.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // restartModules — error path
    // -------------------------------------------------------------------

    describe('restartModules() — error path', function () {

        it('continues after restartContainer error', async function () {
            const stubs = makeStubs()
            stubs.restartContainer.rejects(new Error('restart failed'))
            const ops = loadOperations(stubs)
            const result = await ops.restartModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // stopModules/startModules — skip when no container
    // -------------------------------------------------------------------

    describe('stopModules() — skip when no container', function () {

        it('skips when container ID is not found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.false
        })

        it('continues after stopContainer error', async function () {
            const stubs = makeStubs()
            stubs.stopContainer.rejects(new Error('stop failed'))
            const ops = loadOperations(stubs)
            const result = await ops.stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })
    })

    describe('startModules() — error path', function () {

        it('continues after startContainer error', async function () {
            const stubs = makeStubs()
            stubs.startContainer.rejects(new Error('start failed'))
            const ops = loadOperations(stubs)
            const result = await ops.startModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })
    })

    describe('execModules() — error path', function () {

        it('continues after execContainer error', async function () {
            const stubs = makeStubs()
            stubs.execContainer.rejects(new Error('exec failed'))
            const ops = loadOperations(stubs)
            const result = await ops.execModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'ls')
            expect(result).to.be.true
        })

        it('skips when container ID is null', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.execModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'ls')
            expect(result).to.be.true
            expect(stubs.execContainer.called).to.be.false
        })
    })
})
