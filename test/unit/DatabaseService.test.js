'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubs() {
    return {
        exec: sinon.stub(),
        execAsync: sinon.stub(),
        db: {
            getModuleContainer: sinon.stub().resolves('db-container-id'),
            insertModuleContainer: sinon.stub().resolves(true)
        },
        getDbRootPassword: sinon.stub().returns('rootpass'),
        setDbRootPassword: sinon.stub(),
        statusChanged: sinon.stub().resolves(),
        getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } }),
        addContainerToNetwork: sinon.stub().resolves(true),
        getDockerNetworkInspect: sinon.stub().resolves({
            IPAM: { Config: [{ Gateway: '172.18.0.1' }] }
        })
    }
}

function loadDatabaseService(stubs) {
    return proxyquire('../../src/services/DatabaseService', {
        'child_process': { exec: stubs.exec },
        'util': { promisify: () => stubs.execAsync },
        'mariadb': {},
        'enquirer': { Password: class { run() { return Promise.resolve('rootpass') } } },
        '../state': {
            db: stubs.db,
            getDbRootPassword: stubs.getDbRootPassword,
            setDbRootPassword: stubs.setDbRootPassword
        },
        '../utils/helpers': { sleep: sinon.stub().resolves() },
        './ConfigService': {
            getDefaultConfig: sinon.stub().resolves({
                'DB_PORT': 3306,
                'HUB_PORT': 10000,
                'DECODER_DB_NAME': 'XChain_BTC_Mainnet_Decoder',
                'DECODER_DB_USER': 'xchain_decoder_bitcoin_mainnet',
                'DECODER_DB_PASS': 'xchain-password'
            }),
            getDockerContainerImageName: (mod) => 'xchain-node-' + mod,
            getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : '')
        },
        './DockerService': {
            getStatusFromContainer: stubs.getStatusFromContainer,
            getDockerNetworkInspect: stubs.getDockerNetworkInspect,
            addContainerToNetwork: stubs.addContainerToNetwork
        },
        './StatusService': {
            statusChanged: stubs.statusChanged,
            getInstalledCoinsAndNetworks: sinon.stub().resolves({ bitcoin: ['mainnet'] })
        }
    })
}

describe('DatabaseService', function () {

    // -------------------------------------------------------------------
    // checkIfDatabaseModuleExists
    // -------------------------------------------------------------------

    describe('checkIfDatabaseModuleExists()', function () {

        it('returns container ID when database container exists and is valid', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseModuleExists('bitcoin', 'mainnet')
            expect(result).to.equal('db-container-id')
        })

        it('returns null when container does not have State.Status', async function () {
            const stubs = makeStubs()
            stubs.getStatusFromContainer.resolves({})
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseModuleExists('bitcoin', 'mainnet')
            expect(result).to.be.null
        })

        it('returns null when getModuleContainer throws', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.rejects(new Error('not found'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseModuleExists('bitcoin', 'mainnet')
            expect(result).to.be.null
        })
    })

    // -------------------------------------------------------------------
    // executeDockerMariaDbCommand
    // -------------------------------------------------------------------

    describe('executeDockerMariaDbCommand()', function () {

        it('constructs correct docker exec command', async function () {
            const stubs = makeStubs()
            stubs.exec.callsFake((cmd, cb) => {
                expect(cmd).to.include('docker exec -i db-container mariadb -u root -prootpass -e "SELECT 1"')
                cb(null, '1\n')
            })
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT 1')
            expect(result).to.equal('1')
        })

        it('appends commandOptions when provided', async function () {
            const stubs = makeStubs()
            stubs.exec.callsFake((cmd, cb) => {
                expect(cmd).to.include('-B -N')
                cb(null, '0\n')
            })
            const ds = loadDatabaseService(stubs)
            await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT COUNT(*)', '-B -N')
        })

        it('rejects on exec error', async function () {
            const stubs = makeStubs()
            stubs.exec.callsFake((cmd, cb) => cb(new Error('db error')))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT 1')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
    })

    // -------------------------------------------------------------------
    // buildDatabaseModule
    // -------------------------------------------------------------------

    describe('buildDatabaseModule()', function () {

        it('skips installation when database already exists and connects to network', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            const result = await ds.buildDatabaseModule('bitcoin', 'mainnet')
            expect(result).to.be.true
            expect(stubs.addContainerToNetwork.calledOnce).to.be.true
        })

        it('installs mariadb when no existing database found', async function () {
            const stubs = makeStubs()
            // First call for checkIfDatabaseModuleExists, second for operations
            stubs.db.getModuleContainer.onFirstCall().rejects(new Error('not found'))
            stubs.db.getModuleContainer.onSecondCall().resolves(null)
            stubs.execAsync.resolves({ stdout: 'a'.repeat(64) + '\n' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.buildDatabaseModule('bitcoin', 'mainnet')
            // Should call execAsync for docker pull, tag, and run
            expect(stubs.execAsync.called).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // checkIfDatabaseIsReady
    // -------------------------------------------------------------------

    describe('checkIfDatabaseIsReady()', function () {

        it('returns true when database responds', async function () {
            const stubs = makeStubs()
            stubs.execAsync.resolves({ stdout: 'OK' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseIsReady('root', 'rootpass')
            expect(result).to.be.true
        })

        it('retries up to 10 times then returns false', async function () {
            const stubs = makeStubs()
            stubs.execAsync.rejects(new Error('connection refused'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseIsReady('root', 'badpass')
            expect(result).to.be.false
        })
    })
})
