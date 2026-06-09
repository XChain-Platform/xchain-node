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
const { EventEmitter } = require('events')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNodeServiceStubs(overrides = {}) {
    const execFileStub = sinon.stub()
    const fsStub = {
        createWriteStream: sinon.stub(),
        existsSync:        sinon.stub().returns(false),
        rmSync:            sinon.stub(),
        rmdirSync:         sinon.stub(),
        renameSync:        sinon.stub(),
        writeFileSync:     sinon.stub(),
        readFileSync:      sinon.stub().returns('rpcuser=old\nrpcpassword=old\n'),
        mkdirSync:         sinon.stub(),
    }
    const dbStub = {
        insertModuleContainer: sinon.stub().resolves(true),
        isReady:               sinon.stub().returns(true)
    }
    const gitHubDownloaderStub = {
        downloadRepoVersion: sinon.stub().resolves(true)
    }
    const decompressTarGzStub = sinon.stub().resolves()
    const statusChangedStub   = sinon.stub().resolves()
    const checkRemoteNodeVersionStub = sinon.stub().resolves()
    const getDefaultConfigStub = sinon.stub().resolves({
        NODE_EXPOSED_PORT: 8333,
        NODE_PORT:         8332,
        NODE_USER:         'testuser',
        NODE_PASSWORD:     'testpass'
    })
    const getDockerContainerImageNameStub = sinon.stub().returns('xchain-node-bitcoin-mainnet-node')
    const getDockerNetworkStub            = sinon.stub().returns('xchain-node-bitcoin-mainnet')

    return {
        execFile: execFileStub,
        fs: fsStub,
        db: dbStub,
        gitHubDownloader: gitHubDownloaderStub,
        decompressTarGz: decompressTarGzStub,
        statusChanged:   statusChangedStub,
        checkRemoteNodeVersion: checkRemoteNodeVersionStub,
        getDefaultConfig: getDefaultConfigStub,
        getDockerContainerImageName: getDockerContainerImageNameStub,
        getDockerNetwork: getDockerNetworkStub,
        ...overrides
    }
}

function loadNodeService(stubs) {
    return proxyquire('../../src/services/NodeService', {
        'child_process': { execFile: stubs.execFile },
        'follow-redirects': { https: stubs.https || { get: sinon.stub() } },
        'fs': stubs.fs,
        'semver': require('semver'),
        '../state': {
            db:                     stubs.db,
            gitHubDownloader:       stubs.gitHubDownloader,
            getRemoteModuleVersions: stubs.getRemoteModuleVersions || (() => ({}))
        },
        '../utils/helpers': { decompressTarGz: stubs.decompressTarGz },
        '../config/constants': {
            NODE_MODULE_NAME:       'node',
            NODE_VERSION_FILE_NAME: '__VERSION__.txt',
            SEP:                    '-',
            Coin:    { BITCOIN: 'bitcoin', DOGECOIN: 'dogecoin', LITECOIN: 'litecoin' },
            Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' },
            XChainService: {
                XCHAIN_ENCODER:       'xchain-encoder',
                XCHAIN_DECODER:       'xchain-decoder',
                XCHAIN_UTXO_TRACKER:  'xchain-utxo-tracker',
                XCHAIN_REGTEST_MINER: 'xchain-regtest-miner',
                XCHAIN_INDEXER:       'xchain-indexer',
                XCHAIN_E2E_TEST:      'xchain-e2e-test'
            },
            cryptoNodesDir: '/crypto_nodes',
            dataDir:        '/data',
            path:           require('path')
        },
        './ConfigService': {
            getDockerContainerImageName: stubs.getDockerContainerImageName,
            getDockerNetwork:            stubs.getDockerNetwork,
            getDefaultConfig:            stubs.getDefaultConfig
        },
        './StatusService': {
            statusChanged: stubs.statusChanged
        },
        './VersionService': {
            checkRemoteNodeVersion:   stubs.checkRemoteNodeVersion,
            getLocalNodeVersion:      stubs.getLocalNodeVersion      || sinon.stub().resolves(null),
            getContainerNodeVersion:  stubs.getContainerNodeVersion  || sinon.stub().resolves('1.0.0'),
            getLocalModuleVersion:    stubs.getLocalModuleVersion    || sinon.stub().resolves('1.0.0'),
            getContainerModuleVersion: stubs.getContainerModuleVersion || sinon.stub().resolves('1.0.0')
        },
        // Lazy requires inside installNode
        './DockerService':   {
            createDockerNetwork: sinon.stub().resolves()
        },
        './DatabaseService': {
            buildDatabaseModule:   sinon.stub().resolves(),
            setDatabaseParameters: sinon.stub().resolves()
        },
        './ModuleService': {
            cloneGit:   sinon.stub().resolves(true),
            buildAndUp: sinon.stub().resolves('c'.repeat(64))
        },
        './BootstrapService': {
            utxoTrackerVolumeHasData:    sinon.stub().resolves(true),
            ensureBootstrapUtxoTracker:  sinon.stub().resolves()
        }
    })
}

// ---------------------------------------------------------------------------
// Helper: build a fake https.get that succeeds with pipe-able response
// ---------------------------------------------------------------------------
function makeFakeHttps(stubs, { decompressErr = null } = {}) {
    const writableEmitter = new EventEmitter()
    writableEmitter.close = sinon.stub()
    stubs.fs.createWriteStream.returns(writableEmitter)

    // On decompressTarGz resolution/rejection, control the finish event
    const httpsGetStub = sinon.stub().callsFake((url, cb) => {
        const responseEmitter = new EventEmitter()
        responseEmitter.pipe = sinon.stub()
        cb(responseEmitter)
        // Fire finish after the current tick so the pipe+handlers are set up
        setImmediate(() => {
            if (decompressErr) {
                stubs.decompressTarGz.rejects(decompressErr)
            }
            writableEmitter.emit('finish')
        })
        return { on: sinon.stub() }
    })
    return { get: httpsGetStub }
}

// ---------------------------------------------------------------------------
// getCryptoNode — bitcoin
// ---------------------------------------------------------------------------

describe('NodeService — getCryptoNode()', function () {

    it('downloads bitcoin node for x64 arch, decompresses and renames', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.https = makeFakeHttps(stubs)
        stubs.fs.existsSync.returns(false)   // no old bitcoin dir

        // Save original process.arch, then override via Object.defineProperty
        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const ns = loadNodeService(stubs)
        await ns.getCryptoNode('bitcoin', 'mainnet', 'v27.0')

        Object.defineProperty(process, 'arch', { value: origArch, configurable: true })

        expect(stubs.decompressTarGz.calledOnce).to.be.true
        expect(stubs.fs.renameSync.calledOnce).to.be.true
        expect(stubs.fs.writeFileSync.calledOnce).to.be.true
    })

    it('uses rmSync when node version >= 14.14.0 and old bitcoin dir exists', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.https = makeFakeHttps(stubs)
        stubs.fs.existsSync.returns(true)  // old dir exists

        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const ns = loadNodeService(stubs)
        await ns.getCryptoNode('bitcoin', 'mainnet', 'v27.0')

        Object.defineProperty(process, 'arch', { value: origArch, configurable: true })

        // node version >= 14.14 so rmSync must have been called
        expect(stubs.fs.rmSync.calledOnce).to.be.true
    })

    it('throws on unsupported architecture', async function () {
        const stubs = makeNodeServiceStubs()
        // No https needed — should throw before download

        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'mips', configurable: true })

        const ns = loadNodeService(stubs)
        try {
            await ns.getCryptoNode('bitcoin', 'mainnet', 'v27.0')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err.message).to.match(/Unsupported architecture/)
        } finally {
            Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
        }
    })

    it('rejects when decompressTarGz fails', async function () {
        const stubs = makeNodeServiceStubs()
        const decompressErr = new Error('decompress failed')
        stubs.https = makeFakeHttps(stubs, { decompressErr })

        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const ns = loadNodeService(stubs)
        try {
            await ns.getCryptoNode('bitcoin', 'mainnet', 'v27.0')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err.message).to.equal('decompress failed')
        } finally {
            Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
        }
    })

    it('downloads dogecoin node via gitHubDownloader', async function () {
        const stubs = makeNodeServiceStubs()
        const ns = loadNodeService(stubs)
        const result = await ns.getCryptoNode('dogecoin', 'mainnet', 'v1.14.7')
        expect(stubs.gitHubDownloader.downloadRepoVersion.calledOnce).to.be.true
        expect(result).to.be.true
    })

    it('downloads litecoin node via gitHubDownloader', async function () {
        const stubs = makeNodeServiceStubs()
        const ns = loadNodeService(stubs)
        const result = await ns.getCryptoNode('litecoin', 'mainnet', 'v0.21.3')
        expect(stubs.gitHubDownloader.downloadRepoVersion.calledOnce).to.be.true
        expect(result).to.be.true
    })

    it('throws for an unsupported coin', async function () {
        const stubs = makeNodeServiceStubs()
        const ns = loadNodeService(stubs)
        try {
            await ns.getCryptoNode('ethereum', 'mainnet', 'v1.0.0')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err.message).to.match(/no support for ethereum/)
        }
    })

    it('strips leading "v" from bitcoin version string', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.https = makeFakeHttps(stubs)
        stubs.fs.existsSync.returns(false)

        const origArch = process.arch
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const ns = loadNodeService(stubs)
        await ns.getCryptoNode('bitcoin', 'mainnet', 'v27.0')

        // The writeFileSync version arg should NOT have a "v" prefix
        const versionArg = stubs.fs.writeFileSync.firstCall.args[1]
        expect(versionArg).to.equal('27.0')

        Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
    })
})

// ---------------------------------------------------------------------------
// buildCryptoNode
// ---------------------------------------------------------------------------

describe('NodeService — buildCryptoNode()', function () {

    it('runs docker build with correct image name and cwd', async function () {
        const stubs = makeNodeServiceStubs()
        const containerId = 'a'.repeat(64)

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, containerId + '\n')
        })

        const ns = loadNodeService(stubs)
        const result = await ns.buildCryptoNode('bitcoin', 'mainnet')

        const buildCall = stubs.execFile.getCalls().find(c => c.args[1][0] === 'build')
        expect(buildCall).to.exist
        expect(buildCall.args[1]).to.include('-t')
        expect(buildCall.args[1]).to.include('xchain-node-bitcoin-mainnet-node')
        expect(result).to.equal(containerId)
    })

    it('stores container ID and fires statusChanged on success', async function () {
        const stubs = makeNodeServiceStubs()
        const containerId = 'b'.repeat(64)

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, containerId + '\n')
        })

        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode('bitcoin', 'mainnet')

        expect(stubs.db.insertModuleContainer.calledOnce).to.be.true
        const insertArgs = stubs.db.insertModuleContainer.firstCall.args
        expect(insertArgs[0]).to.equal('node')
        expect(insertArgs[1]).to.equal('bitcoin')
        expect(insertArgs[2]).to.equal('mainnet')
        expect(insertArgs[3]).to.equal(containerId)
        expect(stubs.statusChanged.calledOnce).to.be.true
    })

    it('includes port mapping when NODE_EXPOSED_PORT and NODE_PORT are configured', async function () {
        const stubs = makeNodeServiceStubs()
        const containerId = 'c'.repeat(64)
        let runArgs = null

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run') { runArgs = args; return cb(null, containerId + '\n') }
        })

        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode('bitcoin', 'mainnet')

        expect(runArgs).to.include('-p')
        expect(runArgs).to.include('8333:8332')
    })

    it('injects blocksDir volume when XCHAIN_NODE_BLOCKS_DIR is set', async function () {
        const stubs = makeNodeServiceStubs()
        const containerId = 'd'.repeat(64)
        let runArgs = null

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run') { runArgs = args; return cb(null, containerId + '\n') }
        })

        const oldBlocksDir = process.env.XCHAIN_NODE_BLOCKS_DIR
        process.env.XCHAIN_NODE_BLOCKS_DIR = '/blocks'
        try {
            const ns = loadNodeService(stubs)
            await ns.buildCryptoNode('bitcoin', 'mainnet')
            expect(runArgs.some(a => typeof a === 'string' && a.includes('/blocks'))).to.be.true
        } finally {
            if (oldBlocksDir === undefined) delete process.env.XCHAIN_NODE_BLOCKS_DIR
            else process.env.XCHAIN_NODE_BLOCKS_DIR = oldBlocksDir
        }
    })

    it('rejects when docker run fails', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(new Error('run failed'), '')
        })

        const ns = loadNodeService(stubs)
        try {
            await ns.buildCryptoNode('bitcoin', 'mainnet')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err).to.include('Error creating the container')
        }
    })

    it('rejects when db.insertModuleContainer returns false', async function () {
        const stubs = makeNodeServiceStubs()
        stubs.db.insertModuleContainer.resolves(false)
        const containerId = 'e'.repeat(64)

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, containerId + '\n')
        })

        const ns = loadNodeService(stubs)
        try {
            await ns.buildCryptoNode('bitcoin', 'mainnet')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err).to.include("problem trying to store")
        }
    })

    it('rejects (does not hang) when the docker build fails', async function () {
        // Regression: the build-error callback previously bare-returned without
        // rejecting, so the Promise never settled and buildCryptoNode hung forever.
        // A hang here would now blow the mocha timeout and fail this test.
        const stubs = makeNodeServiceStubs()
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(new Error('build blew up'))
            if (args[0] === 'run')   return cb(null, 'a'.repeat(64) + '\n')
        })

        const ns = loadNodeService(stubs)
        try {
            await ns.buildCryptoNode('bitcoin', 'mainnet')
            expect.fail('Should have rejected')
        } catch (err) {
            expect(String(err)).to.include('Error creating Docker image')
        }
        // run must never have been attempted after a build failure
        expect(stubs.execFile.getCalls().some(c => c.args[1][0] === 'run')).to.be.false
    })

    it('rejects (does not hang) when docker run output is not a container id', async function () {
        // Regression: when `docker run` exited 0 but stdout was not a 64-hex id,
        // there was no else branch — the Promise never settled and hung forever.
        const stubs = makeNodeServiceStubs()
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'WARNING: something\n') // not a container id
        })

        const ns = loadNodeService(stubs)
        try {
            await ns.buildCryptoNode('bitcoin', 'mainnet')
            expect.fail('Should have rejected')
        } catch (err) {
            expect(String(err)).to.include('no container id')
        }
        expect(stubs.db.insertModuleContainer.called).to.be.false
    })

    it('reads and rewrites conf file when it exists', async function () {
        const stubs = makeNodeServiceStubs()
        const containerId = 'f'.repeat(64)
        stubs.fs.existsSync.returns(true)  // conf file exists
        stubs.fs.readFileSync.returns('rpcuser=olduser\nrpcpassword=oldpass\n')

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, containerId + '\n')
        })

        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode('bitcoin', 'mainnet')

        expect(stubs.fs.readFileSync.calledOnce).to.be.true
        expect(stubs.fs.writeFileSync.calledOnce).to.be.true
        const writtenContent = stubs.fs.writeFileSync.firstCall.args[1]
        expect(writtenContent).to.include('rpcuser=testuser')
        expect(writtenContent).to.include('rpcpassword=testpass')
    })

    it('includes --ulimit nofile flag in docker run args', async function () {
        const stubs = makeNodeServiceStubs()
        // Must be valid hex [a-f0-9]{64} — buildCryptoNode checks the regex before resolving
        const containerId = 'deadbeef'.repeat(8)
        let runArgs = null

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run') { runArgs = args; return cb(null, containerId + '\n') }
        })

        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode('bitcoin', 'mainnet')

        expect(runArgs).to.include('--ulimit')
        expect(runArgs).to.include('nofile=2048:2048')
    })

    it('includes --restart unless-stopped in docker run args', async function () {
        const stubs = makeNodeServiceStubs()
        const containerId = 'cafebabe'.repeat(8)
        let runArgs = null

        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run') { runArgs = args; return cb(null, containerId + '\n') }
        })

        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode('bitcoin', 'mainnet')

        expect(runArgs).to.include('--restart')
        expect(runArgs).to.include('unless-stopped')
    })
})

// ---------------------------------------------------------------------------
// installNode — exercises the orchestration (lazy-require branches)
// ---------------------------------------------------------------------------

describe('NodeService — installNode()', function () {

    it('succeeds when local node version already installed (skips getCryptoNode)', async function () {
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves('27.0')
        })
        // Make execFile no-op (buildCryptoNode still calls it)
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'a'.repeat(64) + '\n')
        })

        const ns = loadNodeService(stubs)
        const result = await ns.installNode('bitcoin', 'mainnet')
        expect(result).to.be.true
        // gitHubDownloader should NOT have been called — version was local
        expect(stubs.gitHubDownloader.downloadRepoVersion.called).to.be.false
    })

    it('fetches remote version and calls getCryptoNode when not installed (dogecoin)', async function () {
        // Use dogecoin so getCryptoNode goes through gitHubDownloader (fully stubbed)
        // rather than https.get (bitcoin), which requires a live fake HTTP server
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves(null),
            getRemoteModuleVersions: () => ({
                'node-dogecoin': { tag_name: 'v1.14.7' }
            }),
            getDefaultConfig: sinon.stub().resolves({
                NODE_EXPOSED_PORT: 22556,
                NODE_PORT:         22555,
                NODE_USER:         'testuser',
                NODE_PASSWORD:     'testpass'
            }),
            getDockerContainerImageName: sinon.stub().returns('xchain-node-dogecoin-mainnet-node'),
            getDockerNetwork:            sinon.stub().returns('xchain-node-dogecoin-mainnet')
        })
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'b'.repeat(64) + '\n')
        })

        const ns = loadNodeService(stubs)
        const result = await ns.installNode('dogecoin', 'mainnet')
        expect(result).to.be.true
        // gitHubDownloader must have been called for the dogecoin binary
        expect(stubs.gitHubDownloader.downloadRepoVersion.calledOnce).to.be.true
    })

    it('throws when no valid remote version is available', async function () {
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves(null),
            getRemoteModuleVersions: () => ({
                'node-bitcoin': { tag_name: null }
            })
        })

        const ns = loadNodeService(stubs)
        try {
            await ns.installNode('bitcoin', 'mainnet')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err.message).to.match(/no valid version/)
        }
    })

    it('installs regtest miner when network is regtest', async function () {
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves('27.0')
        })
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'c'.repeat(64) + '\n')
        })

        // Capture what the ModuleService.cloneGit stub was called with
        const cloneGitStub = sinon.stub().resolves(true)
        const buildAndUpStub = sinon.stub().resolves('c'.repeat(64))
        const ns = proxyquire('../../src/services/NodeService', {
            'child_process': { execFile: stubs.execFile },
            'follow-redirects': { https: { get: sinon.stub() } },
            'fs': stubs.fs,
            'semver': require('semver'),
            '../state': {
                db:                     stubs.db,
                gitHubDownloader:       stubs.gitHubDownloader,
                getRemoteModuleVersions: () => ({})
            },
            '../utils/helpers': { decompressTarGz: stubs.decompressTarGz },
            '../config/constants': {
                NODE_MODULE_NAME:       'node',
                NODE_VERSION_FILE_NAME: '__VERSION__.txt',
                SEP:                    '-',
                Coin:    { BITCOIN: 'bitcoin', DOGECOIN: 'dogecoin', LITECOIN: 'litecoin' },
                Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' },
                XChainService: {
                    XCHAIN_ENCODER:       'xchain-encoder',
                    XCHAIN_DECODER:       'xchain-decoder',
                    XCHAIN_UTXO_TRACKER:  'xchain-utxo-tracker',
                    XCHAIN_REGTEST_MINER: 'xchain-regtest-miner',
                    XCHAIN_INDEXER:       'xchain-indexer',
                    XCHAIN_E2E_TEST:      'xchain-e2e-test'
                },
                cryptoNodesDir: '/crypto_nodes',
                dataDir:        '/data',
                path:           require('path')
            },
            './ConfigService': {
                getDockerContainerImageName: stubs.getDockerContainerImageName,
                getDockerNetwork:            stubs.getDockerNetwork,
                getDefaultConfig:            stubs.getDefaultConfig
            },
            './StatusService':  { statusChanged: stubs.statusChanged },
            './VersionService': {
                checkRemoteNodeVersion: stubs.checkRemoteNodeVersion,
                getLocalNodeVersion:    stubs.getLocalNodeVersion || sinon.stub().resolves('27.0'),
                getContainerNodeVersion: sinon.stub().resolves('27.0'),
                getLocalModuleVersion:   sinon.stub().resolves('1.0.0'),
                getContainerModuleVersion: sinon.stub().resolves('1.0.0')
            },
            './DockerService':   { createDockerNetwork: sinon.stub().resolves() },
            './DatabaseService': {
                buildDatabaseModule:   sinon.stub().resolves(),
                setDatabaseParameters: sinon.stub().resolves()
            },
            './ModuleService': {
                cloneGit:   cloneGitStub,
                buildAndUp: buildAndUpStub
            },
            './BootstrapService': {
                utxoTrackerVolumeHasData:   sinon.stub().resolves(true),
                ensureBootstrapUtxoTracker: sinon.stub().resolves()
            }
        })

        const result = await ns.installNode('bitcoin', 'regtest')
        expect(result).to.be.true
        const clonedModules = cloneGitStub.getCalls().map(c => c.args[0])
        expect(clonedModules).to.include('xchain-regtest-miner')
    })

    it('does NOT install regtest miner when network is mainnet', async function () {
        const cloneGitStub  = sinon.stub().resolves(true)
        const buildAndUpStub = sinon.stub().resolves('d'.repeat(64))
        const stubs = makeNodeServiceStubs({
            getLocalNodeVersion: sinon.stub().resolves('27.0')
        })
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'd'.repeat(64) + '\n')
        })

        const ns = proxyquire('../../src/services/NodeService', {
            'child_process': { execFile: stubs.execFile },
            'follow-redirects': { https: { get: sinon.stub() } },
            'fs': stubs.fs,
            'semver': require('semver'),
            '../state': { db: stubs.db, gitHubDownloader: stubs.gitHubDownloader, getRemoteModuleVersions: () => ({}) },
            '../utils/helpers': { decompressTarGz: stubs.decompressTarGz },
            '../config/constants': {
                NODE_MODULE_NAME: 'node', NODE_VERSION_FILE_NAME: '__VERSION__.txt', SEP: '-',
                Coin:    { BITCOIN: 'bitcoin', DOGECOIN: 'dogecoin', LITECOIN: 'litecoin' },
                Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' },
                XChainService: { XCHAIN_ENCODER: 'xchain-encoder', XCHAIN_DECODER: 'xchain-decoder', XCHAIN_UTXO_TRACKER: 'xchain-utxo-tracker', XCHAIN_REGTEST_MINER: 'xchain-regtest-miner', XCHAIN_INDEXER: 'xchain-indexer', XCHAIN_E2E_TEST: 'xchain-e2e-test' },
                cryptoNodesDir: '/crypto_nodes', dataDir: '/data', path: require('path')
            },
            './ConfigService':  { getDockerContainerImageName: stubs.getDockerContainerImageName, getDockerNetwork: stubs.getDockerNetwork, getDefaultConfig: stubs.getDefaultConfig },
            './StatusService':  { statusChanged: stubs.statusChanged },
            './VersionService': { checkRemoteNodeVersion: stubs.checkRemoteNodeVersion, getLocalNodeVersion: sinon.stub().resolves('27.0'), getContainerNodeVersion: sinon.stub().resolves('27.0'), getLocalModuleVersion: sinon.stub().resolves('1.0.0'), getContainerModuleVersion: sinon.stub().resolves('1.0.0') },
            './DockerService':   { createDockerNetwork: sinon.stub().resolves() },
            './DatabaseService': { buildDatabaseModule: sinon.stub().resolves(), setDatabaseParameters: sinon.stub().resolves() },
            './ModuleService': { cloneGit: cloneGitStub, buildAndUp: buildAndUpStub },
            './BootstrapService': { utxoTrackerVolumeHasData: sinon.stub().resolves(true), ensureBootstrapUtxoTracker: sinon.stub().resolves() }
        })

        const result = await ns.installNode('bitcoin', 'mainnet')
        expect(result).to.be.true
        const clonedModules = cloneGitStub.getCalls().map(c => c.args[0])
        expect(clonedModules).to.not.include('xchain-regtest-miner')
    })

    it('bootstraps utxo tracker when volume is fresh', async function () {
        const ensureBootstrap = sinon.stub().resolves()
        const stubs = makeNodeServiceStubs({ getLocalNodeVersion: sinon.stub().resolves('27.0') })
        stubs.execFile.callsFake((cmd, args, opts, cb) => {
            if (args[0] === 'build') return cb(null)
            if (args[0] === 'run')   return cb(null, 'e'.repeat(64) + '\n')
        })

        const ns = proxyquire('../../src/services/NodeService', {
            'child_process': { execFile: stubs.execFile },
            'follow-redirects': { https: { get: sinon.stub() } },
            'fs': stubs.fs,
            'semver': require('semver'),
            '../state': { db: stubs.db, gitHubDownloader: stubs.gitHubDownloader, getRemoteModuleVersions: () => ({}) },
            '../utils/helpers': { decompressTarGz: stubs.decompressTarGz },
            '../config/constants': {
                NODE_MODULE_NAME: 'node', NODE_VERSION_FILE_NAME: '__VERSION__.txt', SEP: '-',
                Coin:    { BITCOIN: 'bitcoin', DOGECOIN: 'dogecoin', LITECOIN: 'litecoin' },
                Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' },
                XChainService: { XCHAIN_ENCODER: 'xchain-encoder', XCHAIN_DECODER: 'xchain-decoder', XCHAIN_UTXO_TRACKER: 'xchain-utxo-tracker', XCHAIN_REGTEST_MINER: 'xchain-regtest-miner', XCHAIN_INDEXER: 'xchain-indexer', XCHAIN_E2E_TEST: 'xchain-e2e-test' },
                cryptoNodesDir: '/crypto_nodes', dataDir: '/data', path: require('path')
            },
            './ConfigService':  { getDockerContainerImageName: stubs.getDockerContainerImageName, getDockerNetwork: stubs.getDockerNetwork, getDefaultConfig: stubs.getDefaultConfig },
            './StatusService':  { statusChanged: stubs.statusChanged },
            './VersionService': { checkRemoteNodeVersion: stubs.checkRemoteNodeVersion, getLocalNodeVersion: sinon.stub().resolves('27.0'), getContainerNodeVersion: sinon.stub().resolves('27.0'), getLocalModuleVersion: sinon.stub().resolves('1.0.0'), getContainerModuleVersion: sinon.stub().resolves('1.0.0') },
            './DockerService':   { createDockerNetwork: sinon.stub().resolves() },
            './DatabaseService': { buildDatabaseModule: sinon.stub().resolves(), setDatabaseParameters: sinon.stub().resolves() },
            './ModuleService': { cloneGit: sinon.stub().resolves(true), buildAndUp: sinon.stub().resolves('e'.repeat(64)) },
            './BootstrapService': {
                utxoTrackerVolumeHasData:   sinon.stub().resolves(false), // fresh
                ensureBootstrapUtxoTracker: ensureBootstrap
            }
        })

        await ns.installNode('bitcoin', 'mainnet')
        expect(ensureBootstrap.calledOnce).to.be.true
    })
})
