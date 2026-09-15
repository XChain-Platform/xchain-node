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
    FAKE_DB_CONTAINER,
    makeSpawnProc,
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

async function createMariaDbBootstrap() {
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
    return { stubs, result }
}

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapMariaDb(): happy path', function () {
        it('dumps decoder DB: stops, streams dump, checksums, wraps, returns true', async function () {
            const { stubs, result } = await createMariaDbBootstrap()
            expect(result).to.be.true

            // The dump must receive the root password via MYSQL_PWD env, never argv
            const [spawnCmd, spawnArgs, spawnOpts] = stubs.spawn.firstCall.args
            expect(spawnCmd).to.equal('docker')
            expect(spawnArgs).to.include('mariadb-dump')
            expect(spawnArgs).to.include('MYSQL_PWD')
            expect(spawnArgs.some(a => String(a).includes('rootpass'))).to.be.false
            expect(spawnOpts.env.MYSQL_PWD).to.equal('rootpass')

            // The gate is consulted TWICE: once before the dump, and once after it
            // finishes but before anything is checksummed, wrapped or signed. The
            // producers stay live for the whole dump, so one reading before it
            // cannot speak for the bytes that ship.
            expect(stubs.healthGate.assertBootstrapSourceHealthy.callCount).to.equal(2)

            // And the second reading is BOUNDED by the first: without the pre-flight
            // watermark the post-dump call only sees live rows, so a halt raised after
            // the --single-transaction snapshot point and cleared before the dump
            // finished is captured in the archive while both readings look clean.
            const preflightCall = stubs.healthGate.assertBootstrapSourceHealthy.firstCall
            const postDumpCall  = stubs.healthGate.assertBootstrapSourceHealthy.secondCall
            expect((preflightCall.args[3] || {}).since, 'the first reading defines the window').to.be.undefined
            expect(postDumpCall.args[3].since, 'the post-dump reading must carry the pre-flight watermark')
                .to.deep.equal((await preflightCall.returnValue).watermark)

            // The archive carries its end height (MAX(block_index) of the
            // dumped blocks table, here whatever the execFile stub answers) as a
            // bootstrap.json member that LEADS the wrapper, so a restore can read
            // it without a pass over the archive.
            const heightQuery = stubs.execFile.getCalls().map(c => c.args)
                .find(([cmd, args]) => cmd === 'docker' && Array.isArray(args) && args.some(a => /MAX\(block_index\)/.test(String(a))))
            expect(heightQuery, 'the tip height is read from the dumped database').to.exist
            expect(stubs.archiveMeta.writeBootstrapMeta.calledOnce).to.equal(true)
            const [, metaBody] = stubs.archiveMeta.writeBootstrapMeta.firstCall.args
            expect(metaBody).to.include({ format: 1, module: XChainService.XCHAIN_DECODER, coin: COIN, network: NETWORK, height: 52428800 })
            const czf = stubs.execFile.getCalls().map(c => c.args)
                .find(([cmd, args]) => cmd === 'tar' && Array.isArray(args) && args[0] === 'czf')
            expect(czf[1].slice(-3)).to.deep.equal(['bootstrap.json', 'dump.sql.gz', 'dump.sha256'])
        })
    })
})


    // A halt marker can be written while mariadb-dump is still streaming, and
    // such an archive must not ship: signed, it becomes the newest (default)
    // recovery source.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapMariaDb(): happy path', function () {
        it('discards a finished dump when the source stops being healthy during it', async function () {
            const stubs = makeStubs()

            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.askMariadbRootPassword.resolves('rootpass')

            const refusal = new Error("Refusing to create a bootstrap from btc/mainnet xchain-decoder: "
                + "the database carries a durable REORG_HALT marker")
            refusal.name = 'BootstrapSourceUnhealthyError'
            stubs.healthGate.assertBootstrapSourceHealthy
                .onFirstCall().resolves({ skipped: false, reasons: [] })
                .onSecondCall().rejects(refusal)

            stubs.execFile = sinon.stub().resolves({ stdout: '52428800\n' })

            const dumpProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(dumpProc)

            stubs.fs.promises.stat.resolves({ size: 512 * 1024 })
            stubs.fs.promises.writeFile.resolves()

            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER)

            setImmediate(() => {
                dumpProc.stdout.end()
                writeStream.emit('finish')
            })

            let err = null
            try { await promise } catch (e) { err = e }
            expect(err, 'the create must reject rather than publish').to.equal(refusal)

            // Nothing may be packaged or signed after the refusal.
            const tarCalls = stubs.execFile.getCalls()
                .filter(c => c.args[0] === 'tar' && (c.args[1] || [])[0] === 'czf')
            expect(tarCalls.length, 'no archive may be wrapped').to.equal(0)
            expect(stubs.fs.promises.writeFile.called, 'no checksum file may be written').to.equal(false)

            // The half-built work directory goes, and the republish ledger stays
            // honest: nothing was published, so nothing is recorded as published.
            expect(stubs.fs.rmSync.getCalls().some(c => String(c.args[0]).includes('bootstrap-work')))
                .to.equal(true)
            expect(stubs.republishLedger.recordBootstrapPublished.called).to.equal(false)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapMariaDb(): happy path', function () {
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
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapMariaDb(): happy path', function () {
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
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapMariaDb(): happy path', function () {
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
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapMariaDb(): happy path', function () {
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
})
