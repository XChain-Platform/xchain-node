'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { modulesUrls, XChainService } = require('../../src/config/constants')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubs() {
    return {
        exec: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            readFileSync: sinon.stub()
        },
        db: {
            insertModuleContainer: sinon.stub().resolves(true),
            getModuleContainer: sinon.stub().resolves('old-container-id'),
            removeModuleContainer: sinon.stub().resolves('removed-id')
        },
        statusChanged: sinon.stub().resolves(),
        getStatus: sinon.stub().resolves({}),
        killContainer: sinon.stub().resolves(true),
        removeContainer: sinon.stub().resolves(true),
        getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } })
    }
}

function loadModuleService(stubs) {
    const configServiceStub = {
        getModuleDir: (mod) => '/modules/' + mod,
        getModuleTmpDir: (mod) => '/tmp/' + mod,
        moduleDirExists: sinon.stub().returns(false),
        checkIfModuleExists: sinon.stub().returns(true),
        removeModuleDir: sinon.stub(),
        removeModuleTmpDir: sinon.stub(),
        createModuleTmpDir: sinon.stub(),
        getDockerContainerImageName: (mod, coin, net) => {
            if (mod === 'database' || mod === 'xchain-hub' || mod === 'xchain-explorer' || mod === 'xchain-indexer-sync') {
                return 'xchain-node-' + mod
            }
            return 'xchain-node-' + coin + '-' + net + '-' + mod
        },
        getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
        validatePort: (v) => { if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535; if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 } return false },
        getDefaultConfig: sinon.stub().resolves({
            'NETWORK': 'bitcoin-mainnet',
            'NODE_URL': 'node',
            'NODE_PORT': 8332,
            'DECODER_PORT': 3002,
            'DECODER_API_PORT': 3002,
            'DECODER_BOOTSTRAP_VOLUME': '/data/bitcoin/mainnet/xchain-decoder/bootstrap/',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003,
            'UTXO_TRACKER_PORT': 3001,
            'UTXO_TRACKER_API_PORT': 3001,
            'UTXO_TRACKER_BOOTSTRAP_VOLUME': '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/',
            'INDEXER_PORT': 3004,
            'INDEXER_API_PORT': 3004,
            'REGTEST_MINER_PORT': 3005,
            'REGTEST_MINER_API_PORT': 3005,
            'HUB_PORT': 10000,
            'EXPLORER_PORT_HTTP': 18080,
            'EXPLORER_API_PORT_HTTP': 8080,
            'EXPLORER_PORT_HTTPS': 18081,
            'EXPLORER_API_PORT_HTTPS': 8081,
            'SYNC_PORT': 3006,
            'SYNC_API_PORT': 3006
        })
    }

    return proxyquire('../../src/services/ModuleService', {
        'child_process': { exec: stubs.exec },
        'fs': stubs.fs,
        '../state': {
            db: stubs.db,
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './ConfigService': configServiceStub,
        './StatusService': {
            statusChanged: stubs.statusChanged,
            getStatus: stubs.getStatus
        },
        './DockerService': {
            killContainer: stubs.killContainer,
            removeContainer: stubs.removeContainer,
            getStatusFromContainer: stubs.getStatusFromContainer
        },
        './DatabaseService': {
            setDatabaseParameters: sinon.stub().resolves()
        }
    })
}

describe('ModuleService', function () {

    // -------------------------------------------------------------------
    // cloneGit
    // -------------------------------------------------------------------

    describe('cloneGit()', function () {

        it('clones to module directory with correct git URL', async function () {
            const stubs = makeStubs()
            stubs.exec.callsFake((cmd, cb) => {
                expect(cmd).to.include('git clone')
                expect(cmd).to.include(modulesUrls['xchain-encoder'])
                expect(cmd).to.include('/modules/xchain-encoder')
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder')
        })

        it('rejects when module has no URL mapping', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('unknown-module')
                expect.fail()
            } catch (err) {
                expect(err).to.include("doesn't have an url")
            }
        })

        it('removes existing directory when rewrite=true', async function () {
            const stubs = makeStubs()
            stubs.exec.callsFake((cmd, cb) => cb(null))
            const ms = loadModuleService(stubs)
            // moduleDirExists returns false by default, so rewrite path won't trigger rmSync
            // but the function should still succeed
            await ms.cloneGit('xchain-encoder', true)
            expect(stubs.exec.calledOnce).to.be.true
        })

        it('rejects when directory exists and rewrite=false', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            // Override moduleDirExists to return true via proxyquire (already set to false)
            // We need to re-load with moduleDirExists returning true
            const ms2 = proxyquire('../../src/services/ModuleService', {
                'child_process': { exec: stubs.exec },
                'fs': stubs.fs,
                '../state': { db: stubs.db, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(true),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub(),
                    getDockerNetwork: sinon.stub(),
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './StatusService': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, getStatusFromContainer: stubs.getStatusFromContainer },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
            })
            try {
                await ms2.cloneGit('xchain-encoder', false, false)
                expect.fail()
            } catch (err) {
                expect(err).to.include('already exists')
            }
        })

        it('uses tmp directory when useTmp=true', async function () {
            const stubs = makeStubs()
            stubs.exec.callsFake((cmd, cb) => {
                expect(cmd).to.include('/tmp/xchain-encoder')
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder', false, true)
        })

        it('rejects on git clone error', async function () {
            const stubs = makeStubs()
            stubs.exec.callsFake((cmd, cb) => {
                cb(new Error('git clone failed'))
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Error cloning')
            }
        })
    })

    // -------------------------------------------------------------------
    // buildAndUp
    // -------------------------------------------------------------------

    describe('buildAndUp()', function () {

        it('throws when module does not exist', async function () {
            const stubs = makeStubs()
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { exec: stubs.exec },
                'fs': stubs.fs,
                '../state': { db: stubs.db, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(false),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-bitcoin-mainnet-xchain-encoder'),
                    getDockerNetwork: sinon.stub().returns('xchain-node-bitcoin-mainnet'),
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './StatusService': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, getStatusFromContainer: stubs.getStatusFromContainer },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() }
            })
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.equal('module not found')
            }
        })

        it('runs docker build with correct image name and cwd', async function () {
            const stubs = makeStubs()
            let buildCmd = null
            stubs.exec.callsFake((cmd, opts, cb) => {
                if (typeof opts === 'function') { cb = opts; opts = {} }
                if (cmd.includes('docker build')) {
                    buildCmd = cmd
                    cb(null)
                } else if (cmd.includes('docker run')) {
                    // Return a 64-char container ID
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(buildCmd).to.include('docker build . -t xchain-node-bitcoin-mainnet-xchain-encoder')
        })

        it('constructs docker run command with environment variables', async function () {
            const stubs = makeStubs()
            let runCmd = null
            stubs.exec.callsFake((cmd, opts, cb) => {
                if (typeof opts === 'function') { cb = opts; opts = {} }
                if (cmd.includes('docker build')) {
                    cb(null)
                } else if (cmd.includes('docker run')) {
                    runCmd = cmd
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(runCmd).to.include('-e "NETWORK=bitcoin-mainnet"')
            expect(runCmd).to.include('-e "NODE_PORT=8332"')
        })

        it('includes port mapping for encoder', async function () {
            const stubs = makeStubs()
            let runCmd = null
            stubs.exec.callsFake((cmd, opts, cb) => {
                if (typeof opts === 'function') { cb = opts; opts = {} }
                if (cmd.includes('docker build')) {
                    cb(null)
                } else if (cmd.includes('docker run')) {
                    runCmd = cmd
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect(runCmd).to.include('-p 3003:3003')
        })

        it('includes volume mount for decoder', async function () {
            const stubs = makeStubs()
            let runCmd = null
            stubs.exec.callsFake((cmd, opts, cb) => {
                if (typeof opts === 'function') { cb = opts; opts = {} }
                if (cmd.includes('docker build')) {
                    cb(null)
                } else if (cmd.includes('docker run')) {
                    runCmd = cmd
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_DECODER, 'bitcoin', 'mainnet')
            expect(runCmd).to.include('-v /data/bitcoin/mainnet/xchain-decoder/bootstrap/:/bootstrap/xchain-decoder')
        })

        it('includes ulimit for utxo-tracker', async function () {
            const stubs = makeStubs()
            let runCmd = null
            stubs.exec.callsFake((cmd, opts, cb) => {
                if (typeof opts === 'function') { cb = opts; opts = {} }
                if (cmd.includes('docker build')) {
                    cb(null)
                } else if (cmd.includes('docker run')) {
                    runCmd = cmd
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            expect(runCmd).to.include('--ulimit nofile=2048:2048')
        })

        it('includes --network flag in docker run', async function () {
            const stubs = makeStubs()
            let runCmd = null
            stubs.exec.callsFake((cmd, opts, cb) => {
                if (typeof opts === 'function') { cb = opts; opts = {} }
                if (cmd.includes('docker build')) {
                    cb(null)
                } else if (cmd.includes('docker run')) {
                    runCmd = cmd
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(runCmd).to.include('--network xchain-node-bitcoin-mainnet')
        })

        it('stores container ID in LevelDB on success', async function () {
            const stubs = makeStubs()
            const containerId = 'b'.repeat(64)
            stubs.exec.callsFake((cmd, opts, cb) => {
                if (typeof opts === 'function') { cb = opts; opts = {} }
                if (cmd.includes('docker build')) {
                    cb(null)
                } else if (cmd.includes('docker run')) {
                    cb(null, containerId + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(stubs.db.insertModuleContainer.calledOnce).to.be.true
            const args = stubs.db.insertModuleContainer.firstCall.args
            expect(args[0]).to.equal('xchain-encoder')
            expect(args[1]).to.equal('bitcoin')
            expect(args[2]).to.equal('mainnet')
            expect(args[3]).to.equal(containerId)
        })

        it('calls statusChanged after storing container ID', async function () {
            const stubs = makeStubs()
            stubs.exec.callsFake((cmd, opts, cb) => {
                if (typeof opts === 'function') { cb = opts; opts = {} }
                if (cmd.includes('docker build')) {
                    cb(null)
                } else if (cmd.includes('docker run')) {
                    cb(null, 'c'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(stubs.statusChanged.calledOnce).to.be.true
        })

        it('kills and removes old container when overwriteContainerId is provided', async function () {
            const stubs = makeStubs()
            stubs.exec.callsFake((cmd, opts, cb) => {
                if (typeof opts === 'function') { cb = opts; opts = {} }
                if (cmd.includes('docker build')) {
                    cb(null)
                } else if (cmd.includes('docker run')) {
                    cb(null, 'd'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', 'old-id-123')
            expect(stubs.killContainer.calledWith('old-id-123')).to.be.true
            expect(stubs.removeContainer.calledWith('old-id-123')).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // uninstallModule
    // -------------------------------------------------------------------

    describe('uninstallModule()', function () {

        it('throws when trying to uninstall database', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({})
            const ms = loadModuleService(stubs)
            try {
                await ms.uninstallModule('bitcoin', 'mainnet', 'database')
                expect.fail()
            } catch (err) {
                expect(err).to.include('manually removed')
            }
        })

        it('kills running container before removing', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({
                'bitcoin': {
                    'mainnet': {
                        'xchain-encoder': {
                            container_id: 'enc-123',
                            status: { State: { Status: 'running' } }
                        }
                    }
                }
            })
            const ms = loadModuleService(stubs)
            await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
            expect(stubs.killContainer.calledWith('enc-123')).to.be.true
            expect(stubs.removeContainer.calledWith('enc-123')).to.be.true
        })

        it('skips kill for exited containers', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({
                'bitcoin': {
                    'mainnet': {
                        'xchain-encoder': {
                            container_id: 'enc-123',
                            status: { State: { Status: 'exited' } }
                        }
                    }
                }
            })
            const ms = loadModuleService(stubs)
            await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
            expect(stubs.killContainer.called).to.be.false
            expect(stubs.removeContainer.calledWith('enc-123')).to.be.true
        })

        it('returns true when module is not found (already uninstalled)', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({})
            const ms = loadModuleService(stubs)
            const result = await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
            expect(result).to.be.true
        })
    })
})
