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
} = require('./helpers/support')

let savedRequireSigned

// Runs one stubbed download whose redirect lands on resolvedUrl; returns the
// console lines printed and the URL requested for the signature.
async function runDownload(resolvedUrl) {
    const stubs = makeStubs()
    stubs.fs.existsSync.returns(true)
    const dataStream  = new PassThrough()
    const writeStream = new PassThrough()
    drainPassThrough(writeStream)
    stubs.fs.createWriteStream.returns(writeStream)
    stubs.axios.onFirstCall().resolves({
        status:  200,
        headers: { 'content-length': '100' },
        data:    dataStream,
        request: { res: { responseUrl: resolvedUrl } },
    })
    stubs.axios.onSecondCall().resolves({ status: 200, data: 'sig-bytes' })

    const logged = []
    const origLog = console.log
    console.log = (...args) => logged.push(args.join(' '))
    try {
        const bs = loadBootstrapService(stubs)
        const promise = bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, '/tmp/dest')
        setImmediate(() => { dataStream.end(); writeStream.emit('finish') })
        await promise
    } finally {
        console.log = origLog
    }
    const sigCall = stubs.axios.getCall(1)
    return { logged, sigUrl: sigCall.args[0].url }
}

describe('BootstrapService', function () {
    beforeEach(function () {
        savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
        process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
    })
    afterEach(function () {
        if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
        else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
    })

    describe('downloadBootstrap() when the redirect target carries a query string', function () {
        it('fetches the signature at <archive path>.sig with no query', async function () {
            const { sigUrl } = await runDownload(
                'https://sync.example/a/regtest-xchain-decoder-20250101_000000.tgz?v=1')
            expect(sigUrl).to.equal('https://sync.example/a/regtest-xchain-decoder-20250101_000000.tgz.sig')
        })

        it('drops a fragment from the signature URL too', async function () {
            const { sigUrl } = await runDownload('https://sync.example/a/regtest-xchain-decoder.tgz?v=1#x')
            expect(sigUrl).to.equal('https://sync.example/a/regtest-xchain-decoder.tgz.sig')
        })

        it('draws no age warning from a stamp that lives only in the query', async function () {
            const { logged, sigUrl } = await runDownload(
                'https://sync.example/a/regtest-xchain-decoder.tgz?v=20250101_000000')
            expect(logged.find(l => l.includes('days old'))).to.be.undefined
            expect(logged.find(l => l.includes('WARNING: the published'))).to.be.undefined
            expect(sigUrl).to.equal('https://sync.example/a/regtest-xchain-decoder.tgz.sig')
        })

        it('still reads the age from the archive name when a query follows it', async function () {
            const { logged } = await runDownload(
                'https://sync.example/a/regtest-xchain-decoder-20250101_000000.tgz?v=1')
            const warning = logged.find(l => l.includes('days old'))
            expect(warning).to.be.a('string')
            expect(warning).to.contain('(regtest-xchain-decoder-20250101_000000.tgz)')
        })

        it('reads a query-only stamp as no age', function () {
            const bs = loadBootstrapService(makeStubs())
            expect(bs.bootstrapArchiveAgeDays('https://sync.example/a/x.tgz?v=20250101_000000')).to.be.null
            expect(bs.bootstrapArchiveAgeDays('https://sync.example/a/x.tgz#20250101_000000')).to.be.null
        })
    })

    describe('downloadBootstrap() when the redirect target has no query', function () {
        it('keeps fetching <archive>.sig as before', async function () {
            const { sigUrl } = await runDownload(
                'https://sync.example/a/regtest-xchain-decoder-20250101_000000.tgz')
            expect(sigUrl).to.equal('https://sync.example/a/regtest-xchain-decoder-20250101_000000.tgz.sig')
        })
    })
})
