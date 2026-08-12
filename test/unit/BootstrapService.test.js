'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const { PassThrough, EventEmitter } = require('stream')

// ---------------------------------------------------------------------------
// Constants (real, no I/O side-effects)
// ---------------------------------------------------------------------------
const { XChainService, SEP, BOOTSTRAP_BASE_URL } = require('../../src/config/constants')

const COIN    = 'bitcoin'
const NETWORK = 'mainnet'
const FAKE_CONTAINER_ID = 'a'.repeat(64)
const FAKE_DB_CONTAINER = 'b'.repeat(64)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Default stubs factory
// ---------------------------------------------------------------------------

function makeStubs(overrides = {}) {
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
        getDatabaseContainerId:   sinon.stub().resolves(FAKE_DB_CONTAINER),
        ensureDatabasePool:       sinon.stub().resolves(),
        askMariadbRootPassword:   sinon.stub().resolves('rootpass')
    }

    //  source health gate. These suites exercise create MECHANICS, so the
    // gate is stubbed open here; the gate's own policy (and the fact that
    // makeBootstrap consults it at all) is covered in BootstrapHealthGate.test.js.
    const healthGateStub = {
        assertBootstrapSourceHealthy: sinon.stub().resolves({ skipped: false, reasons: [] })
    }

    return {
        healthGate:     healthGateStub,
        fs:             fsStub,
        db:             dbStub,
        axios:          axiosStub,
        execFile:       execFileStub,
        zlib:           zlibStub,
        configService:  configServiceStub,
        dockerService:  dockerServiceStub,
        databaseService: databaseServiceStub,
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

// ---------------------------------------------------------------------------
// proxyquire loader
// ---------------------------------------------------------------------------

function loadBootstrapService(stubs) {
    // execFile promisify shim: the module does `promisify(execFile)` at load
    // time. We intercept 'child_process' and supply our own stub for execFile.
    // To make promisify work transparently we wrap the stub in a callback form.
    const execFileCb = function(cmd, args, ...rest) {
        const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null
        const promise = stubs.execFile(cmd, args)
        if (cb) {
            promise.then(r => cb(null, r || { stdout: '', stderr: '' })).catch(e => cb(e))
        }
        return promise
    }
    // sinon stubs are plain functions, promisify uses util.promisify which
    // checks for [util.promisify.custom] or assumes last arg is cb.
    // We provide the cb-style wrapper above instead.

    return proxyquire('../../src/services/BootstrapService', {
        'fs':             stubs.fs,
        'axios':          stubs.axios,
        'zlib':           stubs.zlib,
        'child_process':  {
            execFile: execFileCb,
            spawn:    stubs.spawn || sinon.stub()
        },
        '../state':               { db: stubs.db },
        '../config/constants': {
            XChainService,
            SEP,
            BOOTSTRAP_BASE_URL,
            tmpDir: '/tmp/xchain-test'
        },
        './ConfigService':   {
            getDefaultConfig:         stubs.configService.getDefaultConfig,
            getModuleDatabaseName:    stubs.configService.getModuleDatabaseName,
            getUtxoTrackerVolumeName: stubs.configService.getUtxoTrackerVolumeName
        },
        './DockerService':    {
            stopContainer:  stubs.dockerService.stopContainer,
            startContainer: stubs.dockerService.startContainer
        },
        './DatabaseService': {
            getDatabaseContainerId:  stubs.databaseService.getDatabaseContainerId,
            ensureDatabasePool:      stubs.databaseService.ensureDatabasePool,
            askMariadbRootPassword:  stubs.databaseService.askMariadbRootPassword
        },
        './BootstrapHealthGate': {
            assertBootstrapSourceHealthy: stubs.healthGate.assertBootstrapSourceHealthy
        }
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BootstrapService', function () {

    // Signature ENFORCEMENT is fail-closed by default (see BootstrapSigning.test.js
    // for that policy). The restore/ensure tests below exercise restore MECHANICS
    // with no pinned key/.sig in their stubbed fs, so they opt out of enforcement;
    // otherwise checkBootstrapSignature would (correctly) refuse and abort the restore.
    let _savedRequireSigned
    beforeEach(function () {
        _savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
        process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
    })
    afterEach(function () {
        if (_savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
        else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = _savedRequireSigned
    })

    // -----------------------------------------------------------------------
    // getBootstrapFilesList
    // -----------------------------------------------------------------------

    describe('getBootstrapFilesList()', function () {

        it('returns file list for XCHAIN_UTXO_TRACKER', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['boot1.tar.gz', 'boot2.tar.gz'])
            // : the list is NEWEST FIRST now, so give the stub real mtimes
            // rather than asserting whatever order readdir happened to return.
            stubs.fs.promises.stat
                .onFirstCall().resolves({ isFile: () => true, mtimeMs: 1000 })
                .onSecondCall().resolves({ isFile: () => true, mtimeMs: 2000 })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(list).to.deep.equal(['boot2.tar.gz', 'boot1.tar.gz'])
        })

        it('returns file list for XCHAIN_DECODER', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['dump.tar.gz'])
            stubs.fs.promises.stat.resolves({ isFile: () => true })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(list).to.deep.equal(['dump.tar.gz'])
        })

        it('returns file list for XCHAIN_INDEXER', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['indexer.tar.gz'])
            stubs.fs.promises.stat.resolves({ isFile: () => true })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_INDEXER)
            expect(list).to.deep.equal(['indexer.tar.gz'])
        })

        it('filters out non-file entries', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['file.tar.gz', 'subdir'])
            stubs.fs.promises.stat
                .onFirstCall().resolves({ isFile: () => true })
                .onSecondCall().resolves({ isFile: () => false })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(list).to.deep.equal(['file.tar.gz'])
        })

        it('throws for unsupported module', async function () {
            const stubs = makeStubs()
            const bs = loadBootstrapService(stubs)
            try {
                await bs.getBootstrapFilesList(COIN, NETWORK, 'xchain-unknown')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Unsupported module for bootstrap')
            }
        })

        it('propagates readdir error', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.rejects(new Error('ENOENT: no such file'))
            const bs = loadBootstrapService(stubs)
            try {
                await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('ENOENT')
            }
        })
    })

    // -----------------------------------------------------------------------
    // makeBootstrap: dispatch
    // -----------------------------------------------------------------------

    describe('makeBootstrap(): dispatch', function () {

        it('throws for unsupported module', async function () {
            const stubs = makeStubs()
            const bs = loadBootstrapService(stubs)
            try {
                await bs.makeBootstrap(COIN, NETWORK, 'xchain-unknown')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('Unsupported module for bootstrap create')
            }
        })
    })

    // -----------------------------------------------------------------------
    // restoreBootstrap: dispatch
    // -----------------------------------------------------------------------

    describe('restoreBootstrap(): dispatch', function () {

        it('throws for unsupported module', async function () {
            const stubs = makeStubs()
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, 'xchain-unknown', 'file.tgz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('Unsupported module for bootstrap restore')
            }
        })
    })

    // -----------------------------------------------------------------------
    // utxoTrackerVolumeHasData
    // -----------------------------------------------------------------------

    describe('utxoTrackerVolumeHasData()', function () {

        it('returns false when docker volume inspect fails (volume absent)', async function () {
            const stubs = makeStubs()
            stubs.execFile = sinon.stub().rejects(new Error('No such volume'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.utxoTrackerVolumeHasData(COIN, NETWORK)
            expect(result).to.be.false
        })

        it('returns true when volume ls shows a non-empty entry', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '' })       // inspect OK
                return Promise.resolve({ stdout: 'LOCK\n' })                       // ls shows data
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.utxoTrackerVolumeHasData(COIN, NETWORK)
            expect(result).to.be.true
        })

        it('returns false when volume ls output is empty', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '' })       // inspect OK
                return Promise.resolve({ stdout: '' })                             // empty volume
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.utxoTrackerVolumeHasData(COIN, NETWORK)
            expect(result).to.be.false
        })

        it('returns false when ls exec fails', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '' })       // inspect OK
                return Promise.reject(new Error('exec error'))                     // ls fails
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.utxoTrackerVolumeHasData(COIN, NETWORK)
            expect(result).to.be.false
        })
    })

    // -----------------------------------------------------------------------
    // downloadBootstrap
    // -----------------------------------------------------------------------

    describe('downloadBootstrap()', function () {

        it('returns null on 404', async function () {
            const stubs = makeStubs()
            stubs.axios.resolves({ status: 404, headers: {}, data: new PassThrough() })
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')
            expect(result).to.be.null
        })

        it('returns "latest.tgz" on success and writes to destPath', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(true)

            const dataStream  = new PassThrough()
            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            stubs.axios.resolves({
                status:  200,
                headers: { 'content-length': '100' },
                data:    dataStream
            })

            const bs = loadBootstrapService(stubs)
            const promise = bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')

            // Emit some data then end the source stream to trigger finish
            setImmediate(() => {
                dataStream.end()
                // Emit finish on writeStream
                writeStream.emit('finish')
            })

            const result = await promise
            expect(result).to.equal('latest.tgz')
        })

        // #2259: latest.tgz and its signature resolve independently to "the
        // newest" per request, so a publish landing mid-download can pair
        // archive A's bytes with archive B's signature (spurious fail-closed
        // refusal). The sig fetch must be pinned to the archive request's
        // final redirected URL, the concrete archive the bytes came from.
        it('pins the .sig fetch to the archive redirect target, not latest.tgz.sig', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(true)

            const dataStream  = new PassThrough()
            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const concreteUrl = 'https://sync.example/bootstraps/xchain-utxo-tracker/BTC/mainnet/mainnet-utxo-20260716_010203.tar.gz'
            stubs.axios.onFirstCall().resolves({
                status:  200,
                headers: { 'content-length': '100' },
                data:    dataStream,
                request: { res: { responseUrl: concreteUrl } },
            })
            stubs.axios.onSecondCall().resolves({ status: 200, data: 'sig-bytes' })

            const bs = loadBootstrapService(stubs)
            const promise = bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')
            setImmediate(() => { dataStream.end(); writeStream.emit('finish') })
            await promise

            expect(stubs.axios.secondCall.args[0].url).to.equal(concreteUrl + '.sig')
        })

        it('falls back to latest.tgz.sig when the archive response carries no redirect URL', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(true)

            const dataStream  = new PassThrough()
            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            stubs.axios.onFirstCall().resolves({
                status:  200,
                headers: {},
                data:    dataStream,
            })
            stubs.axios.onSecondCall().resolves({ status: 404 })

            const bs = loadBootstrapService(stubs)
            const promise = bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')
            setImmediate(() => { dataStream.end(); writeStream.emit('finish') })
            await promise

            expect(stubs.axios.secondCall.args[0].url).to.match(/\/latest\.tgz\.sig$/)
        })

        it('creates destDir when it does not exist', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)

            const dataStream  = new PassThrough()
            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            stubs.axios.resolves({
                status:  200,
                headers: {},
                data:    dataStream
            })

            const bs = loadBootstrapService(stubs)
            const promise = bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')

            setImmediate(() => {
                dataStream.end()
                writeStream.emit('finish')
            })

            await promise
            expect(stubs.fs.mkdirSync.calledWith('/tmp/dest', { recursive: true })).to.be.true
        })

        it('throws when axios rejects', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(true)
            stubs.axios.rejects(new Error('network error'))
            const bs = loadBootstrapService(stubs)
            try {
                await bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('network error')
            }
        })

        it('throws when writeStream emits error', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(true)

            const dataStream  = new PassThrough()
            const writeStream = new PassThrough()
            stubs.fs.createWriteStream.returns(writeStream)

            stubs.axios.resolves({
                status:  200,
                headers: {},
                data:    dataStream
            })

            const bs = loadBootstrapService(stubs)
            const promise = bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')

            setImmediate(() => {
                writeStream.emit('error', new Error('write error'))
            })

            try {
                await promise
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('write error')
            }
        })

        it('throws when data stream emits error', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(true)

            const dataStream  = new PassThrough()
            const writeStream = new PassThrough()
            stubs.fs.createWriteStream.returns(writeStream)

            stubs.axios.resolves({
                status:  200,
                headers: {},
                data:    dataStream
            })

            const bs = loadBootstrapService(stubs)
            const promise = bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')

            setImmediate(() => {
                dataStream.emit('error', new Error('stream broken'))
            })

            try {
                await promise
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('stream broken')
            }
        })

        it('uses the BOOTSTRAP_BASE_URL to build the request URL', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(true)
            let capturedUrl = null

            const dataStream  = new PassThrough()
            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            stubs.axios.callsFake(opts => {
                capturedUrl = opts.url
                return Promise.resolve({ status: 200, headers: {}, data: dataStream })
            })

            const bs = loadBootstrapService(stubs)
            const promise = bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')

            setImmediate(() => {
                dataStream.end()
                writeStream.emit('finish')
            })

            await promise
            expect(capturedUrl).to.include(XChainService.XCHAIN_UTXO_TRACKER)
            expect(capturedUrl).to.include(COIN)
            expect(capturedUrl).to.include(NETWORK)
            expect(capturedUrl).to.include('latest.tgz')
        })
    })

    // -----------------------------------------------------------------------
    // ensureBootstrapUtxoTracker
    // -----------------------------------------------------------------------

    describe('ensureBootstrapUtxoTracker()', function () {

        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
        })

        it('returns false when XCHAIN_NODE_NO_BOOTSTRAP is set', async function () {
            process.env.XCHAIN_NODE_NO_BOOTSTRAP = '1'
            const stubs = makeStubs()
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            expect(result).to.be.false
        })

        it('returns false when no bootstrap is available (downloadBootstrap returns null)', async function () {
            const stubs = makeStubs()
            stubs.axios.resolves({ status: 404, headers: {}, data: new PassThrough() })
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            expect(result).to.be.false
        })

        it('returns false (best-effort) when downloadBootstrap throws', async function () {
            const stubs = makeStubs()
            stubs.axios.rejects(new Error('network failure'))
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            expect(result).to.be.false
        })

        it('returns false when getDefaultConfig throws', async function () {
            const stubs = makeStubs()
            stubs.configService.getDefaultConfig.rejects(new Error('config error'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            expect(result).to.be.false
        })

        it('returns true when download succeeds and restoreBootstrap resolves (happy path via restoreBootstrap stub)', async function () {
            // Stub the entire restoreBootstrapUtxoTracker path by making
            // existsSync say the archive+work files exist with sentinel,
            // so restoreBootstrap completes in the resumable-already-verified path.
            // Signing pubkey (.pem) / signature (.sig) read as absent; a dev
            // checkout pins no key, so checkBootstrapSignature warns + proceeds.
            const stubs = makeStubs()
            stubs.fs.existsSync.callsFake(p => !/\.(pem|sig)$/.test(String(p)))
            // Inner archive is already present (reuse path); its bytes match the
            // checksum the verified outer archive declares, so restore proceeds.
            stubVerifiedInner(stubs, { innerName: 'data.tar.gz', checksumName: 'data.sha256', manageExistsSync: false })

            const dataStream  = new PassThrough()
            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            stubs.axios.resolves({ status: 200, headers: { 'content-length': '100' }, data: dataStream })

            // For restoreBootstrap(utxo-tracker, 'latest.tgz'):
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.fs.promises.stat.resolves({ size: 512 })

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                // Emit close asynchronously after spawn is called, giving time for
                // the pipe chain and event listeners to be set up.
                setImmediate(() => {
                    drainPassThrough(tarProc.stdin)
                    tarProc.emit('close', 0)
                })
                return tarProc
            })

            const bs = loadBootstrapService(stubs)

            // Download: emit finish after axios resolves
            const promise = bs.ensureBootstrapUtxoTracker(COIN, NETWORK)

            setImmediate(() => {
                dataStream.end()
                writeStream.emit('finish')
            })

            const result = await promise
            expect(result).to.be.true
        })
    })

    // -----------------------------------------------------------------------
    // ensureBootstrapMariaDb
    // -----------------------------------------------------------------------

    describe('ensureBootstrapMariaDb()', function () {

        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
        })

        it('returns false when XCHAIN_NODE_NO_BOOTSTRAP is set', async function () {
            process.env.XCHAIN_NODE_NO_BOOTSTRAP = '1'
            const stubs = makeStubs()
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.false
        })

        it('returns false when no bootstrap available for decoder', async function () {
            const stubs = makeStubs()
            stubs.axios.resolves({ status: 404, headers: {}, data: new PassThrough() })
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.false
        })

        it('returns false when no bootstrap available for indexer', async function () {
            const stubs = makeStubs()
            stubs.axios.resolves({ status: 404, headers: {}, data: new PassThrough() })
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_INDEXER)
            expect(result).to.be.false
        })

        it('returns false (best-effort) when download throws', async function () {
            const stubs = makeStubs()
            stubs.axios.rejects(new Error('timeout'))
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.false
        })

        it('returns true when download succeeds and restoreBootstrap resolves for decoder', async function () {
            const stubs = makeStubs()
            // archive + inner archive present (reuse path through restore);
            // signing pubkey/.sig absent → checkBootstrapSignature warns + proceeds
            stubs.fs.existsSync.callsFake(p => !/\.(pem|sig)$/.test(String(p)))
            stubVerifiedInner(stubs, { innerName: 'dump.sql.gz', checksumName: 'dump.sha256', manageExistsSync: false })

            const dataStream  = new PassThrough()
            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            stubs.axios.resolves({ status: 200, headers: {}, data: dataStream })

            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves('svc-cid')
            stubs.fs.promises.stat.resolves({ size: 512 })

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                // Emit close after spawn + listeners are established
                setImmediate(() => {
                    drainPassThrough(mysqlProc.stdin)
                    mysqlProc.emit('close', 0)
                })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            const promise = bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)

            setImmediate(() => {
                dataStream.end()
                writeStream.emit('finish')
            })

            const result = await promise
            expect(result).to.be.true
        })
    })

    // -----------------------------------------------------------------------
    // mariaDbModuleHasData
    // -----------------------------------------------------------------------

    describe('mariaDbModuleHasData()', function () {

        it('returns false when getDatabaseContainerId throws', async function () {
            const stubs = makeStubs()
            stubs.databaseService.getDatabaseContainerId.rejects(new Error('docker error'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleHasData(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.false
        })

        it('returns false when getDatabaseContainerId returns null', async function () {
            const stubs = makeStubs()
            stubs.databaseService.getDatabaseContainerId.resolves(null)
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleHasData(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.false
        })

        it('returns false when askMariadbRootPassword throws', async function () {
            const stubs = makeStubs()
            stubs.databaseService.askMariadbRootPassword.rejects(new Error('password error'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleHasData(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.false
        })

        it('returns false when blocks table does not exist (tblOut = 0)', async function () {
            const stubs = makeStubs()
            // First exec → table count = 0
            stubs.execFile = sinon.stub().resolves({ stdout: '0\n' })
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleHasData(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.false
        })

        it('returns false when blocks table exists but has 0 rows', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '1\n' })  // table exists
                return Promise.resolve({ stdout: '0\n' })                        // zero rows
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleHasData(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.false
        })

        it('returns true when blocks table has data', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '1\n' })   // table exists
                return Promise.resolve({ stdout: '1000\n' })                      // rows present
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleHasData(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.true
        })

        it('returns true for XCHAIN_INDEXER module', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '1\n' })
                return Promise.resolve({ stdout: '500\n' })
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleHasData(COIN, NETWORK, XChainService.XCHAIN_INDEXER)
            expect(result).to.be.true
        })

        it('returns false when exec throws on table check', async function () {
            const stubs = makeStubs()
            stubs.execFile = sinon.stub().rejects(new Error('mariadb exec error'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleHasData(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.false
        })
    })

    // -----------------------------------------------------------------------
    // restoreBootstrapUtxoTracker: archive not found
    // -----------------------------------------------------------------------

    describe('restoreBootstrapUtxoTracker(): file not found', function () {

        it('throws when archive file does not exist', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'missing.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('Bootstrap file not found')
            }
        })
    })

    // -----------------------------------------------------------------------
    // restoreBootstrapUtxoTracker: resumable extraction skip path
    // -----------------------------------------------------------------------

    describe('restoreBootstrapUtxoTracker(): resumable reuse (inner archive already matches verified checksum)', function () {

        it('reuses a work-dir inner archive whose bytes match the verified checksum (skips outer extract)', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'

            // Inner archive already on disk; its bytes hash to exactly the
            // checksum the signature-verified outer archive declares, so the
            // outer extract is skipped and the reused bytes are trusted.
            stubVerifiedInner(stubs, { archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256', initiallyPresent: true })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 0) })
                return tarProc
            })
            stubs.fs.promises.stat.resolves({ size: 1024, isFile: () => true })

            const bs = loadBootstrapService(stubs)
            const result = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
            expect(result).to.be.true
            expect(stubs.dockerService.startContainer.called).to.be.true
            // The big outer archive was NOT re-extracted (tar xzf never called).
            const xzfCall = stubs.execFile.getCalls().find(c => c.args[0] === 'tar' && c.args[1][0] === 'xzf')
            expect(xzfCall, 'outer extract should be skipped on a valid reuse').to.be.undefined
        })

        it('discards a pre-planted work-dir inner archive that does NOT match the verified checksum, and re-extracts', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'

            // Adversarial: a malicious inner archive is already on disk (e.g.
            // pre-planted in a shared XCHAIN_NODE_TMP_DIR), but the checksum the
            // signature-verified outer archive declares is for the legit bytes.
            // The reused bytes must be rejected and re-extracted from the archive.
            stubVerifiedInner(stubs, {
                archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256',
                initiallyPresent: true, innerHashOverride: 'b'.repeat(64),
            })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail('should not restore an inner archive that fails the verified checksum')
            } catch (err) {
                expect(err.message).to.include('checksum mismatch')
            }
            // It DID try to re-extract from the verified outer archive (not trust the plant).
            const xzfCall = stubs.execFile.getCalls().find(c => c.args[0] === 'tar' && c.args[1][0] === 'xzf')
            expect(xzfCall, 'a mismatched reuse must force a re-extract').to.not.be.undefined
            // And it never started restoring into the volume / touched the container.
            expect(stubs.dockerService.stopContainer.called).to.be.false
        })
    })

    // -----------------------------------------------------------------------
    // restoreBootstrapUtxoTracker: fresh extract path (no prior run)
    // -----------------------------------------------------------------------

    describe('restoreBootstrapUtxoTracker(): fresh extract', function () {

        it('extracts outer archive, verifies inner against the declared checksum, restores volume', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'

            // No prior extraction: inner archive absent until `tar xzf` runs, then
            // its bytes hash to the checksum the verified outer archive declares.
            stubVerifiedInner(stubs, { archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256', initiallyPresent: false })
            stubs.fs.promises.stat.resolves({ size: 2048, isFile: () => true })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 0) })
                return tarProc
            })

            const bs = loadBootstrapService(stubs)
            const result = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
            expect(result).to.be.true
            expect(stubs.dockerService.stopContainer.called).to.be.true
            expect(stubs.dockerService.startContainer.called).to.be.true
        })

        it('refuses an outer archive with an unsafe member path (never extracts)', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
            stubs.fs.existsSync.callsFake(p => p === archivePath)

            let extracted = false
            stubs.execFile = sinon.stub().callsFake((cmd, args) => {
                if (cmd === 'tar' && args[0] === 'tzf') {
                    return Promise.resolve({ stdout: 'data.tar.gz\n../escape\n' })
                }
                if (cmd === 'tar' && args[0] === 'xzf') extracted = true
                return Promise.resolve({ stdout: '' })
            })

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('unsafe member path')
            }
            expect(extracted).to.be.false
        })

        it('throws when the inner archive fails the declared checksum (before container stop, no finally restart)', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'

            // Freshly extracted inner archive whose bytes do NOT hash to the
            // checksum the verified outer archive declares (a tampered archive).
            stubVerifiedInner(stubs, {
                archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256',
                initiallyPresent: false, innerHashOverride: 'c'.repeat(64),
            })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('checksum mismatch')
            }
            // Verification fails before the container is stopped; no finally restart.
            expect(stubs.dockerService.stopContainer.called).to.be.false
            expect(stubs.dockerService.startContainer.called).to.be.false
        })

        it('throws when container ID is null (pool not ready)', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256', initiallyPresent: true })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)
            stubs.db.isReady.returns(false)

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('pool is not initialized')
            }
        })

        it('throws when container ID is null but DB pool is ready (no matching row)', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256', initiallyPresent: true })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)
            stubs.db.isReady.returns(true)

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('no matching row')
            }
        })

        it('throws when tar restore proc exits non-zero', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256', initiallyPresent: true })
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.fs.promises.stat.resolves({ size: 512 })

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 1) })
                return tarProc
            })

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('docker tar restore exited with code 1')
            }
            expect(stubs.dockerService.startContainer.called).to.be.true
        })

        it('throws when malformed archive (inner archive missing after extract)', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
            let execCalled = false

            stubs.fs.existsSync.callsFake(p => {
                if (p === archivePath) return true
                // Before exec: inner archive and checksum don't exist
                // After exec: still don't exist (malformed archive)
                if (p.includes('data.tar.gz') && p.includes('bootstrap-work')) return false
                if (p.includes('data.sha256')) return false
                if (p.includes('verify.ok')) return false
                return false
            })

            stubs.execFile = sinon.stub().callsFake(() => {
                execCalled = true
                return Promise.resolve({ stdout: '' })
            })

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('malformed')
            }
        })
    })

    // -----------------------------------------------------------------------
    // restoreBootstrapMariaDb: file not found
    // -----------------------------------------------------------------------

    describe('restoreBootstrapMariaDb(): file not found', function () {

        it('throws when archive file does not exist', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'missing.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('Bootstrap file not found')
            }
        })

        it('throws when archive file does not exist for indexer', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_INDEXER, 'missing.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('Bootstrap file not found')
            }
        })
    })

    // -----------------------------------------------------------------------
    // restoreBootstrapMariaDb: full happy path
    // -----------------------------------------------------------------------

    describe('restoreBootstrapMariaDb(): happy path', function () {

        it('drops/recreates DB, restores dump, restarts service container', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'

            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.askMariadbRootPassword.resolves('rootpass')
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves('svc-container-id')

            stubs.fs.promises.stat.resolves({ size: 2048 })

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 0) })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            const result = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
            expect(result).to.be.true
            expect(stubs.dockerService.stopContainer.calledWith('svc-container-id')).to.be.true
            expect(stubs.dockerService.startContainer.calledWith('svc-container-id')).to.be.true

            // The restore client must receive the root password via MYSQL_PWD env, never argv
            const [spawnCmd, spawnArgs, spawnOpts] = stubs.spawn.firstCall.args
            expect(spawnCmd).to.equal('docker')
            expect(spawnArgs).to.include('mariadb')
            expect(spawnArgs).to.include('MYSQL_PWD')
            expect(spawnArgs.some(a => String(a).includes('rootpass'))).to.be.false
            expect(spawnOpts.env.MYSQL_PWD).to.equal('rootpass')
        })

        it('works for XCHAIN_INDEXER (picks INDEXER_BOOTSTRAP_VOLUME)', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-indexer/bootstrap/dump.sql.gz'

            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)  // service not installed yet

            stubs.fs.promises.stat.resolves({ size: 1024 })

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 0) })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            const result = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_INDEXER, 'dump.sql.gz')
            expect(result).to.be.true
            // service container was null → stopContainer should NOT be called for it
            expect(stubs.dockerService.stopContainer.called).to.be.false
        })

        it('throws when mariadb restore proc exits non-zero', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves('svc-container-id')
            stubs.fs.promises.stat.resolves({ size: 512 })

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 2) })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('mariadb restore exited with code 2')
            }
            // service container should still be restarted
            expect(stubs.dockerService.startContainer.calledWith('svc-container-id')).to.be.true
        })

        it('throws when getDatabaseContainerId returns null', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.databaseService.getDatabaseContainerId.resolves(null)
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('MariaDB container not found')
            }
        })

        it('throws on malformed mariadb archive (missing dump files)', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
            stubs.fs.existsSync.callsFake(p => {
                if (p === archivePath) return true
                // inner archive + checksum never appear → malformed
                return false
            })
            stubs.execFile = sinon.stub().resolves({ stdout: '' })
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('malformed')
            }
        })

        it('extracts + verifies the mariadb dump against the declared checksum on a fresh run', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'

            // Fresh run: inner dump absent until `tar xzf`, then matches the checksum.
            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: false })
            stubs.fs.promises.stat.resolves({ size: 1024 })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 0) })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            const result = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
            expect(result).to.be.true
            // A fresh run really re-extracted from the verified outer archive.
            const xzfCall = stubs.execFile.getCalls().find(c => c.args[0] === 'tar' && c.args[1][0] === 'xzf')
            expect(xzfCall).to.not.be.undefined
        })

        it('throws when the mariadb dump fails the declared checksum', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'

            stubVerifiedInner(stubs, {
                archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256',
                initiallyPresent: false, innerHashOverride: 'd'.repeat(64),
            })

            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('checksum mismatch')
            }
        })
    })

    // -----------------------------------------------------------------------
    // : integrity refusals are classified, and land BEFORE the DROP.
    //
    // The destructive restore was first exercised end-to-end on test-host against
    // a throwaway MariaDB. Two properties matter and both were only implicit:
    //
    //   1. A refused archive must not have cost the operator their database.
    //      The refusal is raised before DROP DATABASE, so a tampered archive
    //      leaves the existing data intact and the operator can retry with a
    //      good one. Nothing pinned that ordering, so a future edit that moved
    //      the gate below the DROP would still pass every other test here.
    //   2. The refusal must be distinguishable from a crash. Uncaught, it
    //      printed a Node stack trace, which reads as "the tool broke, retry"
    //      when it means "this archive is not trustworthy". The named class is
    //      what lets cli.js/menu.js print the reason and exit 1 instead.
    // -----------------------------------------------------------------------

    describe('restoreBootstrapMariaDb(): integrity refusal is fail-closed and classified', function () {

        // Wire a decoder restore whose inner dump does not match the checksum
        // the (signature-verified) outer archive declares for it.
        function makeCorruptRestore() {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
            stubVerifiedInner(stubs, {
                archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256',
                initiallyPresent: false, innerHashOverride: 'd'.repeat(64),
            })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves('svc-container-id')
            stubs.spawn = sinon.stub()
            return stubs
        }

        it('never issues DROP DATABASE, and never starts the import, when the archive fails integrity', async function () {
            const stubs = makeCorruptRestore()
            const bs = loadBootstrapService(stubs)

            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                expect.fail('a corrupt archive must be refused')
            } catch (err) {
                expect(err.message).to.include('checksum mismatch')
            }

            // The DROP/CREATE goes out as `docker ... mariadb -e "DROP DATABASE ..."`
            // through execFile; the import is the spawn. Neither may have happened.
            const dropCall = stubs.execFile.getCalls().find(c =>
                JSON.stringify(c.args).includes('DROP DATABASE'))
            expect(dropCall, 'the database must survive a refused restore').to.be.undefined
            expect(stubs.spawn.called, 'no dump may be piped into mariadb').to.be.false
        })

        it('does not stop the running service for a restore it is going to refuse', async function () {
            const stubs = makeCorruptRestore()
            const bs = loadBootstrapService(stubs)

            await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz').catch(() => {})

            expect(stubs.dockerService.stopContainer.called,
                'a refused restore must not take the service down').to.be.false
        })

        it('raises BootstrapIntegrityError so the CLI can report it as a refusal, not a crash', async function () {
            const stubs = makeCorruptRestore()
            const bs = loadBootstrapService(stubs)

            const err = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                .then(() => null, e => e)
            expect(err).to.not.be.null
            expect(err.name).to.equal('BootstrapIntegrityError')
            expect(err).to.be.instanceOf(bs.BootstrapIntegrityError)
        })

        it('classifies a malformed archive (missing inner members) the same way', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
            stubs.fs.existsSync.callsFake(p => p === archivePath)
            stubs.execFile = sinon.stub().resolves({ stdout: '' })

            const bs = loadBootstrapService(stubs)
            const err = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                .then(() => null, e => e)
            expect(err).to.not.be.null
            expect(err.name).to.equal('BootstrapIntegrityError')
        })

        it('leaves an operational failure unclassified so it is not mistaken for tampering', async function () {
            // A non-zero mariadb exit is a real failure but NOT an integrity
            // refusal: it must keep the generic name, or the CLI would swallow
            // its stack and the operator would go hunting for a bad archive.
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)
            stubs.fs.promises.stat.resolves({ size: 512 })

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 2) })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            const err = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                .then(() => null, e => e)
            expect(err).to.not.be.null
            expect(err.name).to.not.equal('BootstrapIntegrityError')
        })
    })

    // -----------------------------------------------------------------------
    // ensureDirWritable: Docker fallback path (directory exists but not writable)
    // -----------------------------------------------------------------------

    describe('ensureDirWritable(): Docker fallback (dir exists, not writable)', function () {

        it('invokes docker mkdir/chown/chmod when outputDir exists but accessSync throws', async function () {
            const stubs = makeStubs()

            // existsSync: workDir=false (so ensureDir creates it); outputDir=true (exists)
            stubs.fs.existsSync.callsFake(p => {
                // workDir does not exist
                if (p.includes('bootstrap-work')) return false
                // outputDir (/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/) exists
                return true
            })

            // accessSync throws → fall through to Docker approach
            stubs.fs.accessSync.throws(new Error('EACCES: permission denied'))

            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            // All execFile calls succeed (du, docker mkdir, chown, chmod, tar czf)
            stubs.execFile = sinon.stub().resolves({ stdout: '0\n' })

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(tarProc)

            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
            stubs.fs.promises.writeFile.resolves()

            stubs.fs.createReadStream.callsFake(() => {
                const s = new PassThrough()
                setImmediate(() => { s.emit('data', Buffer.from('x')); s.emit('end') })
                return s
            })

            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)

            setImmediate(() => {
                tarProc.stdout.end()
                writeStream.emit('finish')
            })

            const result = await promise
            expect(result).to.be.true

            // Verify Docker fallback was invoked (chown + chmod calls)
            const execCalls = stubs.execFile.getCalls().map(c => c.args)
            const dockerCalls = execCalls.filter(([cmd, args]) => cmd === 'docker' && Array.isArray(args))
            const chownCall = dockerCalls.find(([, args]) => args.includes('chown'))
            const chmodCall = dockerCalls.find(([, args]) => args.includes('chmod'))
            expect(chownCall).to.exist
            expect(chmodCall).to.exist
        })
    })

    // -----------------------------------------------------------------------
    // makeBootstrap: XCHAIN_UTXO_TRACKER happy path
    // -----------------------------------------------------------------------

    describe('makeBootstrapUtxoTracker(): happy path', function () {

        it('creates a bootstrap for utxo-tracker: stops container, tars, checksums, wraps, restarts', async function () {
            const stubs = makeStubs()

            stubs.fs.existsSync.returns(false)  // workDir does not exist
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            // execFile: du → stdout, tar czf → ok
            let execCallIdx = 0
            stubs.execFile = sinon.stub().callsFake((cmd, args) => {
                execCallIdx++
                if (cmd === 'docker' && args.includes('du')) {
                    return Promise.resolve({ stdout: '104857600\t/data\n' })
                }
                return Promise.resolve({ stdout: '' })
            })

            // spawn for docker tar cf (step 3)
            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(tarProc)

            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
            stubs.fs.promises.writeFile.resolves()

            // createReadStream for computeSha256
            stubs.fs.createReadStream.callsFake(() => {
                const s = new PassThrough()
                setImmediate(() => {
                    s.emit('data', Buffer.from('archive content'))
                    s.emit('end')
                })
                return s
            })

            // createWriteStream for gzip output
            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)

            // tar proc: pipe resolves when writeStream finishes
            setImmediate(() => {
                tarProc.stdout.end()
                writeStream.emit('finish')
            })

            const result = await promise
            expect(result).to.be.true
            expect(stubs.dockerService.stopContainer.calledWith(FAKE_CONTAINER_ID)).to.be.true
            expect(stubs.dockerService.startContainer.calledWith(FAKE_CONTAINER_ID)).to.be.true
        })

        it('throws when container not found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            stubs.execFile = sinon.stub().resolves({ stdout: '1024\t/data\n' })
            const bs = loadBootstrapService(stubs)
            try {
                await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('utxo-tracker container not found')
            }
        })

        it('proceeds when du estimate fails (catch branch, progress shows ?%)', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            // First execFile call (docker du) throws → triggers catch at line 180
            let execCallCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                execCallCount++
                if (execCallCount === 1) return Promise.reject(new Error('docker du failed'))
                return Promise.resolve({ stdout: '' })
            })

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(tarProc)

            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
            stubs.fs.promises.writeFile.resolves()

            stubs.fs.createReadStream.callsFake(() => {
                const s = new PassThrough()
                setImmediate(() => { s.emit('data', Buffer.from('x')); s.emit('end') })
                return s
            })

            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)

            setImmediate(() => {
                tarProc.stdout.end()
                writeStream.emit('finish')
            })

            const result = await promise
            expect(result).to.be.true
        })

        it('restarts container even when tar spawn fails', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.execFile = sinon.stub().resolves({ stdout: '' })

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(tarProc)

            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)

            setImmediate(() => {
                tarProc.emit('error', new Error('spawn error'))
            })

            try {
                await promise
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('spawn error')
            }
            expect(stubs.dockerService.startContainer.called).to.be.true
        })

        it('restarts container when docker tar exits non-zero', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.execFile = sinon.stub().resolves({ stdout: '' })

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(tarProc)

            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)

            setImmediate(() => {
                tarProc.emit('close', 127)
            })

            try {
                await promise
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('docker tar exited with code 127')
            }
            expect(stubs.dockerService.startContainer.called).to.be.true
        })
    })

    // -----------------------------------------------------------------------
    // makeBootstrapMariaDb: dispatch
    // -----------------------------------------------------------------------

    describe('makeBootstrapMariaDb(): happy path', function () {

        it('dumps decoder DB: stops, streams dump, checksums, wraps, returns true', async function () {
            const stubs = makeStubs()

            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.askMariadbRootPassword.resolves('rootpass')

            // execFile: size estimate + tar czf
            stubs.execFile = sinon.stub().callsFake((cmd, args) => {
                return Promise.resolve({ stdout: '52428800\n' })
            })

            const dumpProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(dumpProc)

            stubs.fs.promises.stat.resolves({ size: 512 * 1024 })
            stubs.fs.promises.writeFile.resolves()

            stubs.fs.createReadStream.callsFake(() => {
                const s = new PassThrough()
                setImmediate(() => {
                    s.emit('data', Buffer.from('sql dump content'))
                    s.emit('end')
                })
                return s
            })

            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER)

            setImmediate(() => {
                dumpProc.stdout.end()
                writeStream.emit('finish')
            })

            const result = await promise
            expect(result).to.be.true

            // The dump must receive the root password via MYSQL_PWD env, never argv
            const [spawnCmd, spawnArgs, spawnOpts] = stubs.spawn.firstCall.args
            expect(spawnCmd).to.equal('docker')
            expect(spawnArgs).to.include('mariadb-dump')
            expect(spawnArgs).to.include('MYSQL_PWD')
            expect(spawnArgs.some(a => String(a).includes('rootpass'))).to.be.false
            expect(spawnOpts.env.MYSQL_PWD).to.equal('rootpass')
        })

        it('throws when getDatabaseContainerId returns null', async function () {
            const stubs = makeStubs()
            stubs.databaseService.getDatabaseContainerId.resolves(null)
            const bs = loadBootstrapService(stubs)
            try {
                await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER)
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('MariaDB container not found')
            }
        })

        it('proceeds when mariadb size estimate fails (catch branch, progress shows ?%)', async function () {
            const stubs = makeStubs()

            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.askMariadbRootPassword.resolves('rootpass')

            // First execFile (size estimate) fails → catch at line 271; others succeed
            let execCallCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                execCallCount++
                if (execCallCount === 1) return Promise.reject(new Error('size estimate failed'))
                return Promise.resolve({ stdout: '' })
            })

            const dumpProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(dumpProc)

            stubs.fs.promises.stat.resolves({ size: 512 * 1024 })
            stubs.fs.promises.writeFile.resolves()

            stubs.fs.createReadStream.callsFake(() => {
                const s = new PassThrough()
                setImmediate(() => { s.emit('data', Buffer.from('sql')); s.emit('end') })
                return s
            })

            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER)

            setImmediate(() => {
                dumpProc.stdout.end()
                writeStream.emit('finish')
            })

            const result = await promise
            expect(result).to.be.true
        })

        it('works for XCHAIN_INDEXER (picks INDEXER_BOOTSTRAP_VOLUME)', async function () {
            const stubs = makeStubs()

            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.askMariadbRootPassword.resolves('rootpass')
            stubs.execFile = sinon.stub().resolves({ stdout: '0\n' })

            const dumpProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(dumpProc)

            stubs.fs.promises.stat.resolves({ size: 256 * 1024 })
            stubs.fs.promises.writeFile.resolves()

            stubs.fs.createReadStream.callsFake(() => {
                const s = new PassThrough()
                setImmediate(() => {
                    s.emit('data', Buffer.from('indexer dump'))
                    s.emit('end')
                })
                return s
            })

            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_INDEXER)

            setImmediate(() => {
                dumpProc.stdout.end()
                writeStream.emit('finish')
            })

            const result = await promise
            expect(result).to.be.true
        })

        it('throws when mariadb-dump exits non-zero', async function () {
            const stubs = makeStubs()

            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.askMariadbRootPassword.resolves('rootpass')
            stubs.execFile = sinon.stub().resolves({ stdout: '0\n' })

            const dumpProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(dumpProc)

            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER)

            setImmediate(() => {
                dumpProc.emit('close', 1)
            })

            try {
                await promise
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('mariadb-dump exited with code 1')
            }
        })
    })

    // -----------------------------------------------------------------------
    // : the three defects that came out of the  rotation session
    // -----------------------------------------------------------------------

    describe('bootstrap listing and staging safety ', function () {

        it('lists archives NEWEST first, so "the latest" is the head of the list', async function () {
            // The list came back in raw readdir order, so a driver taking [0]
            // restored the OLDEST archive.
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['old.tar.gz', 'newest.tar.gz', 'middle.tar.gz'])
            stubs.fs.promises.stat
                .onCall(0).resolves({ isFile: () => true, mtimeMs: 100 })
                .onCall(1).resolves({ isFile: () => true, mtimeMs: 900 })
                .onCall(2).resolves({ isFile: () => true, mtimeMs: 500 })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(list).to.deep.equal(['newest.tar.gz', 'middle.tar.gz', 'old.tar.gz'])
        })

        it('orders deterministically when mtimes tie or are unavailable', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['a-2026-06-04.tar.gz', 'b-2026-07-24.tar.gz'])
            stubs.fs.promises.stat.resolves({ isFile: () => true })   // no mtimeMs at all
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(list).to.have.length(2)
            expect(list[0]).to.equal('b-2026-07-24.tar.gz')
        })

        it('excludes the .sig and .sha256 sidecars from the restorable list', async function () {
            // Otherwise the menu offers a signature file as something to restore.
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves([
                'boot.tar.gz', 'boot.tar.gz.sig', 'boot.sha256', 'notes.txt',
            ])
            stubs.fs.promises.stat.resolves({ isFile: () => true, mtimeMs: 1 })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(list).to.deep.equal(['boot.tar.gz'])
        })

        it('refuses to stage a bootstrap the work-dir filesystem cannot hold', async function () {
            // Staging 30G under <repo>/tmp filled node-host-b's root filesystem.
            const stubs = makeStubs()
            stubs.execFile.resolves({ stdout: '32212254720\t/data' })   // 30G volume
            stubs.fs.statfsSync = sinon.stub().returns({ bavail: 1000, bsize: 4096 })  // ~4MB free
            const bs = loadBootstrapService(stubs)

            let err = null
            try {
                await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            } catch (e) { err = e }

            expect(err, 'a full work-dir filesystem must be refused').to.not.equal(null)
            expect(err.message).to.match(/Not enough space/)
            expect(err.message).to.match(/XCHAIN_NODE_TMP_DIR/)
            expect(err.message).to.match(/staging/)
        })

        it('refuses BEFORE stopping the container, so a capacity failure costs no downtime', async function () {
            const stubs = makeStubs()
            stubs.execFile.resolves({ stdout: '32212254720\t/data' })
            stubs.fs.statfsSync = sinon.stub().returns({ bavail: 1000, bsize: 4096 })
            const bs = loadBootstrapService(stubs)

            try { await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER) } catch { /* expected */ }

            sinon.assert.notCalled(stubs.dockerService.stopContainer)
        })

        it('also refuses when only the OUTPUT filesystem is too small', async function () {
            // The finished archive lands in the bootstrap output dir, which on a
            // default install is <install>/data, i.e. root as well. Guarding only
            // the staging dir would have left the outage half-fixed.
            const stubs = makeStubs()
            stubs.execFile.resolves({ stdout: '32212254720\t/data' })
            stubs.fs.statfsSync = sinon.stub()
            stubs.fs.statfsSync.onFirstCall().returns({ bavail: 20 * 1024 * 1024, bsize: 4096 })  // staging: ~80G, fine
            stubs.fs.statfsSync.returns({ bavail: 1000, bsize: 4096 })                            // output: ~4MB
            const bs = loadBootstrapService(stubs)

            let err = null
            try { await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER) } catch (e) { err = e }

            expect(err, 'a full output filesystem must be refused too').to.not.equal(null)
            expect(err.message).to.match(/Not enough space/)
            expect(err.message).to.match(/published archives/)
            sinon.assert.notCalled(stubs.dockerService.stopContainer)
        })

        it('proceeds when the filesystem has room for the data plus the reserve', async function () {
            const stubs = makeStubs()
            stubs.execFile.resolves({ stdout: '1024\t/data' })         // tiny volume
            stubs.fs.statfsSync = sinon.stub().returns({ bavail: 10 * 1024 * 1024, bsize: 4096 })  // ~40G free
            const bs = loadBootstrapService(stubs)

            let err = null
            try { await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER) } catch (e) { err = e }

            // It may still fail further down the (heavily stubbed) pipeline, but
            // never on capacity, and the container stop must have been reached.
            if (err) expect(err.message).to.not.match(/Not enough space/)
            sinon.assert.called(stubs.dockerService.stopContainer)
        })
    })

    // -----------------------------------------------------------------------
    // listServedBootstrapCombos - the publisher's --all plan (uuid:d0cfcba9)
    // -----------------------------------------------------------------------
    describe('listServedBootstrapCombos()', function () {

        function loadWithRows(rows) {
            const stubs = makeStubs()
            stubs.db.getAllModuleContainers = sinon.stub().resolves(rows)
            return { stubs, bs: loadBootstrapService(stubs) }
        }

        // The whole point of reading the registry: a stopped combo keeps its row,
        // so it enters the plan and reaches the source-health gate instead of
        // being dropped by a `docker ps` that only sees running containers.
        it('lists a combo whose container is stopped', async function () {
            const { stubs, bs } = loadWithRows([
                { module: XChainService.XCHAIN_DECODER, coin: 'litecoin', network: 'mainnet', container_id: null },
                { module: XChainService.XCHAIN_INDEXER, coin: 'litecoin', network: 'mainnet', container_id: 'x' }
            ])
            const combos = await bs.listServedBootstrapCombos()
            expect(combos).to.deep.equal([
                'xchain-decoder:litecoin:mainnet',
                'xchain-indexer:litecoin:mainnet'
            ])
            sinon.assert.calledWith(stubs.db.getAllModuleContainers, null, null)
        })

        it('filters regtest and non-bootstrappable modules', async function () {
            const { bs } = loadWithRows([
                { module: XChainService.XCHAIN_DECODER, coin: 'bitcoin',  network: 'regtest', container_id: 'a' },
                { module: 'xchain-hub',                 coin: '',         network: '',        container_id: 'b' },
                { module: 'node',                       coin: 'bitcoin',  network: 'mainnet', container_id: 'c' },
                { module: XChainService.XCHAIN_UTXO_TRACKER, coin: 'bitcoin', network: 'mainnet', container_id: 'd' }
            ])
            expect(await bs.listServedBootstrapCombos())
                .to.deep.equal(['xchain-utxo-tracker:bitcoin:mainnet'])
        })

        it('de-duplicates and sorts', async function () {
            const { bs } = loadWithRows([
                { module: XChainService.XCHAIN_INDEXER, coin: 'litecoin', network: 'mainnet', container_id: 'a' },
                { module: XChainService.XCHAIN_DECODER, coin: 'bitcoin',  network: 'mainnet', container_id: 'b' },
                { module: XChainService.XCHAIN_INDEXER, coin: 'litecoin', network: 'mainnet', container_id: 'c' }
            ])
            expect(await bs.listServedBootstrapCombos()).to.deep.equal([
                'xchain-decoder:bitcoin:mainnet',
                'xchain-indexer:litecoin:mainnet'
            ])
        })

        it('returns nothing for an empty or unconfigured store', async function () {
            expect(await loadWithRows([]).bs.listServedBootstrapCombos()).to.deep.equal([])
        })
    })

})
