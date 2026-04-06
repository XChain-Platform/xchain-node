'use strict'

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
        stopContainer: sinon.stub().resolves(true),
        startContainer: sinon.stub().resolves(true),
        restartContainer: sinon.stub().resolves(true),
        execContainer: sinon.stub().resolves('exec-output'),
        shellContainer: sinon.stub().resolves(true),
        logContainer: sinon.stub().resolves(true),
        startDockerMonitor: sinon.stub().resolves(true),
        buildDatabaseModule: sinon.stub().resolves(true),
        cloneGit: sinon.stub().resolves(true),
        installModule: sinon.stub().resolves('new-container-id'),
        uninstallModule: sinon.stub().resolves(true),
        statusChanged: sinon.stub().resolves()
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
            stopContainer: stubs.stopContainer,
            startContainer: stubs.startContainer,
            restartContainer: stubs.restartContainer,
            execContainer: stubs.execContainer,
            shellContainer: stubs.shellContainer,
            logContainer: stubs.logContainer,
            startDockerMonitor: stubs.startDockerMonitor
        },
        '../services/DatabaseService': {
            buildDatabaseModule: stubs.buildDatabaseModule
        },
        '../services/ModuleService': {
            cloneGit: stubs.cloneGit,
            installModule: stubs.installModule,
            uninstallModule: stubs.uninstallModule
        },
        '../services/StatusService': {
            statusChanged: stubs.statusChanged
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

        it('calls cloneGit with rewrite=true for non-node modules', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.cloneGit.calledWith('xchain-encoder', true, false)).to.be.true
        })

        it('does not call cloneGit for node module', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            expect(stubs.cloneGit.called).to.be.false
        })

        it('passes container ID to installModule for replacement', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            const installCall = stubs.installModule.firstCall
            expect(installCall.args[4]).to.equal('container-id-123') // overwriteContainerId
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
})
