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

function saveRequireSignedBootstrapSetting() {
    savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
}

function restoreRequireSignedBootstrapSetting() {
    if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
}

        const AUG_23 = Date.UTC(2026, 7, 23, 12, 0, 0)


    // A published archive is not simply a head start: the service walks
    // forward from the restored tip, so one that aged past the chain it
    // lands on can halt the tracker with the node parked behind it.

        // A weekly publisher puts a healthy archive at six days old
        // routinely, and a warning that fires on healthy state is one
        // nobody reads by the second month.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
        describe('the age of the archive an operator is about to take', function () {
            it('reads the publisher timestamp out of the archive name', function () {
                const bs = loadBootstrapService(makeStubs())
                const url = 'https://sync.example/b/testnet-xchain-utxo-tracker-20260801_082909.tar.gz'
                expect(bs.bootstrapArchiveAgeDays(url, AUG_23)).to.equal(22)
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
        describe('the age of the archive an operator is about to take', function () {
            it('reads a same-day archive as zero days old, not stale', function () {
                const bs = loadBootstrapService(makeStubs())
                const url = 'https://sync.example/b/testnet-xchain-utxo-tracker-20260823_042943.tar.gz'
                expect(bs.bootstrapArchiveAgeDays(url, AUG_23)).to.equal(0)
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
        describe('the age of the archive an operator is about to take', function () {
            it('says nothing about a hand-placed name that carries no timestamp', function () {
                const bs = loadBootstrapService(makeStubs())
                expect(bs.bootstrapArchiveAgeDays('https://sync.example/b/latest.tgz', AUG_23)).to.be.null
                expect(bs.bootstrapArchiveAgeDays('', AUG_23)).to.be.null
                expect(bs.bootstrapArchiveAgeDays(undefined, AUG_23)).to.be.null
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
        describe('the age of the archive an operator is about to take', function () {
            it('does not report a negative age for a clock-skewed future stamp', function () {
                const bs = loadBootstrapService(makeStubs())
                const url = 'https://sync.example/b/testnet-xchain-utxo-tracker-20260901_000000.tar.gz'
                expect(bs.bootstrapArchiveAgeDays(url, AUG_23)).to.be.null
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
        describe('the age of the archive an operator is about to take', function () {
            it('warns during the download when the resolved archive has aged out', async function () {
                const stubs = makeStubs()
                stubs.fs.existsSync.returns(true)

                const dataStream  = new PassThrough()
                const writeStream = new PassThrough()
                drainPassThrough(writeStream)
                stubs.fs.createWriteStream.returns(writeStream)

                const staleUrl = 'https://sync.example/b/testnet-xchain-utxo-tracker-20200101_000000.tar.gz'
                stubs.axios.onFirstCall().resolves({
                    status:  200,
                    headers: { 'content-length': '100' },
                    data:    dataStream,
                    request: { res: { responseUrl: staleUrl } },
                })
                stubs.axios.onSecondCall().resolves({ status: 200, data: 'sig-bytes' })

                const logged = []
                const origLog = console.log
                console.log = (...args) => logged.push(args.join(' '))
                try {
                    const bs = loadBootstrapService(stubs)
                    const promise = bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')
                    setImmediate(() => { dataStream.end(); writeStream.emit('finish') })
                    await promise
                } finally {
                    console.log = origLog
                }

                const warning = logged.find(l => l.includes('days old'))
                expect(warning, 'no staleness warning was printed').to.be.a('string')
                expect(warning).to.contain('testnet-xchain-utxo-tracker-20200101_000000.tar.gz')
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
        describe('the age of the archive an operator is about to take', function () {
            it('stays quiet through a normal weekly publish cadence', async function () {
                const bs = loadBootstrapService(makeStubs())
                const sixDays = Date.UTC(2026, 7, 7, 0, 0, 0)
                const url = 'https://sync.example/b/testnet-xchain-utxo-tracker-20260801_000000.tar.gz'
                expect(bs.bootstrapArchiveAgeDays(url, sixDays)).to.equal(6)
                expect(bs.BOOTSTRAP_STALE_AFTER_DAYS).to.be.above(7)
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
        describe('the age of the archive an operator is about to take', function () {
            it('names the halt for the tracker and only the slower resync for the rest', async function () {
                const staleUrl = mod => `https://sync.example/b/testnet-${mod}-20200101_000000.tar.gz`

                async function warningFor(module) {
                    const stubs = makeStubs()
                    stubs.fs.existsSync.returns(true)
                    const dataStream  = new PassThrough()
                    const writeStream = new PassThrough()
                    drainPassThrough(writeStream)
                    stubs.fs.createWriteStream.returns(writeStream)
                    stubs.axios.onFirstCall().resolves({
                        status: 200,
                        headers: { 'content-length': '100' },
                        data: dataStream,
                        request: { res: { responseUrl: staleUrl(module) } },
                    })
                    stubs.axios.onSecondCall().resolves({ status: 200, data: 'sig-bytes' })

                    const logged = []
                    const origLog = console.log
                    console.log = (...args) => logged.push(args.join(' '))
                    try {
                        const bs = loadBootstrapService(stubs)
                        const promise = bs.downloadBootstrap(COIN, NETWORK, module, '/tmp/dest')
                        setImmediate(() => { dataStream.end(); writeStream.emit('finish') })
                        await promise
                    } finally {
                        console.log = origLog
                    }
                    return logged.find(l => l.includes('days old')) || ''
                }

                expect(await warningFor(XChainService.XCHAIN_UTXO_TRACKER)).to.contain('halts it')
                const decoderWarning = await warningFor(XChainService.XCHAIN_DECODER)
                expect(decoderWarning).to.contain('resyncs forward')
                expect(decoderWarning).to.not.contain('halts it')
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('downloadBootstrap()', function () {
        describe('the age of the archive an operator is about to take', function () {
            it('stays quiet about an archive published today', async function () {
                const stubs = makeStubs()
                stubs.fs.existsSync.returns(true)

                const dataStream  = new PassThrough()
                const writeStream = new PassThrough()
                drainPassThrough(writeStream)
                stubs.fs.createWriteStream.returns(writeStream)

                const pad = n => String(n).padStart(2, '0')
                const now = new Date()
                const today = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_000000`
                stubs.axios.onFirstCall().resolves({
                    status:  200,
                    headers: { 'content-length': '100' },
                    data:    dataStream,
                    request: { res: { responseUrl: `https://sync.example/b/testnet-xchain-utxo-tracker-${today}.tar.gz` } },
                })
                stubs.axios.onSecondCall().resolves({ status: 200, data: 'sig-bytes' })

                const logged = []
                const origLog = console.log
                console.log = (...args) => logged.push(args.join(' '))
                try {
                    const bs = loadBootstrapService(stubs)
                    const promise = bs.downloadBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, '/tmp/dest')
                    setImmediate(() => { dataStream.end(); writeStream.emit('finish') })
                    await promise
                } finally {
                    console.log = origLog
                }

                expect(logged.find(l => l.includes('days old'))).to.be.undefined
            })
        })
    })
})
