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
const { configStub } = require('../../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const { EventEmitter } = require('events')

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
        copyFileSync:      sinon.stub(),
        // ensureHostDir lstats before mkdir; default: path absent.
        lstatSync:         sinon.stub().throws(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    }
    // The per-coin Dockerfile and conf templates ship in git, so they are present
    // for every build. Model that: a default-false existsSync makes the build
    // scaffold look absent and every install path fail closed on a precondition
    // that never fails in a real checkout.
    fsStub.existsSync.withArgs(sinon.match(/crypto_nodes[\\/][a-z]+[\\/](Dockerfile|[a-z]+-[a-z]+\.conf)$/)).returns(true)
    const dbStub = {
        setModuleContainer: sinon.stub().resolves(true),
        isReady:               sinon.stub().returns(true)
    }
    const gitHubDownloaderStub = {
        downloadRepoVersion: sinon.stub().resolves(true),
        verifyFileHash:      sinon.stub().resolves()
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

function makeNodeConfig() {
    return configStub({
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
        configDir:      '/config',
        path:           require('path')
    })
}

function makeCoreDependencies(stubs) {
    return {
        'child_process': { execFile: stubs.execFile },
        'follow-redirects': { https: stubs.https || { get: sinon.stub() } },
        // Stubbed so no test resolves a real hostname: the mirror failover only
        // enumerates addresses after a transport failure, and a unit suite must
        // not depend on what DNS answers that day.
        'dns': stubs.dns || { promises: { lookup: async () => [] } },
        'fs': stubs.fs,
        'semver': require('semver'),
        '../state': {
            db:                     stubs.db,
            gitHubDownloader:       stubs.gitHubDownloader,
            getRemoteModuleVersions: stubs.getRemoteModuleVersions || (() => ({}))
        },
        '../utils/helpers': { decompressTarGz: stubs.decompressTarGz },
        '../config': makeNodeConfig(),
        './config_service': {
            getDockerContainerImageName: stubs.getDockerContainerImageName,
            getDockerNetwork:            stubs.getDockerNetwork,
            getDefaultConfig:            stubs.getDefaultConfig,
            validatePort:                () => true,
            // resolveBlocksDir sidecar persistence. Defaults: nothing
            // persisted, persistence is a no-op. Tests override to simulate a
            // config/node.local value.
            readSidecarValue:            stubs.readSidecarValue    || sinon.stub().resolves(undefined),
            upsertSidecarValues:         stubs.upsertSidecarValues || sinon.stub()
        },
        './status_service': { statusChanged: stubs.statusChanged },
        './version_service': {
            checkRemoteNodeVersion:    stubs.checkRemoteNodeVersion,
            getLocalNodeVersion:       stubs.getLocalNodeVersion       || sinon.stub().resolves(null),
            getContainerNodeVersion:   stubs.getContainerNodeVersion   || sinon.stub().resolves('1.0.0'),
            getLocalModuleVersion:     stubs.getLocalModuleVersion     || sinon.stub().resolves('1.0.0'),
            getContainerModuleVersion: stubs.getContainerModuleVersion || sinon.stub().resolves('1.0.0')
        }
    }
}

function makeLazyDependencies(stubs) {
    return {
        // Lazy requires inside installNode / buildCryptoNode
        './docker_service': {
            createDockerNetwork: sinon.stub().resolves(),
            forceRemoveContainerByName: stubs.forceRemoveContainerByName || sinon.stub().resolves(true),
            // Graceful stop of the previous daemon before the force-remove.
            stopContainerByName: stubs.stopContainerByName || sinon.stub().resolves({ stopped: true, seconds: 1, killed: false }),
            // Mount-drift guard. Default: no previous container.
            getContainerBindMounts: stubs.getContainerBindMounts || sinon.stub().resolves([])
        },
        './database_service': {
            buildDatabaseModule:   sinon.stub().resolves(),
            setDatabaseParameters: sinon.stub().resolves()
        },
        './module_service': {
            cloneGit:   stubs.cloneGit   || sinon.stub().resolves(true),
            buildAndUp: stubs.buildAndUp || sinon.stub().resolves('c'.repeat(64)),
            // buildCryptoNode lazy-requires this for the multi-stack host-port
            // pre-flight. Default: no conflict. A test overrides it to reject.
            assertNoHostPortConflicts: stubs.assertNoHostPortConflicts || sinon.stub().resolves()
        },
        './bootstrap_service': {
            utxoTrackerVolumeFreshness: stubs.utxoTrackerVolumeFreshness || sinon.stub().resolves('populated'),
            FRESHNESS_EMPTY:            'empty',
            ensureBootstrapUtxoTracker: stubs.ensureBootstrapUtxoTracker || sinon.stub().resolves(),
            forceBootstrapRequested:    stubs.forceBootstrapRequested || (() => false)
        }
    }
}

function loadNodeService(stubs) {
    return proxyquire('../../../../src/services/node_service', {
        ...makeCoreDependencies(stubs),
        ...makeLazyDependencies(stubs)
    })
}

function makeFakeHttps(stubs, { decompressErr = null, statusCode = 200 } = {}) {
    const writableEmitter = new EventEmitter()
    writableEmitter.close = sinon.stub()
    // A real fs WriteStream has destroy(); the download path calls it to release
    // the handle on a failed attempt before the partial file is removed.
    writableEmitter.destroy = sinon.stub()
    stubs.fs.createWriteStream.returns(writableEmitter)

    // On decompressTarGz resolution/rejection, control the finish event
    const httpsGetStub = sinon.stub().callsFake((url, cb) => {
        const responseEmitter = new EventEmitter()
        responseEmitter.pipe = sinon.stub()
        responseEmitter.resume = sinon.stub()
        responseEmitter.statusCode = statusCode
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

// Fails the unpinned attempt the way a bad TLS chain does, then serves
// 200 to any attempt pinned to a specific address.
function makeFailoverHttps(stubs, { failures = 1 } = {}) {
    const writableEmitter = new EventEmitter()
    writableEmitter.close = sinon.stub()
    writableEmitter.destroy = sinon.stub()
    stubs.fs.createWriteStream.returns(writableEmitter)

    let seen = 0
    const get = sinon.stub().callsFake((url, optionsOrCb, maybeCb) => {
        const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb
        const request = new EventEmitter()
        seen++
        if (seen <= failures) {
            setImmediate(() => request.emit('error', new Error('unable to verify the first certificate')))
            return request
        }
        const response = new EventEmitter()
        response.pipe = sinon.stub()
        response.resume = sinon.stub()
        response.statusCode = 200
        cb(response)
        setImmediate(() => writableEmitter.emit('finish'))
        return request
    })
    return { get }
}

function existingTarballFs(stubs) {
    // Only the tarball is present; the extracted directory is not, so
    // the post-verify rename path runs as it does after a download.
    stubs.fs.existsSync.callsFake(p => String(p).endsWith('.tar.gz'))
}

// Run buildCryptoNode with the env var set and return the `docker run` argv.
async function runArgsFor(coin, network, blocksDir = '/bigdisk') {
    const stubs = makeNodeServiceStubs()
    let runArgs = null
    stubs.execFile.callsFake((cmd, args, opts, cb) => {
        if (args[0] === 'build') return cb(null)
        if (args[0] === 'run') { runArgs = args; return cb(null, 'd'.repeat(64) + '\n') }
    })
    const old = process.env.XCHAIN_NODE_BLOCKS_DIR
    if (blocksDir === null) delete process.env.XCHAIN_NODE_BLOCKS_DIR
    else process.env.XCHAIN_NODE_BLOCKS_DIR = blocksDir
    try {
        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode(coin, network)
        return runArgs
    } finally {
        if (old === undefined) delete process.env.XCHAIN_NODE_BLOCKS_DIR
        else process.env.XCHAIN_NODE_BLOCKS_DIR = old
    }
}
// Collect the VALUE of every `-v VALUE` pair in the argv.
function mounts(runArgs) {
    const out = []
    for (let i = 0; i < runArgs.length - 1; i++) if (runArgs[i] === '-v') out.push(runArgs[i + 1])
    return out
}

// Run buildCryptoNode with the env var controlled and stubs injectable.
async function build(stubs, { envBlocksDir = null, coin = 'bitcoin', network = 'mainnet' } = {}) {
    let runArgs = null
    stubs.execFile.callsFake((cmd, args, opts, cb) => {
        if (args[0] === 'build') return setImmediate(() => cb(null))
        if (args[0] === 'run') { runArgs = args; return setImmediate(() => cb(null, 'd'.repeat(64) + '\n')) }
    })
    const old = process.env.XCHAIN_NODE_BLOCKS_DIR
    if (envBlocksDir === null) delete process.env.XCHAIN_NODE_BLOCKS_DIR
    else process.env.XCHAIN_NODE_BLOCKS_DIR = envBlocksDir
    try {
        const ns = loadNodeService(stubs)
        await ns.buildCryptoNode(coin, network)
        return runArgs
    } finally {
        if (old === undefined) delete process.env.XCHAIN_NODE_BLOCKS_DIR
        else process.env.XCHAIN_NODE_BLOCKS_DIR = old
    }
}
module.exports = {
    sinon,
    expect,
    makeNodeServiceStubs,
    loadNodeService,
    makeFakeHttps,
    makeFailoverHttps,
    existingTarballFs,
    runArgsFor,
    mounts,
    build
}
