'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon      = require('sinon')
const { configStub } = require('../../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const { PassThrough, EventEmitter } = require('stream')

const { XChainService, SEP, BOOTSTRAP_BASE_URL } = require('../../../../src/config')

const COIN    = 'bitcoin'
const NETWORK = 'mainnet'
const FAKE_CONTAINER_ID = 'a'.repeat(64)
const FAKE_DB_CONTAINER = 'b'.repeat(64)

/** Build a fake EventEmitter that looks like a child_process spawn() result */
function makeSpawnProc() {
    const proc    = new EventEmitter()
    proc.stdout   = new PassThrough()
    proc.stderr   = new PassThrough()
    proc.stdin    = new PassThrough()
    return proc
}

/** Drain a PassThrough immediately so it doesn't block the event loop */
function drainPassThrough(pt) {
    pt.resume()
}

/**
 * The utxo-tracker create path spawns twice (the docker `tar cf -` that feeds
 * the inner gzip, then the outer `tar cf -` that the store-only gzip wraps), so
 * a single shared fake proc deadlocks the second call. Hand each spawn its own
 * proc, drive it to a clean EOF + exit 0, and record what was spawned.
 *
 * createWriteStream is swapped for a real PassThrough per call so the pipe
 * chain ends it naturally and 'finish' fires the way it does in production.
 */
function makeAutoSpawn(stubs, { exitCodes = {} } = {}) {
    const calls = []
    stubs.spawn = sinon.stub().callsFake((cmd, args) => {
        const proc = makeSpawnProc()
        const idx  = calls.length
        calls.push({ cmd, args, proc })
        const code = Object.prototype.hasOwnProperty.call(exitCodes, idx) ? exitCodes[idx] : 0
        setImmediate(() => {
            proc.stdout.end(Buffer.from('tar-bytes'))
            setImmediate(() => proc.emit('close', code))
        })
        return proc
    })
    stubs.fs.createWriteStream.callsFake(() => {
        const ws = new PassThrough()
        drainPassThrough(ws)
        return ws
    })
    return calls
}

/** The argv of the docker `run` that snapshots the tracker volume, or undefined */
function findSnapshotCall(execFileStub) {
    return execFileStub.getCalls()
        .map(c => c.args)
        .find(([cmd, args]) => cmd === 'docker' && Array.isArray(args) &&
            args.includes('sh') && String(args[args.length - 1]).includes('cp -al'))
}

/** Make a fake axios streaming response */
function makeAxiosStreamResponse(statusCode = 200, contentLength = '1024') {
    const dataStream = new PassThrough()
    const response   = {
        status:  statusCode,
        headers: { 'content-length': contentLength },
        data:    dataStream
    }
    return { response, dataStream }
}

function makeFileSystemStubs() {
    const fakeWriteStream = new PassThrough()
    drainPassThrough(fakeWriteStream)

    const fakeReadStream = new PassThrough()
    drainPassThrough(fakeReadStream)

    // Default: createReadStream returns a stream that immediately ends
    const fsStub = {
        existsSync:         sinon.stub().returns(false),
        mkdirSync:          sinon.stub(),
        rmSync:             sinon.stub(),
        accessSync:         sinon.stub(),
        createWriteStream:  sinon.stub().returns(fakeWriteStream),
        createReadStream:   sinon.stub().returns(fakeReadStream),
        constants:          { W_OK: 2 },
        promises: {
            readdir:    sinon.stub().resolves(['file1.txt']),
            stat:       sinon.stub().resolves({ isFile: () => true, size: 1024 * 1024 }),
            writeFile:  sinon.stub().resolves(),
            readFile:   sinon.stub().resolves('abc123  data.tar.gz\n'),
        }
    }

    return { fsStub, fakeWriteStream, fakeReadStream }
}

function makeServiceStubs() {
    const dbStub = {
        getModuleContainer:  sinon.stub().resolves(FAKE_CONTAINER_ID),
        isReady:             sinon.stub().returns(true)
    }

    const axiosStub = sinon.stub()

    const execFileStub = sinon.stub()

    const zlibStub = {
        createGzip:   sinon.stub().callsFake(() => new PassThrough()),
        createGunzip: sinon.stub().callsFake(() => new PassThrough())
    }

    const configServiceStub = {
        getDefaultConfig: sinon.stub().resolves({
            UTXO_TRACKER_BOOTSTRAP_VOLUME: '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/',
            DECODER_BOOTSTRAP_VOLUME:      '/data/bitcoin/mainnet/xchain-decoder/bootstrap/',
            INDEXER_BOOTSTRAP_VOLUME:      '/data/bitcoin/mainnet/xchain-indexer/bootstrap/'
        }),
        getModuleDatabaseName: sinon.stub().returns('xchain_btc_mainnet_decoder'),
        // Mirrors ConfigService.getUtxoTrackerVolumeName's default-NODE_PREFIX
        // (unprefixed) shape; NODE_PREFIX-override behavior is covered in
        // ConfigService's own unit tests.
        getUtxoTrackerVolumeName: sinon.stub().callsFake((coin, net) => `xchain-utxo-tracker-${coin}-${net}-data`)
    }

    const dockerServiceStub = {
        stopContainer:  sinon.stub().resolves(),
        startContainer: sinon.stub().resolves()
    }

    const databaseServiceStub = {
        getDatabaseContainerId:       sinon.stub().resolves(FAKE_DB_CONTAINER),
        getDatabaseContainerPresence: sinon.stub().resolves('exists'),
        ensureDatabasePool:           sinon.stub().resolves(),
        askMariadbRootPassword:       sinon.stub().resolves('rootpass')
    }

    return {
        dbStub,
        axiosStub,
        execFileStub,
        zlibStub,
        configServiceStub,
        dockerServiceStub,
        databaseServiceStub
    }
}

function makeBootstrapPolicyStubs() {
    // The source health gate. These suites exercise create MECHANICS, so the
    // gate is stubbed open here; the gate's own policy (and the fact that
    // makeBootstrap consults it at all) is covered in BootstrapHealthGate.test.js.
    // The watermark is part of the gate's real return shape: the post-dump call needs
    // the pre-flight reading to bound the dump window, and the plumbing that carries
    // it between the two calls is BootstrapService's own.
    const healthGateStub = {
        assertBootstrapSourceHealthy: sinon.stub().resolves({
            skipped: false, reasons: [],
            watermark: { own: { events: 100, syncHalt: 50 }, upstream: null }
        })
    }

    // The reindex -> forced-republish ledger. Stubbed so a create in these
    // suites never touches the developer's real ~/.xchain-node; the ledger's own
    // rules live in BootstrapRepublishLedger.test.js.
    const republishLedgerStub = {
        recordBootstrapPublished: sinon.stub().returns(true)
    }

    // The encoder's scheduled-maintenance sentinel. Stubbed so a create in these
    // suites never shells out to `docker exec` against a real encoder; the
    // sentinel's own contents and failure handling live in
    // EncoderMaintenanceWindow.test.js.
    const encoderMaintenanceStub = {
        declareEncoderMaintenance: sinon.stub().resolves(true),
        clearEncoderMaintenance:   sinon.stub().resolves(true)
    }

    // The archive metadata member and the restore-time node tip guard. The
    // metadata writer is stubbed because these suites run on a fake fs; the
    // guard defaults to "unknown, do not refuse" so restore MECHANICS stay the
    // subject here. Both have their own suites (BootstrapArchiveMeta.test.js,
    // BootstrapNodeTipGuard.test.js).
    const archiveMetaStub = {
        buildBootstrapMeta: require('../../../../src/services/bootstrap_archive_meta').buildBootstrapMeta,
        writeBootstrapMeta: sinon.stub().resolves('bootstrap.json')
    }
    const nodeTipGuardStub = {
        assessNodeTipForRestore: sinon.stub().resolves({ verdict: 'unknown', refuse: false, detail: 'not compared in this test' })
    }

    return {
        healthGateStub,
        republishLedgerStub,
        encoderMaintenanceStub,
        archiveMetaStub,
        nodeTipGuardStub
    }
}

function makeStubs(overrides = {}) {
    const { fsStub, fakeWriteStream, fakeReadStream } = makeFileSystemStubs()
    const serviceStubs = makeServiceStubs()
    const policyStubs = makeBootstrapPolicyStubs()

    return {
        healthGate:      policyStubs.healthGateStub,
        republishLedger: policyStubs.republishLedgerStub,
        encoderMaintenance: policyStubs.encoderMaintenanceStub,
        archiveMeta:     policyStubs.archiveMetaStub,
        nodeTipGuard:    policyStubs.nodeTipGuardStub,
        fs:             fsStub,
        db:             serviceStubs.dbStub,
        axios:          serviceStubs.axiosStub,
        execFile:       serviceStubs.execFileStub,
        zlib:           serviceStubs.zlibStub,
        configService:  serviceStubs.configServiceStub,
        dockerService:  serviceStubs.dockerServiceStub,
        databaseService: serviceStubs.databaseServiceStub,
        fakeWriteStream,
        fakeReadStream,
        ...overrides
    }
}

// Configure fs + execFile so ensureVerifiedInnerArchive sees a well-formed,
// signature-verified outer archive: `tar tzf` lists the two members,
// `tar xzOf <checksum>` returns the checksum the archive declares for the inner
// member, `tar xzf` performs the fresh extract, and createReadStream feeds the
// inner bytes to computeSha256. Set innerHashOverride to a different valid hash
// to model an archive whose declared checksum does not match its inner bytes.
function stubVerifiedInner(stubs, {
    archivePath,
    innerName = 'data.tar.gz',
    checksumName = 'data.sha256',
    innerBytes = Buffer.from('verified-archive-bytes'),
    initiallyPresent = false,
    innerHashOverride = null,
    manageExistsSync = true,
} = {}) {
    const crypto = require('crypto')
    const expectedHash = crypto.createHash('sha256').update(innerBytes).digest('hex')
    const declaredHash = innerHashOverride || expectedHash
    let extracted = initiallyPresent
    if (manageExistsSync) {
        stubs.fs.existsSync.callsFake(p => {
            p = String(p)
            if (/\.(pem|sig)$/.test(p)) return false
            if (archivePath && p === archivePath) return true
            if (p.includes('bootstrap-work')) return extracted
            return false
        })
    }
    stubs.fs.createReadStream.callsFake(() => {
        const s = new PassThrough()
        setImmediate(() => { s.emit('data', innerBytes); s.emit('end') })
        return s
    })
    stubs.execFile.callsFake((cmd, args) => {
        if (cmd === 'tar' && args[0] === 'tzf')  return Promise.resolve({ stdout: `${innerName}\n${checksumName}\n` })
        if (cmd === 'tar' && args[0] === 'xzOf') return Promise.resolve({ stdout: `${declaredHash}  ${innerName}\n` })
        if (cmd === 'tar' && args[0] === 'xzf')  { extracted = true; return Promise.resolve({ stdout: '' }) }
        return Promise.resolve({ stdout: '' })
    })
    return { expectedHash, declaredHash }
}

function makeExecFileCallback(stubs) {
    // execFile promisify shim: the module does `promisify(execFile)` at load
    // time. We intercept 'child_process' and supply our own stub for execFile.
    // To make promisify work transparently we wrap the stub in a callback form.
    return function(cmd, args, ...rest) {
        const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null
        const promise = stubs.execFile(cmd, args)
        if (cb) {
            promise.then(r => cb(null, r || { stdout: '', stderr: '' })).catch(e => cb(e))
        }
        return promise
    }
}

function makeBootstrapOverrides(stubs, execFileCb) {
    // sinon stubs are plain functions, promisify uses util.promisify which
    // checks for [util.promisify.custom] or assumes last arg is cb.
    // We provide the cb-style wrapper above instead.
    return {
        'fs':             stubs.fs,
        'axios':          stubs.axios,
        'zlib':           stubs.zlib,
        'child_process':  {
            execFile: execFileCb,
            spawn:    stubs.spawn || sinon.stub()
        },
        '../state':               { db: stubs.db },
        '../config': configStub({
            XChainService,
            SEP,
            BOOTSTRAP_BASE_URL,
            tmpDir: '/tmp/xchain-test'
        }),
        './config_service':   {
            getDefaultConfig:         stubs.configService.getDefaultConfig,
            getModuleDatabaseName:    stubs.configService.getModuleDatabaseName,
            getUtxoTrackerVolumeName: stubs.configService.getUtxoTrackerVolumeName
        },
        './docker_service':    {
            stopContainer:  stubs.dockerService.stopContainer,
            startContainer: stubs.dockerService.startContainer
        },
        './database_service': {
            getDatabaseContainerId:       stubs.databaseService.getDatabaseContainerId,
            getDatabaseContainerPresence: stubs.databaseService.getDatabaseContainerPresence,
            ensureDatabasePool:           stubs.databaseService.ensureDatabasePool,
            askMariadbRootPassword:       stubs.databaseService.askMariadbRootPassword
        },
        './bootstrap_health_gate': {
            assertBootstrapSourceHealthy: stubs.healthGate.assertBootstrapSourceHealthy
        },
        './bootstrap_republish_ledger': {
            recordBootstrapPublished: stubs.republishLedger.recordBootstrapPublished
        },
        './encoder_maintenance_window': {
            declareEncoderMaintenance: stubs.encoderMaintenance.declareEncoderMaintenance,
            clearEncoderMaintenance:   stubs.encoderMaintenance.clearEncoderMaintenance
        },
        './bootstrap_archive_meta': {
            buildBootstrapMeta: stubs.archiveMeta.buildBootstrapMeta,
            writeBootstrapMeta: stubs.archiveMeta.writeBootstrapMeta
        },
        './bootstrap_node_tip_guard': {
            assessNodeTipForRestore: stubs.nodeTipGuard.assessNodeTipForRestore
        }
    }
}

function loadBootstrapService(stubs) {
    const execFileCb = makeExecFileCallback(stubs)
    return proxyquire('../../../../src/services/bootstrap_service', makeBootstrapOverrides(stubs, execFileCb))
}


module.exports = {
    sinon,
    expect,
    PassThrough,
    XChainService,
    COIN,
    NETWORK,
    FAKE_CONTAINER_ID,
    FAKE_DB_CONTAINER,
    makeSpawnProc,
    drainPassThrough,
    makeAutoSpawn,
    findSnapshotCall,
    makeAxiosStreamResponse,
    makeStubs,
    stubVerifiedInner,
    loadBootstrapService
}
