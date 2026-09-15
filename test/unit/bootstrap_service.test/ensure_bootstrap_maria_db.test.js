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

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
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
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('ensureBootstrapMariaDb()', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
        })
        it('returns false when no bootstrap available for decoder', async function () {
            const stubs = makeStubs()
            stubs.axios.resolves({ status: 404, headers: {}, data: new PassThrough() })
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('ensureBootstrapMariaDb()', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
        })
        it('returns false when no bootstrap available for indexer', async function () {
            const stubs = makeStubs()
            stubs.axios.resolves({ status: 404, headers: {}, data: new PassThrough() })
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_INDEXER)
            expect(result).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('ensureBootstrapMariaDb()', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
        })
        it('returns false (best-effort) when download throws', async function () {
            const stubs = makeStubs()
            stubs.axios.rejects(new Error('timeout'))
            stubs.fs.existsSync.returns(true)
            const bs = loadBootstrapService(stubs)
            const result = await bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('ensureBootstrapMariaDb()', function () {
        afterEach(function () {
            delete process.env.XCHAIN_NODE_NO_BOOTSTRAP
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
})

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

// A bootstrap restored next to a coin node still syncing from zero
// put a decoder thousands of blocks above its node; the released services
// read that as a reorg and halted. The ensure paths now consult the node
// tip guard between the download and the restore.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('the coin node tip guard between download and restore', function () {
        it('a refusal records node-behind, restores nothing, and the summary says how to take it later', async function () {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubs.nodeTipGuard.assessNodeTipForRestore.resolves({
                verdict: 'behind-refuse', refuse: true,
                detail: 'the coin node is at 962304 (initial block download), 2666 blocks below the archive\'s 964970, and this xchain-decoder image does not wait'
            })
            stubs.spawn = sinon.stub()
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()

            const promise = bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            setImmediate(finishDownload)
            expect(await promise).to.be.false

            // The guard saw the downloaded archive's path, and nothing was
            // dropped or reimported after it refused.
            const call = stubs.nodeTipGuard.assessNodeTipForRestore.firstCall.args[0]
            expect(call).to.include({ coin: COIN, network: NETWORK, module: XChainService.XCHAIN_DECODER })
            expect(call.archivePath).to.match(/xchain-decoder\/bootstrap\/latest\.tgz$/)
            expect(stubs.spawn.called, 'no mariadb restore may be spawned').to.equal(false)
            expect(stubs.dockerService.stopContainer.called).to.equal(false)

            const logs = captureLogs()
            try { bs.reportBootstrapOutcomes() } finally { logs.restore() }
            const summary = logs.lines.join('\n')
            expect(summary).to.match(/xchain-decoder: NOT restored, the coin node is behind the archive: the coin node is at 962304/)
            expect(summary).to.match(/wait for the\nnode to pass the archive height and re-run install with XCHAIN_NODE_FORCE_BOOTSTRAP=1/)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('the coin node tip guard between download and restore', function () {
        it('a behind-wait verdict still restores and the summary marks it WAITING FOR NODE', async function () {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubVerifiedInner(stubs, { innerName: 'dump.sql.gz', checksumName: 'dump.sha256', manageExistsSync: false })
            stubs.nodeTipGuard.assessNodeTipForRestore.resolves({
                verdict: 'behind-wait', refuse: false,
                detail: 'the coin node is at 962304 (initial block download), 2666 blocks below the archive\'s 964970; the xchain-decoder waits until the node passes 964970'
            })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.db.getModuleContainer.resolves('svc-cid')
            stubs.fs.promises.stat.resolves({ size: 512 })
            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 0) })
                return mysqlProc
            })
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()

            const promise = bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            setImmediate(finishDownload)
            expect(await promise).to.be.true
            expect(stubs.spawn.called, 'the restore goes ahead').to.equal(true)

            const logs = captureLogs()
            try { bs.reportBootstrapOutcomes() } finally { logs.restore() }
            const summary = logs.lines.join('\n')
            expect(summary).to.match(/xchain-decoder: restored, WAITING FOR NODE: the coin node is at 962304/)
            expect(summary).to.not.match(/XCHAIN_NODE_FORCE_BOOTSTRAP/)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('the coin node tip guard between download and restore', function () {
        it('the tracker path refuses the same way, before its volume is touched', async function () {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubs.nodeTipGuard.assessNodeTipForRestore.resolves({ verdict: 'behind-refuse', refuse: true, detail: 'node behind' })
            stubs.execFile = sinon.stub().resolves({ stdout: '' })
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()

            const promise = bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            setImmediate(finishDownload)
            expect(await promise).to.be.false
            expect(stubs.dockerService.stopContainer.called, 'the tracker must not be stopped').to.equal(false)
            const wipe = stubs.execFile.getCalls().find(c => Array.isArray(c.args[1]) && c.args[1].join(' ').includes('-delete'))
            expect(wipe, 'the volume must not be cleared').to.not.exist
        })
    })
})
