'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    sinon,
    expect,
    PassThrough,
    XChainService,
    COIN,
    NETWORK,
    FAKE_CONTAINER_ID,
    makeSpawnProc,
    drainPassThrough,
    makeStubs,
    stubVerifiedInner,
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

    function captureReport(bs) {
        const lines = []
        const realLog = console.log
        console.log = (...args) => lines.push(args.join(' '))
        try { bs.reportBootstrapOutcomes() } finally { console.log = realLog }
        return lines.join('\n')
    }

// A restore that does not happen costs hours of rescanning from block 0, so
// the run must say so and must offer a way to take it again: a service that
// starts scratch-syncing reads as populated to every later run.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap restore is reported, not just logged', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
            delete process.env.XCHAIN_NODE_FORCE_BOOTSTRAP
        })
        it('says nothing at all when no bootstrap was attempted', function () {
            const bs = loadBootstrapService(makeStubs())
            bs.resetBootstrapOutcomes()
            expect(captureReport(bs)).to.equal('')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap restore is reported, not just logged', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
            delete process.env.XCHAIN_NODE_FORCE_BOOTSTRAP
        })
        it('names the service and the reason when a restore fails', async function () {
            const stubs = makeStubs()
            stubs.axios.rejects(new Error('EACCES: permission denied'))
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()

            await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            const report = captureReport(bs)

            expect(report).to.contain(XChainService.XCHAIN_UTXO_TRACKER)
            expect(report).to.contain('NOT restored')
            expect(report).to.contain('EACCES')
            // The operator has to be told the run is now a from-scratch sync and
            // how to take the restore again; that is the whole point of the summary.
            expect(report).to.contain('block 0')
            expect(report).to.contain('XCHAIN_NODE_FORCE_BOOTSTRAP')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap restore is reported, not just logged', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
            delete process.env.XCHAIN_NODE_FORCE_BOOTSTRAP
        })
        it('distinguishes "none published" from a failure', async function () {
            const stubs = makeStubs()
            stubs.axios.resolves({ status: 404, headers: {}, data: new PassThrough() })
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()

            await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            const report = captureReport(bs)

            expect(report).to.contain('none published')
            expect(report).to.not.contain('NOT restored')
            expect(report).to.not.contain('XCHAIN_NODE_FORCE_BOOTSTRAP')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap restore is reported, not just logged', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
            delete process.env.XCHAIN_NODE_FORCE_BOOTSTRAP
        })
        it('reports a disabled run as disabled rather than failed', async function () {
            process.env.XCHAIN_NODE_NO_BOOTSTRAP = '1'
            const bs = loadBootstrapService(makeStubs())
            bs.resetBootstrapOutcomes()

            await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            const report = captureReport(bs)

            expect(report).to.contain('disabled by XCHAIN_NODE_NO_BOOTSTRAP')
            expect(report).to.not.contain('NOT restored')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap restore is reported, not just logged', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
            delete process.env.XCHAIN_NODE_FORCE_BOOTSTRAP
        })
        it('reports each service separately when several fail in one run', async function () {
            const stubs = makeStubs()
            stubs.axios.rejects(new Error('EACCES: permission denied'))
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()

            await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            await bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            const report = captureReport(bs)

            expect(report).to.contain(XChainService.XCHAIN_UTXO_TRACKER)
            expect(report).to.contain(XChainService.XCHAIN_DECODER)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap restore is reported, not just logged', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
            delete process.env.XCHAIN_NODE_FORCE_BOOTSTRAP
        })
        it('starts a fresh report per run instead of replaying the last one', async function () {
            const stubs = makeStubs()
            stubs.axios.rejects(new Error('EACCES: permission denied'))
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()
            await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            expect(captureReport(bs)).to.contain('NOT restored')

            bs.resetBootstrapOutcomes()
            expect(captureReport(bs)).to.equal('')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('forceBootstrapRequested()', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_FORCE_BOOTSTRAP
        })
        it('is off when the variable is unset, so a healthy service is never wiped', function () {
            const bs = loadBootstrapService(makeStubs())
            expect(bs.forceBootstrapRequested()).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('forceBootstrapRequested()', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_FORCE_BOOTSTRAP
        })
        it('is off for an explicit 0 or empty value', function () {
            const bs = loadBootstrapService(makeStubs())
            for (const v of ['0', '']) {
                process.env.XCHAIN_NODE_FORCE_BOOTSTRAP = v
                expect(bs.forceBootstrapRequested(), `value ${JSON.stringify(v)}`).to.be.false
            }
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('forceBootstrapRequested()', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_FORCE_BOOTSTRAP
        })
        it('is on for a set value, which is what re-offers a spent restore', function () {
            const bs = loadBootstrapService(makeStubs())
            for (const v of ['1', 'true', 'yes']) {
                process.env.XCHAIN_NODE_FORCE_BOOTSTRAP = v
                expect(bs.forceBootstrapRequested(), `value ${v}`).to.be.true
            }
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
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
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('ensureBootstrapUtxoTracker()', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
        })
        it('returns false when no bootstrap is available (downloadBootstrap returns null)', async function () {
            const stubs = makeStubs()
            stubs.axios.resolves({ status: 404, headers: {}, data: new PassThrough() })
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            expect(result).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('ensureBootstrapUtxoTracker()', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
        })
        it('returns false (best-effort) when downloadBootstrap throws', async function () {
            const stubs = makeStubs()
            stubs.axios.rejects(new Error('network failure'))
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            expect(result).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('ensureBootstrapUtxoTracker()', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
        })
        it('returns false when getDefaultConfig throws', async function () {
            const stubs = makeStubs()
            stubs.configService.getDefaultConfig.rejects(new Error('config error'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            expect(result).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('ensureBootstrapUtxoTracker()', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
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
})
