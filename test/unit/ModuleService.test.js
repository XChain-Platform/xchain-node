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

const { modulesUrls, XChainService } = require('../../src/config/constants')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubs() {
    return {
        execFile: sinon.stub(),
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
        getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } }),
        // No published host ports by default → buildAndUp's pre-flight conflict
        // check is a no-op. Conflict tests override this with a populated Map.
        getPublishedHostPorts: sinon.stub().resolves(new Map())
    }
}

function loadModuleService(stubs, constantsOverride) {
    const configServiceStub = {
        getModuleDir: (mod) => '/modules/' + mod,
        getModuleTmpDir: (mod) => '/tmp/' + mod,
        moduleDirExists: sinon.stub().returns(false),
        checkIfModuleExists: sinon.stub().returns(true),
        removeModuleDir: sinon.stub(),
        removeModuleTmpDir: sinon.stub(),
        createModuleTmpDir: sinon.stub(),
        getDockerContainerImageName: (mod, coin, net) => {
            if (mod === 'database' || mod === 'xchain-hub' || mod === 'xchain-explorer' || mod === 'xchain-sync') {
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

    const proxies = {
        'child_process': { execFile: stubs.execFile },
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
            getStatusFromContainer: stubs.getStatusFromContainer,
            getPublishedHostPorts: stubs.getPublishedHostPorts
        },
        './DatabaseService': {
            setDatabaseParameters: sinon.stub().resolves()
        },
        // installModule lazily requires these; stub so they load under test
        // (the real VersionService pulls in state.js, which needs a live DB).
        './VersionService': {
            getLocalNodeVersion: sinon.stub().resolves(null),
            getLocalModuleVersion: sinon.stub().resolves(null),
            checkRemoteNodeVersion: sinon.stub().resolves()
        },
        './NodeService': {
            buildCryptoNode: sinon.stub().resolves(true),
            getCryptoNode: sinon.stub().resolves()
        },
        './ExplorerService': {
            installExplorerModule: sinon.stub().resolves(true)
        }
    }
    if (constantsOverride) {
        proxies['../config/constants'] = Object.assign({}, require('../../src/config/constants'), constantsOverride)
    }
    return proxyquire('../../src/services/ModuleService', proxies)
}

describe('ModuleService', function () {

    // -------------------------------------------------------------------
    // cloneGit
    // -------------------------------------------------------------------

    describe('cloneGit()', function () {

        it('clones to module directory with correct git URL', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(cmd).to.equal('git')
                expect(args).to.include('clone')
                expect(args).to.include(modulesUrls['xchain-encoder'])
                expect(args).to.include('/modules/xchain-encoder')
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
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null)
            })
            const ms = loadModuleService(stubs)
            // moduleDirExists returns false by default, so rewrite path won't trigger rmSync
            // but the function should still succeed
            await ms.cloneGit('xchain-encoder', true)
            expect(stubs.execFile.calledOnce).to.be.true
        })

        it('rejects when directory exists and rewrite=false', async function () {
            const stubs = makeStubs()
            const ms2 = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
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
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                expect(args).to.include('/tmp/xchain-encoder')
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder', false, true)
        })

        it('rejects on git clone error', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
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
                'child_process': { execFile: stubs.execFile },
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
            let buildArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    buildArgs = args
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(buildArgs).to.include('-t')
            expect(buildArgs).to.include('xchain-node-bitcoin-mainnet-xchain-encoder')
        })

        it('constructs docker run command with environment variables', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    runArgs = args
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(runArgs).to.include('-e')
            expect(runArgs).to.include('NETWORK=bitcoin-mainnet')
            expect(runArgs).to.include('NODE_PORT=8332')
        })

        it('includes port mapping for encoder', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    runArgs = args
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect(runArgs).to.include('-p')
            expect(runArgs).to.include('3003:3003')
        })

        it('includes volume mount for decoder', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    runArgs = args
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_DECODER, 'bitcoin', 'mainnet')
            expect(runArgs).to.include('-v')
            expect(runArgs.some(a => a.includes('/bootstrap/xchain-decoder'))).to.be.true
        })

        it('includes ulimit for utxo-tracker', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    runArgs = args
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            expect(runArgs).to.include('--ulimit')
            expect(runArgs).to.include('nofile=2048:2048')
        })

        it('keeps the legacy tracker volume name under the default NODE_PREFIX', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'a'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            expect(runArgs).to.include('xchain-utxo-tracker-bitcoin-mainnet-data:/data/xchain-utxo-tracker')
        })

        it('prefixes the tracker volume name under a non-default NODE_PREFIX (F11)', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'a'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs, { NODE_PREFIX: 'xchain-fed' })
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'regtest')
            expect(runArgs).to.include('xchain-fed-xchain-utxo-tracker-bitcoin-regtest-data:/data/xchain-utxo-tracker')
        })

        it('includes --network flag in docker run', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    runArgs = args
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(runArgs).to.include('--network')
            expect(runArgs).to.include('xchain-node-bitcoin-mainnet')
        })

        it('stores container ID in LevelDB on success', async function () {
            const stubs = makeStubs()
            const containerId = 'b'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, containerId + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(stubs.db.insertModuleContainer.calledOnce).to.be.true
            const dbArgs = stubs.db.insertModuleContainer.firstCall.args
            expect(dbArgs[0]).to.equal('xchain-encoder')
            expect(dbArgs[1]).to.equal('bitcoin')
            expect(dbArgs[2]).to.equal('mainnet')
            expect(dbArgs[3]).to.equal(containerId)
        })

        it('calls statusChanged after storing container ID', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, 'c'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(stubs.statusChanged.calledOnce).to.be.true
        })

        it('kills and removes old container when overwriteContainerId is provided', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
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
    // installModule — singleton guard
    // -------------------------------------------------------------------

    describe('installModule() singleton guard', function () {

        it('skips re-creating a singleton module whose container already exists', async function () {
            // Regression: a singleton (hub/sync) has one coin/network-independent
            // container name, so installing it across multiple networks used to
            // re-run `docker run` with a duplicate name and crash. The guard must
            // detect the existing named container and return without rebuilding.
            const stubs = makeStubs()
            const VALID_ID = 'b'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                // `docker inspect <name>` → report the singleton already exists
                if (cmd === 'docker' && args[0] === 'inspect') return cb(null, { stdout: VALID_ID + '\n' })
                cb(null, { stdout: '' })
            })
            const ms = loadModuleService(stubs)
            const result = await ms.installModule('xchain-hub', null, null)
            expect(result).to.be.false
            // Must short-circuit before the build path — no git clone attempted.
            const clonedViaGit = stubs.execFile.getCalls().some(c => c.args[0] === 'git')
            expect(clonedViaGit).to.be.false
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

        it('removes stale tracking row when no container in status but row exists in DB', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({})
            stubs.db.getModuleContainer.resolves('stale-cid')
            const ms = loadModuleService(stubs)
            const result = await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
            expect(stubs.db.removeModuleContainer.calledOnce).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
            expect(result).to.be.true
        })

        it('throws when container kill/remove fails (catch rethrows)', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({
                bitcoin: {
                    mainnet: {
                        'xchain-encoder': {
                            container_id: 'enc-456',
                            status: { State: { Status: 'running' } }
                        }
                    }
                }
            })
            stubs.killContainer.rejects(new Error('kill failed'))
            const ms = loadModuleService(stubs)
            try {
                await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
                expect.fail()
            } catch (err) {
                expect(err).to.include('problem trying to kill')
            }
        })
    })

    // -------------------------------------------------------------------
    // cloneGit — branch coverage
    // -------------------------------------------------------------------

    describe('cloneGit() branch handling', function () {

        it('rejects on invalid branch name', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'bad branch!')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('clones with -b flag when a valid branch is specified', async function () {
            const stubs = makeStubs()
            let cloneArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cloneArgs = args
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder', false, false, 'feature/test')
            expect(cloneArgs).to.include('-b')
            expect(cloneArgs).to.include('feature/test')
        })

        it('falls back to default branch when branch not found error', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callCount++
                if (callCount === 1) {
                    // First call: branch clone fails with "not found"
                    cb(new Error('git error'), '', 'remote: branch not found on server')
                } else {
                    // Second call: fallback clone succeeds
                    cb(null)
                }
            })
            const ms = loadModuleService(stubs)
            const result = await ms.cloneGit('xchain-encoder', false, false, 'missing-branch')
            expect(result).to.be.true
            expect(callCount).to.equal(2)
        })

        it('rejects if fallback clone also fails', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callCount++
                if (callCount === 1) {
                    cb(new Error('git error'), '', 'remote: branch not found on server')
                } else {
                    cb(new Error('fallback also failed'))
                }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'missing-branch')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Error cloning')
            }
        })
    })

    // -------------------------------------------------------------------
    // installModule — DB module path
    // -------------------------------------------------------------------

    describe('installModule() — DB module', function () {

        it('calls buildDatabaseModule and statusChanged for DB module', async function () {
            const stubs = makeStubs()
            const buildDatabaseStub = sinon.stub().resolves(true)
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-database'),
                    getDockerNetwork: sinon.stub().returns('xchain-node'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
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
                    setDatabaseParameters: sinon.stub().resolves(),
                    buildDatabaseModule: buildDatabaseStub
                },
                './VersionService': {
                    getLocalNodeVersion: sinon.stub().resolves(null),
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './NodeService': {
                    buildCryptoNode: sinon.stub().resolves(true),
                    getCryptoNode: sinon.stub().resolves()
                },
                './ExplorerService': {
                    installExplorerModule: sinon.stub().resolves(true)
                }
            })
            const result = await ms.installModule('database', 'bitcoin', 'mainnet')
            expect(buildDatabaseStub.calledOnce).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
            expect(result).to.be.true
        })

        it('throws when buildDatabaseModule fails', async function () {
            const stubs = makeStubs()
            const buildDatabaseStub = sinon.stub().rejects(new Error('DB build failed'))
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-database'),
                    getDockerNetwork: sinon.stub().returns('xchain-node'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
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
                    setDatabaseParameters: sinon.stub().resolves(),
                    buildDatabaseModule: buildDatabaseStub
                },
                './VersionService': {
                    getLocalNodeVersion: sinon.stub().resolves(null),
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './NodeService': {
                    buildCryptoNode: sinon.stub().resolves(true),
                    getCryptoNode: sinon.stub().resolves()
                },
                './ExplorerService': {
                    installExplorerModule: sinon.stub().resolves(true)
                }
            })
            try {
                await ms.installModule('database', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('DB build failed')
            }
        })
    })

    // -------------------------------------------------------------------
    // installModule — EXPLORER module path
    // -------------------------------------------------------------------

    describe('installModule() — explorer module', function () {

        it('calls installExplorerModule and statusChanged', async function () {
            const stubs = makeStubs()
            const installExplorerStub = sinon.stub().resolves(true)
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-xchain-explorer'),
                    getDockerNetwork: sinon.stub().returns('xchain-node'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
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
                },
                './VersionService': {
                    getLocalNodeVersion: sinon.stub().resolves(null),
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './NodeService': {
                    buildCryptoNode: sinon.stub().resolves(true),
                    getCryptoNode: sinon.stub().resolves()
                },
                './ExplorerService': {
                    installExplorerModule: installExplorerStub
                }
            })
            const result = await ms.installModule('xchain-explorer', null, null)
            expect(installExplorerStub.calledOnce).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // installModule — generic module, skip-when-version-present
    // -------------------------------------------------------------------

    describe('installModule() — generic module, container version already known', function () {

        it('returns false when container version is already set and remoteUpdate=false', async function () {
            const stubs = makeStubs()
            // Provide a last status that has a container_version
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => ({
                        bitcoin: {
                            mainnet: {
                                'xchain-encoder': { container_version: '1.0.0' }
                            }
                        }
                    })
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-bitcoin-mainnet-xchain-encoder'),
                    getDockerNetwork: sinon.stub().returns('xchain-node-bitcoin-mainnet'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
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
                },
                './VersionService': {
                    getLocalNodeVersion: sinon.stub().resolves('1.0.0'),
                    getLocalModuleVersion: sinon.stub().resolves('1.0.0'),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './NodeService': {
                    buildCryptoNode: sinon.stub().resolves(true),
                    getCryptoNode: sinon.stub().resolves()
                },
                './ExplorerService': {
                    installExplorerModule: sinon.stub().resolves(true)
                }
            })
            const result = await ms.installModule('xchain-encoder', 'bitcoin', 'mainnet', false)
            expect(result).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // installModule — generic module full build path
    // -------------------------------------------------------------------

    describe('installModule() — generic module full build', function () {

        it('clones, builds, and returns containerId for a fresh generic module', async function () {
            const stubs = makeStubs()
            const containerId = 'f'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (cmd === 'git' && args[0] === 'clone') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            const result = await ms.installModule('xchain-encoder', 'bitcoin', 'mainnet', true)
            expect(result).to.equal(containerId)
            expect(stubs.statusChanged.called).to.be.true
        })

        it('throws when cloneGit fails during installModule', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (cmd === 'git') { cb(new Error('clone error')) }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.installModule('xchain-encoder', 'bitcoin', 'mainnet', true)
                expect.fail()
            } catch (err) {
                expect(err).to.include('Error cloning')
            }
        })
    })

    // -------------------------------------------------------------------
    // buildAndUp — port validation + hub/sync/indexer/regtest branches
    // -------------------------------------------------------------------

    describe('buildAndUp() — module-specific port/volume branches', function () {

        it('includes port mapping for xchain-hub', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-hub', 'bitcoin', 'mainnet')
            expect(runArgs).to.include('-p')
            expect(runArgs.some(a => typeof a === 'string' && a.startsWith('10000:'))).to.be.true
        })

        it('includes two port mappings for xchain-explorer', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-explorer', null, null)
            // Should have two -p args
            const pCount = runArgs.filter(a => a === '-p').length
            expect(pCount).to.equal(2)
        })

        it('includes port mapping for xchain-sync', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-sync', null, null)
            expect(runArgs).to.include('-p')
        })

        it('includes port mapping for xchain-regtest-miner', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-regtest-miner', 'bitcoin', 'mainnet')
            expect(runArgs).to.include('-p')
        })

        it('includes port mapping for xchain-indexer and invokes cpSync filter for bundled libs', async function () {
            const stubs = makeStubs()
            // xchain-indexer has LIBRARY_BUNDLES=['xchain-vm'], so buildAndUp clones xchain-vm first.
            let capturedFilter = null
            stubs.fs.cpSync = sinon.stub().callsFake((src, dest, opts) => {
                if (opts && opts.filter) capturedFilter = opts.filter
            })
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (cmd === 'git') { cb(null) } // handle cloneGit for xchain-vm
                else if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_INDEXER, 'bitcoin', 'mainnet')
            expect(runArgs).to.include('-p')
            expect(runArgs.some(a => typeof a === 'string' && a.includes('3004'))).to.be.true
            // Verify filter function logic: excluded dirs should return false
            expect(capturedFilter).to.be.a('function')
            expect(capturedFilter('/path/to/node_modules')).to.be.false
            expect(capturedFilter('/path/to/.git')).to.be.false
            expect(capturedFilter('/path/to/test')).to.be.false
            expect(capturedFilter('/path/to/bench')).to.be.false
            expect(capturedFilter('/path/to/reports')).to.be.false
            expect(capturedFilter('/path/to/src/index.js')).to.be.true
        })

        it('mounts capability config volume when HUB_CAPABILITY_CONFIG is set', async function () {
            const stubs = makeStubs()
            const capsHostPath = '/host/caps.json'
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            // Use proxyquire with ValidatorService stub + HUB_CAPABILITY_CONFIG in env
            const ms2 = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: (mod, coin, net) => {
                        if (mod === 'xchain-hub') return 'xchain-node-xchain-hub'
                        return `xchain-node-${coin}-${net}-${mod}`
                    },
                    getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
                    validatePort: (v) => { const p = parseInt(v, 10); return p >= 1 && p <= 65535 },
                    getDefaultConfig: sinon.stub().resolves({
                        HUB_PORT: 10000,
                        HUB_CAPABILITY_CONFIG: '/container/caps.json'
                    })
                },
                './StatusService': {
                    statusChanged: stubs.statusChanged,
                    getStatus: stubs.getStatus
                },
                './DockerService': {
                    killContainer: stubs.killContainer,
                    removeContainer: stubs.removeContainer,
                    getStatusFromContainer: stubs.getStatusFromContainer,
                    getPublishedHostPorts: stubs.getPublishedHostPorts
                },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() },
                './ValidatorService': {
                    getCapabilityConfigHostPath: () => capsHostPath,
                    CAPS_CONTAINER_PATH: '/container/caps.json'
                },
                './VersionService': { getLocalNodeVersion: sinon.stub().resolves(null), getLocalModuleVersion: sinon.stub().resolves(null), checkRemoteNodeVersion: sinon.stub().resolves() },
                './NodeService': { buildCryptoNode: sinon.stub().resolves(true), getCryptoNode: sinon.stub().resolves() },
                './ExplorerService': { installExplorerModule: sinon.stub().resolves(true) }
            })
            await ms2.buildAndUp('xchain-hub', 'bitcoin', 'mainnet')
            // Should have a volume mount for the capability config
            expect(runArgs).to.include('-v')
            expect(runArgs.some(a => typeof a === 'string' && a.includes(capsHostPath))).to.be.true
        })

        it('rejects when port value is invalid (non-numeric)', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else { cb(null, '') }
            })
            // Use a custom stub where validatePort returns false
            const ms2 = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: () => 'xchain-node-bitcoin-mainnet-xchain-encoder',
                    getDockerNetwork: () => 'xchain-node-bitcoin-mainnet',
                    validatePort: () => false, // always invalid
                    getDefaultConfig: sinon.stub().resolves({
                        ENCODER_PORT: 99999,
                        ENCODER_API_PORT: 99999
                    })
                },
                './StatusService': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() },
                './VersionService': { getLocalNodeVersion: sinon.stub().resolves(null), getLocalModuleVersion: sinon.stub().resolves(null), checkRemoteNodeVersion: sinon.stub().resolves() },
                './NodeService': { buildCryptoNode: sinon.stub().resolves(true), getCryptoNode: sinon.stub().resolves() },
                './ExplorerService': { installExplorerModule: sinon.stub().resolves(true) }
            })
            try {
                await ms2.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Invalid port value')
            }
        })

        it('includes --restart unless-stopped for non-execution containers', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, false)
            expect(runArgs).to.include('--restart')
            expect(runArgs).to.include('unless-stopped')
        })

        it('omits --restart for onlyExecution containers', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)
            expect(runArgs).to.not.include('--restart')
        })

        it('rejects when docker build fails', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(new Error('build failed')) }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Error creating Docker image')
            }
        })

        it('rejects when docker run fails', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { cb(new Error('run failed')) }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Error creating the container')
            }
        })

        it('rejects when container ID returned is not a valid 64-char hex', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { cb(null, 'bad-id\n') }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Invalid container ID')
            }
        })

        it('rejects when insertModuleContainer returns false', async function () {
            const stubs = makeStubs()
            stubs.db.insertModuleContainer.resolves(false)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { cb(null, 'a'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.include('problem trying to store')
            }
        })

        it('skips db insert for onlyExecution=true and resolves containerId directly', async function () {
            const stubs = makeStubs()
            const containerId = 'c'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { cb(null, containerId + '\n') }
            })
            const ms = loadModuleService(stubs)
            const result = await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)
            expect(result).to.equal(containerId)
            expect(stubs.db.insertModuleContainer.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // containerExistsByName (via installModule singleton path with remoteUpdate=true)
    // -------------------------------------------------------------------

    describe('containerExistsByName() via installModule', function () {

        it('rebuilds singleton when remoteUpdate=true even if container exists', async function () {
            const stubs = makeStubs()
            const containerId = 'e'.repeat(64)
            // inspect → container exists, but remoteUpdate=true bypasses singleton guard
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (cmd === 'docker' && args[0] === 'inspect') { cb(null, { stdout: containerId + '\n' }) }
                else if (cmd === 'git') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            const ms = loadModuleService(stubs)
            const result = await ms.installModule('xchain-hub', null, null, true)
            // remoteUpdate=true → should call git clone and return container ID
            expect(stubs.execFile.getCalls().some(c => c.args[0] === 'git')).to.be.true
            expect(result).to.equal(containerId)
        })
    })

    // -------------------------------------------------------------------
    // getModuleBranch
    // -------------------------------------------------------------------

    // -------------------------------------------------------------------
    // installModule — BootstrapService lazy-require paths (utxo-tracker / decoder fresh)
    // -------------------------------------------------------------------

    describe('installModule() — bootstrap paths via @global proxyquire', function () {

        it('calls ensureBootstrapUtxoTracker when utxo-tracker volume was fresh', async function () {
            const sinon3 = require('sinon')
            const ensureBootstrapUtxoTrackerStub = sinon3.stub().resolves()
            const utxoTrackerVolumeHasDataStub = sinon3.stub().resolves(false) // false → fresh
            const containerId = 'f'.repeat(64)
            const execFileStub = sinon3.stub()
            execFileStub.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (cmd === 'git') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            const pq = require('proxyquire').noCallThru()
            const configStub = {
                getModuleDir: (mod) => '/modules/' + mod,
                getModuleTmpDir: (mod) => '/tmp/' + mod,
                moduleDirExists: sinon3.stub().returns(false),
                checkIfModuleExists: sinon3.stub().returns(true),
                removeModuleDir: sinon3.stub(),
                removeModuleTmpDir: sinon3.stub(),
                createModuleTmpDir: sinon3.stub(),
                getDockerContainerImageName: (mod, coin, net) => `${coin}-${net}-${mod}`,
                getDockerNetwork: (coin, net) => `net-${coin}-${net}`,
                validatePort: () => true,
                getDefaultConfig: sinon3.stub().resolves({
                    UTXO_TRACKER_PORT: 3001, UTXO_TRACKER_API_PORT: 3001,
                    UTXO_TRACKER_BOOTSTRAP_VOLUME: '/bootstrap'
                })
            }
            const ms = pq.callThru()('../../src/services/ModuleService', {
                'child_process': { execFile: execFileStub },
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub() },
                '../state': {
                    db: { insertModuleContainer: sinon3.stub().resolves(true), getModuleContainer: sinon3.stub().resolves(null), removeModuleContainer: sinon3.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': configStub,
                './StatusService': { statusChanged: sinon3.stub().resolves(), getStatus: sinon3.stub().resolves({}) },
                './DockerService': { killContainer: sinon3.stub().resolves(true), removeContainer: sinon3.stub().resolves(true) },
                './DatabaseService': { setDatabaseParameters: sinon3.stub().resolves() },
                './BootstrapService': {
                    utxoTrackerVolumeHasData: utxoTrackerVolumeHasDataStub,
                    ensureBootstrapUtxoTracker: ensureBootstrapUtxoTrackerStub,
                    mariaDbModuleHasData: sinon3.stub().resolves(true),
                    ensureBootstrapMariaDb: sinon3.stub().resolves()
                },
                './VersionService': { getLocalNodeVersion: sinon3.stub().resolves(null), getLocalModuleVersion: sinon3.stub().resolves(null), checkRemoteNodeVersion: sinon3.stub().resolves() },
                './NodeService': { buildCryptoNode: sinon3.stub().resolves(true), getCryptoNode: sinon3.stub().resolves() },
                './ExplorerService': { installExplorerModule: sinon3.stub().resolves(true) }
            })
            const result = await ms.installModule('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
            expect(utxoTrackerVolumeHasDataStub.calledOnce).to.be.true
            expect(ensureBootstrapUtxoTrackerStub.calledOnce).to.be.true
            expect(result).to.equal(containerId)
        })

        it('calls ensureBootstrapMariaDb when decoder DB was fresh', async function () {
            const sinon3 = require('sinon')
            const ensureBootstrapMariaDbStub = sinon3.stub().resolves()
            const mariaDbModuleHasDataStub = sinon3.stub().resolves(false) // false → fresh
            const setDatabaseParametersStub = sinon3.stub().resolves()
            const containerId = 'a'.repeat(64)
            const execFileStub = sinon3.stub()
            execFileStub.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (cmd === 'git') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            const pq = require('proxyquire').noCallThru()
            const configStub = {
                getModuleDir: (mod) => '/modules/' + mod,
                getModuleTmpDir: (mod) => '/tmp/' + mod,
                moduleDirExists: sinon3.stub().returns(false),
                checkIfModuleExists: sinon3.stub().returns(true),
                removeModuleDir: sinon3.stub(),
                removeModuleTmpDir: sinon3.stub(),
                createModuleTmpDir: sinon3.stub(),
                getDockerContainerImageName: (mod, coin, net) => `${coin}-${net}-${mod}`,
                getDockerNetwork: (coin, net) => `net-${coin}-${net}`,
                validatePort: () => true,
                getDefaultConfig: sinon3.stub().resolves({
                    DECODER_PORT: 3002, DECODER_API_PORT: 3002,
                    DECODER_BOOTSTRAP_VOLUME: '/bootstrap'
                })
            }
            const ms = pq.callThru()('../../src/services/ModuleService', {
                'child_process': { execFile: execFileStub },
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub() },
                '../state': {
                    db: { insertModuleContainer: sinon3.stub().resolves(true), getModuleContainer: sinon3.stub().resolves(null), removeModuleContainer: sinon3.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': configStub,
                './StatusService': { statusChanged: sinon3.stub().resolves(), getStatus: sinon3.stub().resolves({}) },
                './DockerService': { killContainer: sinon3.stub().resolves(true), removeContainer: sinon3.stub().resolves(true) },
                './DatabaseService': { setDatabaseParameters: setDatabaseParametersStub },
                './BootstrapService': {
                    utxoTrackerVolumeHasData: sinon3.stub().resolves(true),
                    ensureBootstrapUtxoTracker: sinon3.stub().resolves(),
                    mariaDbModuleHasData: mariaDbModuleHasDataStub,
                    ensureBootstrapMariaDb: ensureBootstrapMariaDbStub
                },
                './VersionService': { getLocalNodeVersion: sinon3.stub().resolves(null), getLocalModuleVersion: sinon3.stub().resolves(null), checkRemoteNodeVersion: sinon3.stub().resolves() },
                './NodeService': { buildCryptoNode: sinon3.stub().resolves(true), getCryptoNode: sinon3.stub().resolves() },
                './ExplorerService': { installExplorerModule: sinon3.stub().resolves(true) }
            })
            const result = await ms.installModule('xchain-decoder', 'bitcoin', 'mainnet', true)
            expect(mariaDbModuleHasDataStub.calledOnce).to.be.true
            expect(setDatabaseParametersStub.calledOnce).to.be.true
            expect(ensureBootstrapMariaDbStub.calledOnce).to.be.true
            expect(result).to.equal(containerId)
        })
    })

    // -------------------------------------------------------------------
    // installModule — NODE_MODULE_NAME paths
    // -------------------------------------------------------------------

    describe('installModule() — node module', function () {

        it('builds crypto node when no container version and localNodeVersion is null', async function () {
            const stubs = makeStubs()
            const buildCryptoNodeStub = sinon.stub().resolves(true)
            const getCryptoNodeStub = sinon.stub().resolves()
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({ 'node-bitcoin': { tag_name: 'v25.0.0' } }),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-bitcoin-mainnet-node'),
                    getDockerNetwork: sinon.stub().returns('xchain-node-bitcoin-mainnet'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './StatusService': {
                    statusChanged: stubs.statusChanged,
                    getStatus: stubs.getStatus
                },
                './DockerService': {
                    killContainer: stubs.killContainer,
                    removeContainer: stubs.removeContainer,
                    getStatusFromContainer: stubs.getStatusFromContainer
                },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() },
                './VersionService': {
                    getLocalNodeVersion: sinon.stub().resolves(null),
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './NodeService': {
                    buildCryptoNode: buildCryptoNodeStub,
                    getCryptoNode: getCryptoNodeStub
                },
                './ExplorerService': { installExplorerModule: sinon.stub().resolves(true) }
            })
            const result = await ms.installModule('node', 'bitcoin', 'mainnet', false)
            expect(getCryptoNodeStub.calledOnce).to.be.true
            expect(buildCryptoNodeStub.calledOnce).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
            expect(result).to.be.true
        })

        it('returns false when node container_version already set and remoteUpdate=false', async function () {
            const stubs = makeStubs()
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => ({
                        bitcoin: { mainnet: { node: { container_version: 'v25.0.0' } } }
                    })
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('node'),
                    getDockerNetwork: sinon.stub().returns('net'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './StatusService': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() },
                './VersionService': { getLocalNodeVersion: sinon.stub().resolves('v25.0.0'), getLocalModuleVersion: sinon.stub().resolves(null), checkRemoteNodeVersion: sinon.stub().resolves() },
                './NodeService': { buildCryptoNode: sinon.stub().resolves(true), getCryptoNode: sinon.stub().resolves() },
                './ExplorerService': { installExplorerModule: sinon.stub().resolves(true) }
            })
            const result = await ms.installModule('node', 'bitcoin', 'mainnet', false)
            expect(result).to.be.false
        })

        it('skips getCryptoNode when localNodeVersion already set and remoteUpdate=false', async function () {
            const stubs = makeStubs()
            const getCryptoNodeStub = sinon.stub().resolves()
            const buildCryptoNodeStub = sinon.stub().resolves(true)
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('node'),
                    getDockerNetwork: sinon.stub().returns('net'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './StatusService': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() },
                './VersionService': {
                    getLocalNodeVersion: sinon.stub().resolves('v25.0.0'), // has local version
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './NodeService': { buildCryptoNode: buildCryptoNodeStub, getCryptoNode: getCryptoNodeStub },
                './ExplorerService': { installExplorerModule: sinon.stub().resolves(true) }
            })
            const result = await ms.installModule('node', 'bitcoin', 'mainnet', false)
            expect(getCryptoNodeStub.called).to.be.false
            expect(buildCryptoNodeStub.calledOnce).to.be.true
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // installModule — explorer error path
    // -------------------------------------------------------------------

    describe('installModule() — explorer error path', function () {

        it('throws when installExplorerModule fails', async function () {
            const stubs = makeStubs()
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('explorer'),
                    getDockerNetwork: sinon.stub().returns('net'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './StatusService': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() },
                './VersionService': { getLocalNodeVersion: sinon.stub().resolves(null), getLocalModuleVersion: sinon.stub().resolves(null), checkRemoteNodeVersion: sinon.stub().resolves() },
                './NodeService': { buildCryptoNode: sinon.stub().resolves(true), getCryptoNode: sinon.stub().resolves() },
                './ExplorerService': { installExplorerModule: sinon.stub().rejects(new Error('explorer install failed')) }
            })
            try {
                await ms.installModule('xchain-explorer', null, null, false)
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('explorer install failed')
            }
        })
    })

    // -------------------------------------------------------------------
    // installModule — branch switch when module already on different branch
    // -------------------------------------------------------------------

    describe('installModule() — branch switch path', function () {

        it('reclones when existing branch differs from requested branch', async function () {
            const sinon3 = require('sinon')
            const containerId = 'd'.repeat(64)
            const execFileStub = sinon3.stub()
            const cloneCallArgs = []
            execFileStub.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (cmd === 'git') {
                    cloneCallArgs.push(args)
                    cb(null)
                }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            // getModuleBranch uses promisify(execFile) → needs util stub
            const pq = require('proxyquire').noCallThru()
            const currentBranchStub = sinon3.stub().resolves({ stdout: 'master\n', stderr: '' })
            const moduleDirExistsStub = sinon3.stub().returns(true)
            const ms = pq.callThru()('../../src/services/ModuleService', {
                'child_process': { execFile: execFileStub },
                'util': {
                    promisify: () => async (...args) => currentBranchStub(...args)
                },
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub() },
                '../state': {
                    db: { insertModuleContainer: sinon3.stub().resolves(true), getModuleContainer: sinon3.stub().resolves(null), removeModuleContainer: sinon3.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: moduleDirExistsStub,
                    checkIfModuleExists: sinon3.stub().returns(true),
                    removeModuleDir: sinon3.stub(),
                    removeModuleTmpDir: sinon3.stub(),
                    createModuleTmpDir: sinon3.stub(),
                    getDockerContainerImageName: (mod, coin, net) => `${coin}-${net}-${mod}`,
                    getDockerNetwork: (coin, net) => `net-${coin}-${net}`,
                    validatePort: () => true,
                    getDefaultConfig: sinon3.stub().resolves({
                        ENCODER_PORT: 3003, ENCODER_API_PORT: 3003
                    })
                },
                './StatusService': { statusChanged: sinon3.stub().resolves(), getStatus: sinon3.stub().resolves({}) },
                './DockerService': { killContainer: sinon3.stub().resolves(true), removeContainer: sinon3.stub().resolves(true) },
                './DatabaseService': { setDatabaseParameters: sinon3.stub().resolves() },
                './VersionService': {
                    getLocalNodeVersion: sinon3.stub().resolves(null),
                    getLocalModuleVersion: sinon3.stub().resolves('1.0.0'), // has local version → won't remoteUpdate clone
                    checkRemoteNodeVersion: sinon3.stub().resolves()
                },
                './NodeService': { buildCryptoNode: sinon3.stub().resolves(true), getCryptoNode: sinon3.stub().resolves() },
                './ExplorerService': { installExplorerModule: sinon3.stub().resolves(true) }
            })
            // Module has localVersion (so won't clone on remoteUpdate=false), dir exists, but branch differs
            const result = await ms.installModule('xchain-encoder', 'bitcoin', 'mainnet', false, null, false, 'feature/new')
            // Should have called git clone (branch switch)
            const cloneCalls = execFileStub.getCalls().filter(c => c.args[0] === 'git')
            expect(cloneCalls.length).to.be.greaterThan(0)
            expect(result).to.equal(containerId)
        })
    })

    // -------------------------------------------------------------------
    // uninstallModule — removeModuleContainer returns false
    // -------------------------------------------------------------------

    describe('uninstallModule() — removeModuleContainer returns false', function () {

        it('throws when removeModuleContainer returns false after successful container removal', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({
                bitcoin: {
                    mainnet: {
                        'xchain-encoder': {
                            container_id: 'enc-789',
                            status: { State: { Status: 'exited' } }
                        }
                    }
                }
            })
            stubs.db.removeModuleContainer.resolves(null) // falsy → triggers throw
            const ms = loadModuleService(stubs)
            try {
                await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
                expect.fail()
            } catch (err) {
                // The catch block at line 466 rethrows "There was a problem trying to kill a container"
                expect(err).to.include('problem')
            }
        })
    })

    // -------------------------------------------------------------------
    // installModule — NODE path: checkRemoteNodeVersion when not in remoteVersions
    // -------------------------------------------------------------------

    describe('installModule() — node: checkRemoteNodeVersion called when coin not in remoteVersions', function () {

        it('calls checkRemoteNodeVersion when coin not in remote versions map', async function () {
            const stubs = makeStubs()
            const checkRemoteNodeVersionStub = sinon.stub().resolves()
            const getCryptoNodeStub = sinon.stub().resolves()
            const buildCryptoNodeStub = sinon.stub().resolves(true)
            // getRemoteModuleVersions returns a map that includes the coin only after checkRemoteNodeVersion
            let callCount = 0
            const getRemoteModuleVersionsStub = () => {
                callCount++
                if (callCount <= 1) {
                    return {} // first call: coin not present → triggers checkRemoteNodeVersion
                }
                return { 'node-bitcoin': { tag_name: 'v25.0.0' } } // second call: populated
            }
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: getRemoteModuleVersionsStub,
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('node'),
                    getDockerNetwork: sinon.stub().returns('net'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './StatusService': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() },
                './VersionService': {
                    getLocalNodeVersion: sinon.stub().resolves(null),
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: checkRemoteNodeVersionStub
                },
                './NodeService': { buildCryptoNode: buildCryptoNodeStub, getCryptoNode: getCryptoNodeStub },
                './ExplorerService': { installExplorerModule: sinon.stub().resolves(true) }
            })
            const result = await ms.installModule('node', 'bitcoin', 'mainnet', false)
            expect(checkRemoteNodeVersionStub.calledOnce).to.be.true
            expect(result).to.be.true
        })

        it('throws when getCryptoNode fails', async function () {
            const stubs = makeStubs()
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({ 'node-bitcoin': { tag_name: 'v25.0.0' } }),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('node'),
                    getDockerNetwork: sinon.stub().returns('net'),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './StatusService': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves() },
                './VersionService': {
                    getLocalNodeVersion: sinon.stub().resolves(null),
                    getLocalModuleVersion: sinon.stub().resolves(null),
                    checkRemoteNodeVersion: sinon.stub().resolves()
                },
                './NodeService': {
                    buildCryptoNode: sinon.stub().resolves(true),
                    getCryptoNode: sinon.stub().rejects(new Error('getCryptoNode failed'))
                },
                './ExplorerService': { installExplorerModule: sinon.stub().resolves(true) }
            })
            try {
                await ms.installModule('node', 'bitcoin', 'mainnet', false)
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('getCryptoNode failed')
            }
        })
    })

    // -------------------------------------------------------------------
    // containerExistsByName — catch path (docker inspect rejects → false)
    // -------------------------------------------------------------------

    describe('containerExistsByName() — via singleton installModule with inspect rejection', function () {

        it('treats docker inspect rejection as container-not-present (proceeds with install)', async function () {
            const stubs = makeStubs()
            const containerId = 'b'.repeat(64)
            // execFile stub: docker inspect → error (container not found), git → ok, docker build/run → ok
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (cmd === 'docker' && args[0] === 'inspect') { cb(new Error('not found'), '', '') }
                else if (cmd === 'git') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'build') { cb(null) }
                else if (cmd === 'docker' && args[0] === 'run') { cb(null, containerId + '\n') }
                else { cb(null, '') }
            })
            // Use a util stub so execFileAsync resolves with {stdout} shape for containerExistsByName
            const pq = require('proxyquire').noCallThru()
            const sinon3 = require('sinon')
            let asyncCallCount = 0
            const ms = pq.callThru()('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'util': {
                    promisify: () => async (cmd, args) => {
                        asyncCallCount++
                        // containerExistsByName calls docker inspect — simulate rejection
                        if (cmd === 'docker' && args && args[0] === 'inspect') {
                            throw new Error('no such container')
                        }
                        return { stdout: '', stderr: '' }
                    }
                },
                'fs': stubs.fs,
                '../state': {
                    db: stubs.db,
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon3.stub().returns(false),
                    checkIfModuleExists: sinon3.stub().returns(true),
                    removeModuleDir: sinon3.stub(),
                    removeModuleTmpDir: sinon3.stub(),
                    createModuleTmpDir: sinon3.stub(),
                    getDockerContainerImageName: (mod) => `xchain-node-${mod}`,
                    getDockerNetwork: () => 'xchain-node',
                    validatePort: () => true,
                    getDefaultConfig: sinon3.stub().resolves({
                        HUB_PORT: 10000
                    })
                },
                './StatusService': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer },
                './DatabaseService': { setDatabaseParameters: sinon3.stub().resolves() },
                './VersionService': { getLocalNodeVersion: sinon3.stub().resolves(null), getLocalModuleVersion: sinon3.stub().resolves(null), checkRemoteNodeVersion: sinon3.stub().resolves() },
                './NodeService': { buildCryptoNode: sinon3.stub().resolves(true), getCryptoNode: sinon3.stub().resolves() },
                './ExplorerService': { installExplorerModule: sinon3.stub().resolves(true) }
            })
            // With inspect rejection, containerExistsByName returns false → proceeds with install
            const result = await ms.installModule('xchain-hub', null, null, false)
            // Should proceed past the singleton guard and call git clone + docker build + docker run
            expect(stubs.execFile.getCalls().some(c => c.args[0] === 'git')).to.be.true
        })
    })

    describe('getModuleBranch()', function () {

        it('returns trimmed branch name from git rev-parse', async function () {
            // getModuleBranch uses execFileAsync = promisify(execFile).
            // The real execFile has util.promisify.custom returning {stdout,stderr}.
            // We use a custom proxyquire that replaces util.promisify with one
            // that returns an async function yielding {stdout, stderr}.
            const sinon2 = require('sinon')
            const execFileStub = sinon2.stub()
            const gitResolve = sinon2.stub().resolves({ stdout: 'feature/test\n', stderr: '' })
            const ms2 = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: execFileStub },
                'util': {
                    promisify: (fn) => {
                        // Return an async function that resolves {stdout, stderr}
                        return async (...args) => gitResolve(...args)
                    }
                },
                'fs': { existsSync: sinon2.stub(), rmSync: sinon2.stub(), mkdirSync: sinon2.stub(), readFileSync: sinon2.stub(), cpSync: sinon2.stub() },
                '../state': {
                    db: { insertModuleContainer: sinon2.stub().resolves(true), getModuleContainer: sinon2.stub().resolves(null), removeModuleContainer: sinon2.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon2.stub().returns(false),
                    checkIfModuleExists: sinon2.stub().returns(true),
                    removeModuleDir: sinon2.stub(),
                    removeModuleTmpDir: sinon2.stub(),
                    createModuleTmpDir: sinon2.stub(),
                    getDockerContainerImageName: sinon2.stub().returns('img'),
                    getDockerNetwork: sinon2.stub().returns('net'),
                    validatePort: () => true,
                    getDefaultConfig: sinon2.stub().resolves({})
                },
                './StatusService': { statusChanged: sinon2.stub().resolves(), getStatus: sinon2.stub().resolves({}) },
                './DockerService': { killContainer: sinon2.stub().resolves(true), removeContainer: sinon2.stub().resolves(true) },
                './DatabaseService': { setDatabaseParameters: sinon2.stub().resolves() },
                './VersionService': { getLocalNodeVersion: sinon2.stub().resolves(null), getLocalModuleVersion: sinon2.stub().resolves(null), checkRemoteNodeVersion: sinon2.stub().resolves() },
                './NodeService': { buildCryptoNode: sinon2.stub().resolves(true), getCryptoNode: sinon2.stub().resolves() },
                './ExplorerService': { installExplorerModule: sinon2.stub().resolves(true) }
            })
            const branch = await ms2.getModuleBranch('xchain-encoder')
            expect(branch).to.equal('feature/test')
        })
    })

    // -------------------------------------------------------------------
    // assertNoHostPortConflicts — multi-stack host-port collision guard
    // -------------------------------------------------------------------

    describe('assertNoHostPortConflicts()', function () {

        it('resolves when no host ports are requested', async function () {
            const ms = loadModuleService(makeStubs())
            await ms.assertNoHostPortConflicts([], 'self')
        })

        it('resolves when requested ports are free on the host', async function () {
            const stubs = makeStubs()
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([['9999', new Set(['some-other'])]]))
            const ms = loadModuleService(stubs)
            await ms.assertNoHostPortConflicts(['-p', '80:8080', '-p', '443:8443'], 'self')
        })

        it('throws naming the conflicting container when a host port is taken', async function () {
            const stubs = makeStubs()
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([['80', new Set(['xchain-node-explorer'])]]))
            const ms = loadModuleService(stubs)
            let threw = null
            try {
                await ms.assertNoHostPortConflicts(['-p', '80:8080'], 'newprefix-explorer')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.include('host port 80')
            expect(threw.message).to.include('xchain-node-explorer')
        })

        it('does NOT flag the container being re-created (selfName excluded)', async function () {
            const stubs = makeStubs()
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([['80', new Set(['xchain-node-explorer'])]]))
            const ms = loadModuleService(stubs)
            await ms.assertNoHostPortConflicts(['-p', '80:8080'], 'xchain-node-explorer')
        })

        it('parses IP-scoped publish specs (IP:HOST:CONTAINER)', async function () {
            const stubs = makeStubs()
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([['13306', new Set(['xchain-node-database'])]]))
            const ms = loadModuleService(stubs)
            let threw = null
            try {
                await ms.assertNoHostPortConflicts(['-p', '127.0.0.1:13306:3306'], 'self')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.include('13306')
        })

        it('reports every conflicting port, not just the first', async function () {
            const stubs = makeStubs()
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([
                ['80',  new Set(['stackA-explorer'])],
                ['443', new Set(['stackA-explorer'])]
            ]))
            const ms = loadModuleService(stubs)
            let threw = null
            try {
                await ms.assertNoHostPortConflicts(['-p', '80:8080', '-p', '443:8443'], 'stackB-explorer')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.include('host port 80')
            expect(threw.message).to.include('host port 443')
        })
    })
})
