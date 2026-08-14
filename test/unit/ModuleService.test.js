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

const { modulesUrls, XChainService, DEFAULT_NODE_PREFIX } = require('../../src/config/constants')

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
        forceRemoveContainerByName: sinon.stub().resolves(true),
        getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } }),
        // No published host ports by default → buildAndUp's pre-flight conflict
        // check is a no-op. Conflict tests override this with a populated Map.
        getPublishedHostPorts: sinon.stub().resolves(new Map())
    }
}

function loadModuleService(stubs, constantsOverride, extraProxies) {
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
        // Mirrors ConfigService.getUtxoTrackerVolumeName's real NODE_PREFIX
        // handling (see the F11 test below): the legacy exemption for the
        // default prefix, and a prefixed name otherwise.
        getUtxoTrackerVolumeName: (coin, net) => {
            const nodePrefix = (constantsOverride && constantsOverride.NODE_PREFIX) || DEFAULT_NODE_PREFIX
            const prefix = nodePrefix === DEFAULT_NODE_PREFIX ? '' : `${nodePrefix}-`
            return `${prefix}xchain-utxo-tracker-${coin}-${net}-data`
        },
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
            forceRemoveContainerByName: stubs.forceRemoveContainerByName,
            getStatusFromContainer: stubs.getStatusFromContainer,
            getPublishedHostPorts: stubs.getPublishedHostPorts
        },
        './DatabaseService': {
            setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves()
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
    if (extraProxies) {
        Object.assign(proxies, extraProxies)
    }
    return proxyquire('../../src/services/ModuleService', proxies)
}

// A few tests need call-through (they stub only part of a dependency and want the
// real exports for the rest). `proxyquire` is a process-wide SINGLETON, so calling
// .callThru() on it leaves call-through ON for every later proxyquire in the whole
// mocha run, including other test files. Scope the flip to the single load that
// asked for it.
function proxyquireCallThru(request, stubs) {
    const pq = require('proxyquire')
    pq.callThru()
    try {
        return pq(request, stubs)
    } finally {
        pq.noCallThru()
    }
}

describe('ModuleService', function () {

    // Venue independence: under call-through, a DockerService stub that omits
    // getPublishedHostPorts silently falls back to the REAL probe, which shells
    // out to `docker ps` on the host running the suite. Such a test passes on a
    // laptop with no docker and fails on a CI venue that happens to publish the
    // port the test asks for (one venue held port 3001 with a live utxo-tracker).
    // Replace the real probe for the duration of this file so a missing stub fails
    // the same way everywhere instead of depending on what the host is running.
    const RealDockerService = require('../../src/services/DockerService')
    const realGetPublishedHostPorts = RealDockerService.getPublishedHostPorts

    before(function () {
        RealDockerService.getPublishedHostPorts = async function () {
            throw new Error(
                'unit test reached the real host-port probe: stub DockerService.getPublishedHostPorts'
            )
        }
    })

    after(function () {
        RealDockerService.getPublishedHostPorts = realGetPublishedHostPorts
    })

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
            // Exactly one CLONE. Counting every execFile call instead would drift with
            // the source-identity reads that follow a clone, which are not clones.
            const clones = stubs.execFile.getCalls().filter(c => c.args[1][0] === 'clone')
            expect(clones.length).to.equal(1)
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
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName, getStatusFromContainer: stubs.getStatusFromContainer },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() }
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
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName, getStatusFromContainer: stubs.getStatusFromContainer },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() }
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

        it('passes environment variables via the child env (bare --env NAME), not as argv values', async function () {
            const stubs = makeStubs()
            let runArgs = null
            let runOpts = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    runArgs = args
                    runOpts = opts
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            // Names on the command line...
            expect(runArgs).to.include('--env')
            expect(runArgs).to.include('NETWORK')
            expect(runArgs).to.include('NODE_PORT')
            // ...values only in the child process env (keeps secrets off argv).
            expect(runOpts.env.NETWORK).to.equal('bitcoin-mainnet')
            expect(runOpts.env.NODE_PORT).to.equal('8332')
            expect(runArgs).to.not.include('NETWORK=bitcoin-mainnet')
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
    // buildAndUp: reuseImage
    // -------------------------------------------------------------------

    // A container freezes its config env at `docker run`, so correcting a
    // value it carries means recreating it. The normal path also re-clones the module
    // and its bundled libraries from GitHub, which turns a credential repair into an
    // unreviewed version change on a live venue.
    describe('buildAndUp() reuseImage', function () {

        // `docker image inspect` goes through promisify(execFile); a sinon stub carries
        // no promisify.custom, so it is driven by the trailing callback like the rest.
        function dockerStub(stubs, { imageExists = true } = {}) {
            const seen = []
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                seen.push({ cmd, args })
                if (args[0] === 'image') {
                    if (imageExists) cb(null, 'sha256:abc\n')
                    else cb(new Error('No such image'))
                } else if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, 'e'.repeat(64) + '\n')
                } else {
                    cb(null, '')
                }
            })
            return seen
        }

        it('creates the container without running docker build', async function () {
            const stubs = makeStubs()
            const seen = dockerStub(stubs)
            const ms = loadModuleService(stubs)
            const id = await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, false, null, { reuseImage: true })
            expect(id).to.equal('e'.repeat(64))
            expect(seen.some(c => c.cmd === 'docker' && c.args[0] === 'build')).to.be.false
            const run = seen.find(c => c.args[0] === 'run')
            expect(run.args).to.include('xchain-node-bitcoin-mainnet-xchain-encoder')
        })

        it('verifies the tag exists first, and says so when it does not', async function () {
            const stubs = makeStubs()
            const seen = dockerStub(stubs, { imageExists: false })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, false, null, { reuseImage: true })
                expect.fail('a missing image must not fall through to docker run')
            } catch (err) {
                expect(err.message).to.match(/No local image tagged xchain-node-bitcoin-mainnet-xchain-encoder/)
                expect(err.message).to.match(/update xchain-encoder bitcoin mainnet/)
            }
            expect(seen.some(c => c.args[0] === 'run')).to.be.false
        })

        it('does not re-clone the bundled libraries', async function () {
            const stubs = makeStubs()
            const seen = dockerStub(stubs)
            const ms = loadModuleService(stubs)
            // xchain-indexer bundles xchain-vm, which the build path re-clones every time.
            await ms.buildAndUp('xchain-indexer', 'bitcoin', 'mainnet', null, false, null, { reuseImage: true })
            expect(seen.some(c => c.cmd === 'git')).to.be.false
            expect(stubs.fs.rmSync.called).to.be.false
        })

        it('still tears the old container down and registers the new id', async function () {
            const stubs = makeStubs()
            dockerStub(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', 'old-id-123', false, null, { reuseImage: true })
            expect(stubs.killContainer.calledWith('old-id-123')).to.be.true
            expect(stubs.removeContainer.calledWith('old-id-123')).to.be.true
            expect(stubs.forceRemoveContainerByName.calledWith('xchain-node-bitcoin-mainnet-xchain-encoder')).to.be.true
            expect(stubs.db.insertModuleContainer.calledWith('xchain-encoder', 'bitcoin', 'mainnet', 'e'.repeat(64))).to.be.true
        })

        it('leaves the default path building the image', async function () {
            const stubs = makeStubs()
            const seen = dockerStub(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(seen.some(c => c.args[0] === 'build')).to.be.true
            expect(seen.some(c => c.args[0] === 'image')).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // buildAndUp: healthcheck args
    // -------------------------------------------------------------------

    describe('buildAndUp() healthcheck args', function () {

        function captureRunArgs(stubs) {
            let runArgs = null
            // Handle git clone (for modules with LIBRARY_BUNDLES like xchain-indexer)
            // by responding immediately, and handle docker build/run normally.
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (cmd === 'git') { cb(null) }
                else if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            // Also stub fs.cpSync and fs.rmSync (used by bundled-library staging)
            stubs.fs.cpSync = sinon.stub()
            stubs.fs.rmSync = sinon.stub()
            return () => runArgs
        }

        it('includes --health-cmd for encoder (http_get probe)', async function () {
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('/status')
            expect(args[cmdIdx + 1]).to.include('3003')
        })

        it('includes --health-cmd for decoder (http_get probe on /live, not /status)', async function () {
            // The decoder's /status is process-alive + DB-reachable only, so a block
            // loop retrying one height forever answers 200 while lag grows without
            // bound and autoheal (which reads nothing but Health.Status) never fires.
            // /live is /status plus the stall check, so the probe measures liveness.
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('/live')
            expect(args[cmdIdx + 1]).to.not.include('/status')
            expect(args[cmdIdx + 1]).to.include('3002')
        })

        it('includes --health-cmd for indexer (http_get probe)', async function () {
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-indexer', 'bitcoin', 'mainnet')
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('/status')
            expect(args[cmdIdx + 1]).to.include('3004')
        })

        it('probes health (not ping) for hub (jsonrpc_health probe)', async function () {
            // The hub's ping is a bare SELECT 1; its health method 503s on a tripped
            // DB breaker, a stale oracle round, and consensus-input alerting. Probing
            // ping let a hub that had stopped producing consensus data read healthy.
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-hub', null, null)
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('"method":"health"')
            expect(args[cmdIdx + 1]).to.not.include('"method":"ping"')
            expect(args[cmdIdx + 1]).to.include('10000')
        })

        it('includes --health-cmd for explorer (jsonrpc_ping probe)', async function () {
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-explorer', null, null)
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('ping')
            expect(args[cmdIdx + 1]).to.include('8080')
        })

        it('probes health (not ping) for regtest-miner (jsonrpc_health probe)', async function () {
            // The miner's API is JSON-RPC only (no GET /status route); an http_get
            // probe 500s forever and marks the container permanently unhealthy. Its
            // ping always answers 200 and reports wallet readiness in the body only,
            // so a miner stalled on credential drift stayed healthy; health 503s.
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-regtest-miner', 'bitcoin', 'mainnet')
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('"method":"health"')
            expect(args[cmdIdx + 1]).to.not.include('"method":"ping"')
            expect(args[cmdIdx + 1]).to.not.include('/status')
            expect(args[cmdIdx + 1]).to.include('3005')
        })

        it('probes /health (not /status) for sync (http_get probe)', async function () {
            // Sync's /status runs a SELECT COUNT(*) census over every replicated
            // table; on a heavy multi-chain host that exceeds the 5s healthcheck
            // timeout and marks a correctly-serving container UNHEALTHY.
            // The probe must hit the O(1) /health liveness route instead.
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-sync', null, null)
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('/health')
            expect(args[cmdIdx + 1]).to.not.include('/status')
            expect(args[cmdIdx + 1]).to.include('3006')
        })

        it('grants sync a start period covering the whole MAX_HUB_WAIT_MS hub wait', async function () {
            // /health answers 503 'starting' until SyncService.start() returns, and
            // start() waits on the hub for MAX_HUB_WAIT_MS (default 300000ms). At the
            // former 45s start period plus 3 retries at 15s, a hub slower than ~90s
            // marked a correctly-starting sync container UNHEALTHY. The window must
            // cover the wait the probe now judges.
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-sync', null, null)
            const args = getRunArgs()
            const idx = args.indexOf('--health-start-period')
            expect(idx).to.be.greaterThan(-1)
            const seconds = parseInt(String(args[idx + 1]).replace(/s$/, ''), 10)
            const retryWindow = 3 * 15
            expect(seconds).to.be.at.least(300 - retryWindow)
        })

        it('warns and returns [] when the descriptor portKey is missing from the env', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const logSpy = sinon.spy(console, 'log')
            try {
                // DECODER_API_PORT deliberately absent from the env
                const args = ms.buildHealthcheckArgs('xchain-decoder', {})
                expect(args).to.deep.equal([])
                const warned = logSpy.getCalls().map(c => c.args.join(' ')).join('\n')
                expect(warned).to.match(/WARNING: no healthcheck for xchain-decoder/)
                expect(warned).to.match(/DECODER_API_PORT is unset/)
            } finally {
                logSpy.restore()
            }
        })

        it('does not warn and returns health args when the portKey is present', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const logSpy = sinon.spy(console, 'log')
            try {
                const args = ms.buildHealthcheckArgs('xchain-decoder', { DECODER_API_PORT: '3002' })
                expect(args).to.include('--health-cmd')
                const warned = logSpy.getCalls().map(c => c.args.join(' ')).join('\n')
                expect(warned).to.not.match(/WARNING: no healthcheck/)
            } finally {
                logSpy.restore()
            }
        })

        // The healthcheck grace window is env-tunable per service so an
        // operator can widen it for a long bootstrap restore.
        it('honors XCHAIN_NODE_HEALTH_START_PERIOD_<SERVICE> override', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const saved = process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
            process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = '900s'
            try {
                const args = ms.buildHealthcheckArgs('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3003' })
                const i = args.indexOf('--health-start-period')
                expect(i).to.be.greaterThan(-1)
                expect(args[i + 1]).to.equal('900s')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
                else process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = saved
            }
        })

        // The comment block documents `=900` (bare seconds) as a valid override, but
        // docker parses --health-start-period with Go's time.ParseDuration, which
        // rejects a unitless number and fails the whole `docker run`. Bare seconds
        // must therefore reach docker with an 's' appended, never verbatim.
        it('normalizes a bare-seconds start-period override to a docker duration', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const saved = process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
            process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = '900'
            try {
                const args = ms.buildHealthcheckArgs('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3003' })
                const i = args.indexOf('--health-start-period')
                expect(args[i + 1]).to.equal('900s')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
                else process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = saved
            }
        })

        it('emits a docker-parsable duration for every start-period it returns', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const saved = process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
            try {
                for (const raw of ['900', '900s', '2m', '1h', '1500ms', 'not-a-duration', '']) {
                    if (raw === '') delete process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
                    else process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = raw
                    const args = ms.buildHealthcheckArgs('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3003' })
                    const i = args.indexOf('--health-start-period')
                    expect(args[i + 1], 'override ' + JSON.stringify(raw)).to.match(/^\d+(ms|s|m|h)$/)
                }
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
                else process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = saved
            }
        })

        it('ignores a malformed start-period override and keeps the descriptor default', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const saved = process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
            process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = 'not-a-duration'
            try {
                const args = ms.buildHealthcheckArgs('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3003' })
                const i = args.indexOf('--health-start-period')
                expect(args[i + 1]).to.equal('60s')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
                else process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = saved
            }
        })

        it('returns [] with no warning for a module that has no healthcheck descriptor', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const logSpy = sinon.spy(console, 'log')
            try {
                const args = ms.buildHealthcheckArgs('xchain-e2e-test', { WHATEVER: '1' })
                expect(args).to.deep.equal([])
                const warned = logSpy.getCalls().map(c => c.args.join(' ')).join('\n')
                expect(warned).to.not.match(/WARNING: no healthcheck/)
            } finally {
                logSpy.restore()
            }
        })

        it('includes --health-interval, --health-timeout, --health-retries, --health-start-period for encoder', async function () {
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            const args = getRunArgs()
            expect(args).to.include('--health-interval')
            expect(args).to.include('--health-timeout')
            expect(args).to.include('--health-retries')
            expect(args).to.include('--health-start-period')
        })

        it('omits healthcheck args for onlyExecution containers', async function () {
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)
            const args = getRunArgs()
            expect(args).to.not.include('--health-cmd')
        })
    })

    // -------------------------------------------------------------------
    // installModule: singleton guard
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
            // Must short-circuit before the build path; no git clone attempted.
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
                // The catch now rethrows the original error instead of masking
                // every failure in the block with a fixed "kill" message.
                expect(err.message).to.include('kill failed')
            }
        })
    })

    // -------------------------------------------------------------------
    // cloneGit: branch coverage
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
                // Only the clone call; the identity reads that follow it are also git.
                if (args[0] === 'clone') cloneArgs = args
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder', false, false, 'feature/test')
            expect(cloneArgs).to.include('-b')
            expect(cloneArgs).to.include('feature/test')
        })

        it('rejects (no silent fallback) when the requested branch is not found', async function () {
            // uuid:4f649bd0: a typo'd or deleted branch must fail the install
            // rather than silently building the default branch's code.
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callCount++
                cb(new Error('git error'), '', 'remote: branch not found on server')
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'missing-branch')
                expect.fail()
            } catch (err) {
                expect(err).to.include("branch 'missing-branch' not found")
                expect(callCount).to.equal(1)
            }
        })
    })

    // -------------------------------------------------------------------
    // installModule: DB module path
    // -------------------------------------------------------------------

    describe('installModule(): DB module', function () {

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
                    forceRemoveContainerByName: stubs.forceRemoveContainerByName,
                    getStatusFromContainer: stubs.getStatusFromContainer
                },
                './DatabaseService': {
                    setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves(),
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
                    forceRemoveContainerByName: stubs.forceRemoveContainerByName,
                    getStatusFromContainer: stubs.getStatusFromContainer
                },
                './DatabaseService': {
                    setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves(),
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
    // installModule: EXPLORER module path
    // -------------------------------------------------------------------

    describe('installModule(): explorer module', function () {

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
                    forceRemoveContainerByName: stubs.forceRemoveContainerByName,
                    getStatusFromContainer: stubs.getStatusFromContainer
                },
                './DatabaseService': {
                    setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves()
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
    // installModule: generic module, skip-when-version-present
    // -------------------------------------------------------------------

    describe('installModule(): generic module, container version already known', function () {

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
                    forceRemoveContainerByName: stubs.forceRemoveContainerByName,
                    getStatusFromContainer: stubs.getStatusFromContainer
                },
                './DatabaseService': {
                    setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves()
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
    // installModule: generic module full build path
    // -------------------------------------------------------------------

    describe('installModule(): generic module full build', function () {

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
    // buildAndUp: port validation + hub/sync/indexer/regtest branches
    // -------------------------------------------------------------------

    describe('buildAndUp(): module-specific port/volume branches', function () {

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
            // xchain-explorer has LIBRARY_BUNDLES=['xchain-vm'], so buildAndUp clones + stages it first.
            stubs.fs.cpSync = sinon.stub()
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

        it('mounts the capability config DIRECTORY when HUB_CAPABILITY_CONFIG is set', async function () {
            const stubs = makeStubs()
            const capsHostDir = '/host/validator/hub-caps'
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
                    forceRemoveContainerByName: stubs.forceRemoveContainerByName,
                    getStatusFromContainer: stubs.getStatusFromContainer,
                    getPublishedHostPorts: stubs.getPublishedHostPorts
                },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
                './ValidatorService': {
                    getCapabilityConfigMountDir: () => capsHostDir,
                    CAPS_CONTAINER_DIR: '/validator'
                },
                './VersionService': { getLocalNodeVersion: sinon.stub().resolves(null), getLocalModuleVersion: sinon.stub().resolves(null), checkRemoteNodeVersion: sinon.stub().resolves() },
                './NodeService': { buildCryptoNode: sinon.stub().resolves(true), getCryptoNode: sinon.stub().resolves() },
                './ExplorerService': { installExplorerModule: sinon.stub().resolves(true) }
            })
            await ms2.buildAndUp('xchain-hub', 'bitcoin', 'mainnet')
            // Should have a volume mount for the capability config, and it must be
            // the containing DIRECTORY: a single-file bind mount permanently breaks
            // `docker cp` against this container.
            expect(runArgs).to.include('-v')
            expect(runArgs).to.include(capsHostDir + ':/validator:ro')
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
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
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

        it('runs the host-port preflight BEFORE docker build so a conflict fails fast', async function () {
            const stubs = makeStubs()
            // ENCODER_PORT/ENCODER_API_PORT both resolve to 3003 (see makeStubs'
            // getDefaultConfig); report that host port as already published by a
            // differently-named container so assertNoHostPortConflicts rejects.
            stubs.getPublishedHostPorts = sinon.stub().resolves(new Map([['3003', new Set(['other-stack-container'])]]))
            let buildInvoked = false
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] } else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { buildInvoked = true; cb(null) }
                else if (args[0] === 'run') { cb(null, 'a'.repeat(64) + '\n') }
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail('Should have rejected on host port conflict')
            } catch (err) {
                expect(String(err)).to.include('Host port conflict')
            }
            expect(buildInvoked).to.be.false
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
    // installModule: BootstrapService lazy-require paths (utxo-tracker / decoder fresh)
    // -------------------------------------------------------------------

    describe('installModule(): bootstrap paths via @global proxyquire', function () {

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
            const ms = proxyquireCallThru('../../src/services/ModuleService', {
                'child_process': { execFile: execFileStub },
                // renameSync must be stubbed under a call-through load: cloneGit's
                // rewrite path stages the clone and swaps it in, and a
                // call-through would rename real paths on the test host.
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub(), renameSync: sinon3.stub() },
                '../state': {
                    db: { insertModuleContainer: sinon3.stub().resolves(true), getModuleContainer: sinon3.stub().resolves(null), removeModuleContainer: sinon3.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': configStub,
                './StatusService': { statusChanged: sinon3.stub().resolves(), getStatus: sinon3.stub().resolves({}) },
                './DockerService': { killContainer: sinon3.stub().resolves(true), removeContainer: sinon3.stub().resolves(true), forceRemoveContainerByName: sinon3.stub().resolves(true), getPublishedHostPorts: sinon3.stub().resolves(new Map()) },
                './DatabaseService': { setDatabaseParameters: sinon3.stub().resolves(), setHubDatabaseParameters: sinon3.stub().resolves() },
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
            const ms = proxyquireCallThru('../../src/services/ModuleService', {
                'child_process': { execFile: execFileStub },
                // renameSync must be stubbed under a call-through load: cloneGit's
                // rewrite path stages the clone and swaps it in, and a
                // call-through would rename real paths on the test host.
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub(), renameSync: sinon3.stub() },
                '../state': {
                    db: { insertModuleContainer: sinon3.stub().resolves(true), getModuleContainer: sinon3.stub().resolves(null), removeModuleContainer: sinon3.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': configStub,
                './StatusService': { statusChanged: sinon3.stub().resolves(), getStatus: sinon3.stub().resolves({}) },
                './DockerService': { killContainer: sinon3.stub().resolves(true), removeContainer: sinon3.stub().resolves(true), forceRemoveContainerByName: sinon3.stub().resolves(true), getPublishedHostPorts: sinon3.stub().resolves(new Map()) },
                './DatabaseService': { setDatabaseParameters: setDatabaseParametersStub },
                // Stubbed for the same reason DockerService.getPublishedHostPorts is:
                // the real guard shells out to `docker inspect` and would read
                // whatever containers the venue happens to be running.
                './DbCredentialDrift': { assertNoDbCredentialDrift: sinon3.stub().resolves([]) },
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

        // uuid:cb0bd3be: the drift guard used to run only inside
        // setDatabaseParameters, i.e. after buildAndUp had already killed and
        // replaced the container, so a refusal left the working decoder destroyed
        // and locked out of MariaDB. The refusal must now land before any teardown.
        it('refuses a drifting decoder update before tearing the container down', async function () {
            const sinon3 = require('sinon')
            const driftError = new Error('Refusing to rotate the bitcoin mainnet MariaDB accounts')
            driftError.code = 'DB_CREDENTIAL_DRIFT'
            const assertNoDbCredentialDriftStub = sinon3.stub().rejects(driftError)
            const setDatabaseParametersStub = sinon3.stub().resolves()
            const killContainerStub = sinon3.stub().resolves(true)
            const removeContainerStub = sinon3.stub().resolves(true)
            const forceRemoveContainerByNameStub = sinon3.stub().resolves(true)
            const cloneExecFileStub = sinon3.stub()
            cloneExecFileStub.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                cb(null, '')
            })
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
                    DECODER_DB_PASS: 'rotated-decoder-pass', INDEXER_DB_PASS: 'indexer-pass'
                })
            }
            const ms = proxyquireCallThru('../../src/services/ModuleService', {
                'child_process': { execFile: cloneExecFileStub },
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub(), renameSync: sinon3.stub() },
                '../state': {
                    db: { insertModuleContainer: sinon3.stub().resolves(true), getModuleContainer: sinon3.stub().resolves(null), removeModuleContainer: sinon3.stub().resolves(true) },
                    getRemoteModuleVersions: () => ({}),
                    getLastStatus: () => null
                },
                './ConfigService': configStub,
                './StatusService': { statusChanged: sinon3.stub().resolves(), getStatus: sinon3.stub().resolves({}) },
                './DockerService': { killContainer: killContainerStub, removeContainer: removeContainerStub, forceRemoveContainerByName: forceRemoveContainerByNameStub, getPublishedHostPorts: sinon3.stub().resolves(new Map()) },
                './DatabaseService': { setDatabaseParameters: setDatabaseParametersStub, setHubDatabaseParameters: sinon3.stub().resolves() },
                './DbCredentialDrift': { assertNoDbCredentialDrift: assertNoDbCredentialDriftStub },
                './BootstrapService': {
                    utxoTrackerVolumeHasData: sinon3.stub().resolves(true),
                    ensureBootstrapUtxoTracker: sinon3.stub().resolves(),
                    mariaDbModuleHasData: sinon3.stub().resolves(true),
                    ensureBootstrapMariaDb: sinon3.stub().resolves()
                },
                './VersionService': { getLocalNodeVersion: sinon3.stub().resolves(null), getLocalModuleVersion: sinon3.stub().resolves(null), checkRemoteNodeVersion: sinon3.stub().resolves() },
                './NodeService': { buildCryptoNode: sinon3.stub().resolves(true), getCryptoNode: sinon3.stub().resolves() },
                './ExplorerService': { installExplorerModule: sinon3.stub().resolves(true) }
            })

            let thrown = null
            try {
                await ms.installModule('xchain-decoder', 'bitcoin', 'mainnet', true, 'old-container-id')
            } catch (err) { thrown = err }

            expect(thrown).to.not.equal(null)
            expect(thrown.code).to.equal('DB_CREDENTIAL_DRIFT')
            expect(assertNoDbCredentialDriftStub.calledOnce).to.be.true
            // The container under rebuild is excluded, or the guard would refuse the
            // very rebuild that clears its own stale password.
            expect(assertNoDbCredentialDriftStub.firstCall.args[3])
                .to.deep.equal({ excludeModules: ['xchain-decoder'] })
            // Nothing was torn down, re-cloned, or provisioned: the refusal is
            // worth having only if it leaves the working stack running.
            expect(killContainerStub.called).to.be.false
            expect(removeContainerStub.called).to.be.false
            expect(forceRemoveContainerByNameStub.called).to.be.false
            expect(setDatabaseParametersStub.called).to.be.false
            expect(cloneExecFileStub.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // installModule: NODE_MODULE_NAME paths
    // -------------------------------------------------------------------

    describe('installModule(): node module', function () {

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
                    forceRemoveContainerByName: stubs.forceRemoveContainerByName,
                    getStatusFromContainer: stubs.getStatusFromContainer
                },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
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
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
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
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
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
    // installModule: explorer error path
    // -------------------------------------------------------------------

    describe('installModule(): explorer error path', function () {

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
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
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
    // installModule: branch switch when module already on different branch
    // -------------------------------------------------------------------

    describe('installModule(): branch switch path', function () {

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
            const currentBranchStub = sinon3.stub().resolves({ stdout: 'master\n', stderr: '' })
            const moduleDirExistsStub = sinon3.stub().returns(true)
            const ms = proxyquireCallThru('../../src/services/ModuleService', {
                'child_process': { execFile: execFileStub },
                'util': {
                    promisify: () => async (...args) => currentBranchStub(...args)
                },
                // renameSync must be stubbed under a call-through load: cloneGit's
                // rewrite path stages the clone and swaps it in, and a
                // call-through would rename real paths on the test host.
                'fs': { existsSync: sinon3.stub(), rmSync: sinon3.stub(), mkdirSync: sinon3.stub(), readFileSync: sinon3.stub(), cpSync: sinon3.stub(), renameSync: sinon3.stub() },
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
                './DockerService': { killContainer: sinon3.stub().resolves(true), removeContainer: sinon3.stub().resolves(true), forceRemoveContainerByName: sinon3.stub().resolves(true), getPublishedHostPorts: sinon3.stub().resolves(new Map()) },
                './DatabaseService': { setDatabaseParameters: sinon3.stub().resolves(), setHubDatabaseParameters: sinon3.stub().resolves() },
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
    // uninstallModule: removeModuleContainer returns false
    // -------------------------------------------------------------------

    describe('uninstallModule(): removeModuleContainer returns false', function () {

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
    // installModule: NODE path: checkRemoteNodeVersion when not in remoteVersions
    // -------------------------------------------------------------------

    describe('installModule(): node: checkRemoteNodeVersion called when coin not in remoteVersions', function () {

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
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
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
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() },
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
    // containerExistsByName: catch path (docker inspect rejects → false)
    // -------------------------------------------------------------------

    describe('containerExistsByName(): via singleton installModule with inspect rejection', function () {

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
            const sinon3 = require('sinon')
            let asyncCallCount = 0
            const ms = proxyquireCallThru('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'util': {
                    promisify: () => async (cmd, args) => {
                        asyncCallCount++
                        // containerExistsByName calls docker inspect; simulate rejection
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
                // getPublishedHostPorts must be stubbed: this load calls through, and
                // HUB_PORT below is published as a host port, so the real probe would
                // shell out to the host's docker and fail wherever 10000 is taken.
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName, getPublishedHostPorts: stubs.getPublishedHostPorts },
                './DatabaseService': { setDatabaseParameters: sinon3.stub().resolves(), setHubDatabaseParameters: sinon3.stub().resolves() },
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
                './DockerService': { killContainer: sinon2.stub().resolves(true), removeContainer: sinon2.stub().resolves(true), forceRemoveContainerByName: sinon2.stub().resolves(true) },
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
    // assertNoHostPortConflicts: multi-stack host-port collision guard
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

    // -------------------------------------------------------------------
    // Venue independence of the suite itself
    // -------------------------------------------------------------------

    describe('unit-suite venue independence', function () {

        it('trips the guard instead of probing the host when a call-through load forgets the stub', async function () {
            const stubs = makeStubs()
            const ms = proxyquireCallThru('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': { db: stubs.db, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                // Deliberately omits getPublishedHostPorts, the mistake this guard catches.
                './DockerService': { killContainer: stubs.killContainer, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName }
            })
            let threw = null
            try {
                await ms.assertNoHostPortConflicts(['-p', '3001:3001'], 'self')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(Error)
            expect(threw.message).to.include('stub DockerService.getPublishedHostPorts')
        })

        it('leaves proxyquire in noCallThru mode after a call-through load', async function () {
            const stubs = makeStubs()
            proxyquireCallThru('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                './DockerService': { getPublishedHostPorts: stubs.getPublishedHostPorts }
            })
            // The flip must not outlive that one load: a plain proxyquire with the same
            // partial stub has to shadow the whole dependency, so the missing probe reads
            // as undefined rather than falling back to the real (here guarded) export.
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': { db: stubs.db, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                './DockerService': { killContainer: stubs.killContainer }
            })
            let threw = null
            try {
                await ms.assertNoHostPortConflicts(['-p', '3001:3001'], 'self')
            } catch (err) { threw = err }
            expect(threw).to.be.an.instanceOf(TypeError)
        })
    })

    // -------------------------------------------------------------------
    // cloneGit: non-destructive rewrite
    // -------------------------------------------------------------------

    describe('cloneGit() rewrite over an existing checkout', function () {

        const MODULE = 'xchain-encoder'
        const DEST   = '/modules/' + MODULE

        // Loads ModuleService with a real-ish fs surface (spies) and an
        // existing module checkout, which is the only case that used to be
        // destructive.
        function loadWithExistingCheckout(execFileFake) {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                renameSync: sinon.stub()
            }
            const execFileStub = sinon.stub().callsFake(execFileFake)
            const removeModuleDir = sinon.stub()
            const ms = proxyquire('../../src/services/ModuleService', {
                'child_process': { execFile: execFileStub },
                'fs': fsStub,
                '../state': { db: { insertModuleContainer: sinon.stub().resolves(true) }, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                './ConfigService': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(true),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir,
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub(),
                    getDockerNetwork: sinon.stub(),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './StatusService': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
                './DockerService': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves(), forceRemoveContainerByName: sinon.stub().resolves(), getPublishedHostPorts: sinon.stub().resolves(new Map()) },
                './DatabaseService': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() }
            })
            return { ms, fs: fsStub, execFile: execFileStub, removeModuleDir }
        }

        function callbackOf(rest) {
            return typeof rest[0] === 'function' ? rest[0] : rest[1]
        }

        it('clones into a staging dir, never over the live checkout', async function () {
            let destArg = null
            const { ms, fs } = loadWithExistingCheckout((cmd, args, ...rest) => {
                // The clone's destination, not the last git call's last argument: the
                // source-identity reads that follow a clone are git calls too.
                if (args[0] === 'clone') destArg = args[args.length - 1]
                callbackOf(rest)(null)
            })
            await ms.cloneGit(MODULE, true)
            expect(destArg).to.not.equal(DEST)
            expect(destArg).to.have.string(DEST)
            // Swap order: live checkout aside first, staged clone in second.
            expect(fs.renameSync.callCount).to.equal(2)
            expect(fs.renameSync.firstCall.args[0]).to.equal(DEST)
            expect(fs.renameSync.secondCall.args[0]).to.equal(destArg)
            expect(fs.renameSync.secondCall.args[1]).to.equal(DEST)
        })

        it('leaves the checkout in place when the branch is missing from the remote', async function () {
            // `update <svc> <chain> <net> <branch>` used to delete the
            // deploy checkout as its first step, so a branch that exists only on
            // the box took the whole module directory with it.
            const { ms, fs, removeModuleDir } = loadWithExistingCheckout((cmd, args, ...rest) => {
                callbackOf(rest)(new Error('Remote branch not found'), '', 'Remote branch xc952-mainnet-hotfix not found in upstream origin')
            })
            let threw = null
            try {
                await ms.cloneGit(MODULE, true, false, 'xc952-mainnet-hotfix')
            } catch (err) { threw = err }
            expect(threw).to.include('not found')
            expect(removeModuleDir.called).to.be.false
            expect(fs.renameSync.called).to.be.false
            // Only the staging dir is cleaned up, never the destination itself.
            for (const call of fs.rmSync.getCalls()) {
                expect(call.args[0]).to.not.equal(DEST)
            }
        })

        it('points a missing branch at the real mechanism (remote clone / local-path override)', async function () {
            const { ms } = loadWithExistingCheckout((cmd, args, ...rest) => {
                callbackOf(rest)(new Error('not found'), '', 'Remote branch not found in upstream origin')
            })
            let threw = null
            try {
                await ms.cloneGit(MODULE, true, false, 'local-only')
            } catch (err) { threw = err }
            expect(threw).to.include('XCHAIN_NODE_MODULES_URLS_OVERRIDE')
            expect(threw).to.include("remote")
        })

        it('leaves the checkout in place when the clone fails for any other reason', async function () {
            const { ms, fs, removeModuleDir } = loadWithExistingCheckout((cmd, args, ...rest) => {
                callbackOf(rest)(new Error('fatal: could not read from remote repository'))
            })
            let threw = null
            try {
                await ms.cloneGit(MODULE, true)
            } catch (err) { threw = err }
            expect(threw).to.include('Error cloning')
            expect(removeModuleDir.called).to.be.false
            expect(fs.renameSync.called).to.be.false
        })

        it('restores the original checkout when the swap-in rename fails', async function () {
            const { ms, fs } = loadWithExistingCheckout((cmd, args, ...rest) => {
                callbackOf(rest)(null)
            })
            fs.renameSync.onSecondCall().throws(new Error('EPERM: operation not permitted'))
            let threw = null
            try {
                await ms.cloneGit(MODULE, true)
            } catch (err) { threw = err }
            expect(threw).to.include('Error replacing module checkout')
            // Third rename is the restore of the set-aside original.
            expect(fs.renameSync.callCount).to.equal(3)
            expect(fs.renameSync.thirdCall.args[1]).to.equal(DEST)
        })

        it('rejects an invalid branch name before touching the filesystem', async function () {
            const { ms, fs, execFile, removeModuleDir } = loadWithExistingCheckout(() => {})
            let threw = null
            try {
                await ms.cloneGit(MODULE, true, false, 'bad branch!')
            } catch (err) { threw = err }
            expect(threw).to.include('Invalid branch name')
            expect(execFile.called).to.be.false
            expect(removeModuleDir.called).to.be.false
            expect(fs.rmSync.called).to.be.false
            expect(fs.renameSync.called).to.be.false
        })

        it('rejects an unknown module before touching the filesystem', async function () {
            const { ms, fs, removeModuleDir } = loadWithExistingCheckout(() => {})
            let threw = null
            try {
                await ms.cloneGit('not-a-module', true)
            } catch (err) { threw = err }
            expect(threw).to.include("doesn't have an url")
            expect(removeModuleDir.called).to.be.false
            expect(fs.rmSync.called).to.be.false
            expect(fs.renameSync.called).to.be.false
        })
    })

    // buildAndUp: hub consensus-env drift guard wiring (row 58). The guard itself
    // (drift detection, warn/refuse text) is pure-function tested in
    // HubConsensusEnvGuard.test.js; this only proves buildAndUp actually calls it
    // for the hub, passes it the generated env, propagates a refusal, and does
    // NOT call it for an unrelated module.
    describe('buildAndUp(): hub consensus-env drift guard wiring', function () {

        it('calls assertNoHubConsensusEnvDrift with the generated hub env', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null)
                else if (args[0] === 'run') cb(null, 'a'.repeat(64) + '\n')
                else cb(null)
            })
            const assertNoHubConsensusEnvDrift = sinon.stub().resolves([])
            const ms = loadModuleService(stubs, null, {
                './HubConsensusEnvGuard': { assertNoHubConsensusEnvDrift }
            })

            await ms.buildAndUp('xchain-hub', null, null)

            expect(assertNoHubConsensusEnvDrift.calledOnce).to.equal(true)
            expect(assertNoHubConsensusEnvDrift.firstCall.args[0]).to.deep.equal({
                'NETWORK': 'bitcoin-mainnet', 'NODE_URL': 'node', 'NODE_PORT': 8332,
                'DECODER_PORT': 3002, 'DECODER_API_PORT': 3002,
                'DECODER_BOOTSTRAP_VOLUME': '/data/bitcoin/mainnet/xchain-decoder/bootstrap/',
                'ENCODER_PORT': 3003, 'ENCODER_API_PORT': 3003,
                'UTXO_TRACKER_PORT': 3001, 'UTXO_TRACKER_API_PORT': 3001,
                'UTXO_TRACKER_BOOTSTRAP_VOLUME': '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/',
                'INDEXER_PORT': 3004, 'INDEXER_API_PORT': 3004,
                'REGTEST_MINER_PORT': 3005, 'REGTEST_MINER_API_PORT': 3005,
                'HUB_PORT': 10000, 'EXPLORER_PORT_HTTP': 18080, 'EXPLORER_API_PORT_HTTP': 8080,
                'EXPLORER_PORT_HTTPS': 18081, 'EXPLORER_API_PORT_HTTPS': 8081,
                'SYNC_PORT': 3006, 'SYNC_API_PORT': 3006
            })
        })

        it('propagates a refusal from the guard instead of building the hub', async function () {
            const stubs = makeStubs()
            const refusal = new Error('hub consensus env drift')
            refusal.code = 'HUB_CONSENSUS_ENV_DRIFT'
            const assertNoHubConsensusEnvDrift = sinon.stub().rejects(refusal)
            const ms = loadModuleService(stubs, null, {
                './HubConsensusEnvGuard': { assertNoHubConsensusEnvDrift }
            })

            let thrown = null
            try {
                await ms.buildAndUp('xchain-hub', null, null)
            } catch (err) { thrown = err }

            expect(thrown).to.equal(refusal)
            // The refusal fires before any build/create work runs.
            expect(stubs.execFile.called).to.equal(false)
        })

        it('does not call the hub guard for an unrelated module', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null)
                else if (args[0] === 'run') cb(null, 'a'.repeat(64) + '\n')
                else cb(null)
            })
            const assertNoHubConsensusEnvDrift = sinon.stub().resolves([])
            const ms = loadModuleService(stubs, null, {
                './HubConsensusEnvGuard': { assertNoHubConsensusEnvDrift }
            })

            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')

            expect(assertNoHubConsensusEnvDrift.called).to.equal(false)
        })
    })
})
