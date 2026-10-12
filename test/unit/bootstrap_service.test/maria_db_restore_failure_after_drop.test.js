'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// A MariaDB restore that fails once the DROP has run leaves the service's
// database gone or partly imported. The service stays stopped, the error is
// tagged post-wipe, and the install summary says so instead of "syncing from
// block 0". A failure before the DROP still restarts the service.

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
    stubVerifiedInner,
    loadBootstrapService
} = require('./helpers/support')

const DECODER = XChainService.XCHAIN_DECODER
const ARCHIVE_PATH = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
let savedRequireSigned

function saveRequireSignedBootstrapSetting() {
    savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
}

function restoreRequireSignedBootstrapSetting() {
    if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
}

function failingImport(stubs, code) {
    const mysqlProc = makeSpawnProc()
    stubs.spawn = sinon.stub().callsFake(() => {
        setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', code) })
        return mysqlProc
    })
}

function captureLogs() {
    const lines = []
    const stub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
    return { lines, restore: () => stub.restore() }
}

async function rejection(promise) {
    try { await promise } catch (err) { return err }
    throw new Error('expected a rejection')
}

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)

    describe('restoreBootstrapMariaDb(): a failure after the DROP', function () {
        it('leaves the service stopped when the DROP/CREATE call itself fails, and never imports', async function () {
            const stubs = makeStubs()
            stubVerifiedInner(stubs, { archivePath: ARCHIVE_PATH, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.execFile.withArgs('docker', sinon.match((args) => args.join(' ').includes('DROP DATABASE')))
                .rejects(new Error('ERROR 2013: Lost connection to server during query'))
            stubs.db.getModuleContainer.resolves('svc-container-id')
            failingImport(stubs, 0)

            const bs = loadBootstrapService(stubs)
            const err = await rejection(bs.restoreBootstrap(COIN, NETWORK, DECODER, 'dump.sql.gz'))
            expect(err.message).to.include('Lost connection')
            expect(err.postWipe, 'the DROP may have run before the call failed').to.be.true
            expect(stubs.dockerService.stopContainer.called).to.be.true
            expect(stubs.dockerService.startContainer.called).to.be.false
            expect(stubs.spawn.called).to.be.false
        })

        it('does not tag a failure before the DROP, which leaves the database as it was', async function () {
            const stubs = makeStubs()
            stubVerifiedInner(stubs, { archivePath: ARCHIVE_PATH, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.databaseService.getDatabaseContainerId.resolves(null)
            const bs = loadBootstrapService(stubs)
            const err = await rejection(bs.restoreBootstrap(COIN, NETWORK, DECODER, 'dump.sql.gz'))
            expect(err.message).to.include('MariaDB container not found')
            expect(err.postWipe).to.equal(undefined)
            const drop = stubs.execFile.getCalls().find((c) => Array.isArray(c.args[1]) && c.args[1].join(' ').includes('DROP DATABASE'))
            expect(drop, 'nothing was dropped').to.not.exist
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)

    describe('ensureBootstrapMariaDb(): a failure after the DROP', function () {
        it('records the service as wiped and left down, not as syncing from block 0', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.callsFake((p) => !/\.(pem|sig)$/.test(String(p)))
            const dataStream  = new PassThrough()
            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)
            stubs.axios.resolves({ status: 200, headers: {}, data: dataStream })
            stubVerifiedInner(stubs, { innerName: 'dump.sql.gz', checksumName: 'dump.sha256', manageExistsSync: false })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.db.getModuleContainer.resolves('svc-cid')
            stubs.fs.promises.stat.resolves({ size: 512 })
            failingImport(stubs, 2)
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()

            const promise = bs.ensureBootstrapMariaDb(COIN, NETWORK, DECODER)
            setImmediate(() => { dataStream.end(); writeStream.emit('finish') })
            expect(await promise).to.be.false
            expect(stubs.dockerService.startContainer.called).to.be.false

            const logs = captureLogs()
            try { bs.reportBootstrapOutcomes() } finally { logs.restore() }
            const summary = logs.lines.join('\n')
            expect(summary).to.match(/xchain-decoder: NOT restored, DATA WIPED, container left stopped: mariadb restore exited with code 2/)
            expect(summary).to.match(/drop the database/)
            expect(summary).to.not.match(/syncing from block 0/)
        })
    })
})
