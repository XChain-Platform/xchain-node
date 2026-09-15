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
    FAKE_DB_CONTAINER,
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

    function stubDownloadedArchive(stubs) {
        stubs.fs.existsSync.callsFake(p => !/\.(pem|sig)$/.test(String(p)))
        const dataStream  = new PassThrough()
        const writeStream = new PassThrough()
        drainPassThrough(writeStream)
        stubs.fs.createWriteStream.returns(writeStream)
        stubs.axios.resolves({ status: 200, headers: {}, data: dataStream })
        return () => { dataStream.end(); writeStream.emit('finish') }
    }

    function captureLogs() {
        const lines = []
        const stub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
        return { lines, restore: () => stub.restore() }
    }


    // sizeAware(bytes): the archive-cleanup stat call always targets a path
    // ending in latest.tgz; every other fs.promises.stat call in the restore
    // path (inner-archive stats etc.) gets a small unrelated size instead, so
    // one stub can serve both without the two colliding.

    function sizeAwareStat(archiveBytes) {
        return async p => (String(p).endsWith('latest.tgz') ? { size: archiveBytes } : { size: 512 })
    }

    const UTXO_ARCHIVE_PATH    = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/latest.tgz'

    const DECODER_ARCHIVE_PATH = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/latest.tgz'

// An operator's BTC mainnet tracker archive (162551716982 bytes,
// 151 GiB) sat in the bootstrap volume for a week after a successful
// restore, because latest.tgz was never removed and downloadBootstrap
// re-downloads it unconditionally on every run anyway (no skip-if-present,
// by design: a kept copy going stale halted installs once). These cover the
// cleanup that closes that gap.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap archive cleanup after a restore attempt', function () {
        it('removes latest.tgz and its .sig after a successful utxo-tracker restore, and prints the GiB released', async function () {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubVerifiedInner(stubs, { innerName: 'data.tar.gz', checksumName: 'data.sha256', manageExistsSync: false })

            const ARCHIVE_BYTES = 162551716982 // the operator's reported archive size
            stubs.fs.promises.stat.callsFake(sizeAwareStat(ARCHIVE_BYTES))
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 0) })
                return tarProc
            })

            const bs = loadBootstrapService(stubs)
            const logs = captureLogs()
            let result
            try {
                const promise = bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
                setImmediate(finishDownload)
                result = await promise
            } finally {
                logs.restore()
            }

            expect(result).to.be.true
            const rmPaths = stubs.fs.rmSync.getCalls().map(c => c.args[0])
            expect(rmPaths, 'the archive itself must be removed').to.include(UTXO_ARCHIVE_PATH)
            expect(rmPaths, 'the detached signature must be removed too').to.include(UTXO_ARCHIVE_PATH + '.sig')
            const expectedGib = (ARCHIVE_BYTES / 1024 / 1024 / 1024).toFixed(1)
            expect(logs.lines).to.include(`Bootstrap archive removed after restore (${expectedGib} GiB released)`)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap archive cleanup after a restore attempt', function () {
        it('removes latest.tgz and its .sig after a successful decoder (MariaDB) restore', async function () {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubVerifiedInner(stubs, { innerName: 'dump.sql.gz', checksumName: 'dump.sha256', manageExistsSync: false })

            const ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024
            stubs.fs.promises.stat.callsFake(sizeAwareStat(ARCHIVE_BYTES))
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves('svc-cid')

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 0) })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            const logs = captureLogs()
            let result
            try {
                const promise = bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)
                setImmediate(finishDownload)
                result = await promise
            } finally {
                logs.restore()
            }

            expect(result).to.be.true
            const rmPaths = stubs.fs.rmSync.getCalls().map(c => c.args[0])
            expect(rmPaths).to.include(DECODER_ARCHIVE_PATH)
            expect(rmPaths).to.include(DECODER_ARCHIVE_PATH + '.sig')
            const expectedGib = (ARCHIVE_BYTES / 1024 / 1024 / 1024).toFixed(1)
            expect(logs.lines).to.include(`Bootstrap archive removed after restore (${expectedGib} GiB released)`)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap archive cleanup after a restore attempt', function () {
        it('removes the archive on a node-behind refusal too, since a re-run downloads a fresh copy anyway', async function () {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubs.nodeTipGuard.assessNodeTipForRestore.resolves({
                verdict: 'behind-refuse', refuse: true, detail: 'node behind'
            })
            stubs.spawn = sinon.stub()

            const ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
            stubs.fs.promises.stat.callsFake(sizeAwareStat(ARCHIVE_BYTES))

            const bs = loadBootstrapService(stubs)
            const logs = captureLogs()
            let result
            try {
                const promise = bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)
                setImmediate(finishDownload)
                result = await promise
            } finally {
                logs.restore()
            }

            expect(result).to.be.false
            expect(stubs.spawn.called, 'a refused restore must never run mariadb').to.equal(false)
            const rmPaths = stubs.fs.rmSync.getCalls().map(c => c.args[0])
            expect(rmPaths).to.include(DECODER_ARCHIVE_PATH)
            expect(rmPaths).to.include(DECODER_ARCHIVE_PATH + '.sig')
            const expectedGib = (ARCHIVE_BYTES / 1024 / 1024 / 1024).toFixed(1)
            expect(logs.lines.some(l => l.startsWith('Bootstrap archive removed') && l.includes(`${expectedGib} GiB released`))).to.be.true
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap archive cleanup after a restore attempt', function () {
        it('keeps the archive and reports its size and path when the restore itself fails', async function () {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            // A freshly-extracted inner archive whose bytes do not match the
            // checksum the (signature-verified) outer archive declares: a
            // corrupted download, which must fail the restore before the
            // container is ever stopped (so this is a plain 'failed' outcome,
            // not the postWipe one).
            stubVerifiedInner(stubs, {
                innerName: 'data.tar.gz', checksumName: 'data.sha256',
                initiallyPresent: false, innerHashOverride: 'c'.repeat(64), manageExistsSync: false
            })

            const ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024
            stubs.fs.promises.stat.callsFake(sizeAwareStat(ARCHIVE_BYTES))
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const bs = loadBootstrapService(stubs)
            const logs = captureLogs()
            let result
            try {
                const promise = bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
                setImmediate(finishDownload)
                result = await promise
            } finally {
                logs.restore()
            }

            expect(result).to.be.false
            const rmPaths = stubs.fs.rmSync.getCalls().map(c => c.args[0])
            expect(rmPaths, 'a failed restore must not remove the archive').to.not.include(UTXO_ARCHIVE_PATH)
            expect(rmPaths).to.not.include(UTXO_ARCHIVE_PATH + '.sig')
            const expectedGib = (ARCHIVE_BYTES / 1024 / 1024 / 1024).toFixed(1)
            expect(logs.lines).to.include(`Bootstrap archive kept after failed restore (${expectedGib} GiB at ${UTXO_ARCHIVE_PATH})`)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap archive cleanup after a restore attempt', function () {
        it('warns but does not fail the run when removing the archive itself errors', async function () {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubVerifiedInner(stubs, { innerName: 'data.tar.gz', checksumName: 'data.sha256', manageExistsSync: false })

            stubs.fs.promises.stat.callsFake(sizeAwareStat(1024 * 1024 * 1024))
            // Only the archive removal fails; unrelated rmSync housekeeping
            // (e.g. the restore's work-dir cleanup) is left alone.
            stubs.fs.rmSync.callsFake(p => {
                if (String(p) === UTXO_ARCHIVE_PATH) throw new Error('EBUSY: resource busy')
            })
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 0) })
                return tarProc
            })

            const bs = loadBootstrapService(stubs)
            const logs = captureLogs()
            let result
            try {
                const promise = bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
                setImmediate(finishDownload)
                result = await promise
            } finally {
                logs.restore()
            }

            // The restore already succeeded; a stray archive is disk hygiene,
            // never a reason to report the run itself as failed.
            expect(result).to.be.true
            expect(logs.lines.some(l =>
                l.startsWith('WARNING: could not remove the bootstrap archive') && l.includes(UTXO_ARCHIVE_PATH)
            )).to.be.true
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap archive cleanup after a restore attempt', function () {
        it('says in the install summary whether the archive was removed or kept', async function () {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubVerifiedInner(stubs, { innerName: 'data.tar.gz', checksumName: 'data.sha256', manageExistsSync: false })

            stubs.fs.promises.stat.callsFake(sizeAwareStat(1024 * 1024 * 1024))
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 0) })
                return tarProc
            })

            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()
            const promise = bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            setImmediate(finishDownload)
            expect(await promise).to.be.true

            const logs = captureLogs()
            try { bs.reportBootstrapOutcomes() } finally { logs.restore() }
            const summary = logs.lines.join('\n')
            expect(summary).to.match(/xchain-utxo-tracker: restored \(archive removed, 1\.0 GiB\)/)
        })
    })
})
