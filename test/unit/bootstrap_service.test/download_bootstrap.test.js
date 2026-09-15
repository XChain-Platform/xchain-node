'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    expect,
    PassThrough,
    XChainService,
    COIN,
    NETWORK,
    drainPassThrough,
    makeStubs,
    loadBootstrapService
} = require('./support')

let savedRequireSigned

function saveRequireSignedBootstrapSetting() {
    savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
}

function restoreRequireSignedBootstrapSetting() {
    if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
}

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
        it('returns null on 404', async function () {
            const stubs = makeStubs()
            stubs.axios.resolves({ status: 404, headers: {}, data: new PassThrough() })
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')
            expect(result).to.be.null
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
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
    })
})


    // #2259: latest.tgz and its signature resolve independently to "the
    // newest" per request, so a publish landing mid-download can pair
    // archive A's bytes with archive B's signature (spurious fail-closed
    // refusal). The sig fetch must be pinned to the archive request's
    // final redirected URL, the concrete archive the bytes came from.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
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
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
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
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
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
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
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
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
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
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
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
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
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
})
