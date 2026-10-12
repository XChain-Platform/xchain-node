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
} = require('./helpers/support')

let savedRequireSigned

function allowUnsignedBootstrap() {
    savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
}

function restoreRequireSignedBootstrapSetting() {
    if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
}

const TRACKER_ARCHIVE = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/latest.tgz'
const DECODER_ARCHIVE = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/latest.tgz'

function declared(module, coin = COIN, network = NETWORK) {
    return { format: 1, module, coin, network, height: 100, created: '2026-09-01T00:00:00Z' }
}

function anyWipeOrExtract(stubs) {
    return stubs.execFile.getCalls().some(c => {
        const argv = Array.isArray(c.args[1]) ? c.args[1].join(' ') : ''
        return argv.includes('-delete') || argv.includes('DROP DATABASE') || (c.args[0] === 'tar' && c.args[1][0] === 'xzf')
    })
}

function mysqlSpawn(stubs) {
    const mysqlProc = makeSpawnProc()
    stubs.spawn = sinon.stub().callsFake(() => {
        setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 0) })
        return mysqlProc
    })
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

function archiveRemoved(stubs, archivePath) {
    return stubs.fs.rmSync.getCalls().some(c => String(c.args[0]) === archivePath)
}

describe('BootstrapService', function () {
    beforeEach(allowUnsignedBootstrap)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrap(): archive identity', function () {
        it('refuses a tracker archive declaring another coin/network before anything is stopped, wiped or extracted', async function () {
            const stubs = makeStubs()
            stubVerifiedInner(stubs, { archivePath: TRACKER_ARCHIVE })
            stubs.archiveMeta.readBootstrapArchiveMeta.resolves(declared(XChainService.XCHAIN_UTXO_TRACKER, 'dogecoin', 'testnet'))
            const bs = loadBootstrapService(stubs)

            const err = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'latest.tgz').then(() => null, e => e)
            expect(err).to.not.equal(null)
            expect(err.name).to.equal('BootstrapIntegrityError')
            expect(err.message).to.match(/coin dogecoin, network testnet/)
            expect(stubs.dockerService.stopContainer.called).to.equal(false)
            expect(anyWipeOrExtract(stubs)).to.equal(false)
        })

        it('refuses an indexer archive offered to the decoder (module-only mismatch) before the DROP', async function () {
            const stubs = makeStubs()
            stubVerifiedInner(stubs, { archivePath: DECODER_ARCHIVE, innerName: 'dump.sql.gz', checksumName: 'dump.sha256' })
            stubs.archiveMeta.readBootstrapArchiveMeta.resolves(declared(XChainService.XCHAIN_INDEXER))
            mysqlSpawn(stubs)
            const bs = loadBootstrapService(stubs)

            const err = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'latest.tgz').then(() => null, e => e)
            expect(err && err.name).to.equal('BootstrapIntegrityError')
            expect(err.message).to.match(/declares module xchain-indexer but the restore target is xchain-decoder/)
            expect(stubs.dockerService.stopContainer.called).to.equal(false)
            expect(stubs.spawn.called).to.equal(false)
            expect(anyWipeOrExtract(stubs)).to.equal(false)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(allowUnsignedBootstrap)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrap(): archive identity', function () {
        it('restores a matching archive exactly as before', async function () {
            const stubs = makeStubs()
            stubVerifiedInner(stubs, { archivePath: DECODER_ARCHIVE, innerName: 'dump.sql.gz', checksumName: 'dump.sha256' })
            stubs.archiveMeta.readBootstrapArchiveMeta.resolves(declared(XChainService.XCHAIN_DECODER))
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.db.getModuleContainer.resolves('svc-cid')
            stubs.fs.promises.stat.resolves({ size: 512 })
            mysqlSpawn(stubs)
            const bs = loadBootstrapService(stubs)

            expect(await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'latest.tgz')).to.equal(true)
            expect(stubs.spawn.called).to.equal(true)
        })

        it('restores a converted tracker archive whose coin/network are null, checking only its module', async function () {
            const stubs = makeStubs()
            stubVerifiedInner(stubs, { archivePath: TRACKER_ARCHIVE })
            stubs.archiveMeta.readBootstrapArchiveMeta.resolves(declared(XChainService.XCHAIN_UTXO_TRACKER, null, null))
            stubs.fs.promises.stat.resolves({ size: 2048, isFile: () => true })
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 0) })
                return tarProc
            })
            const bs = loadBootstrapService(stubs)

            expect(await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'latest.tgz')).to.equal(true)
            expect(stubs.dockerService.stopContainer.called).to.equal(true)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(allowUnsignedBootstrap)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrap(): archive identity', function () {
        it('records an identity mismatch on the install path as a failure that kept the archive, with no wipe', async function () {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubVerifiedInner(stubs, { manageExistsSync: false })
            stubs.archiveMeta.readBootstrapArchiveMeta.resolves(declared(XChainService.XCHAIN_UTXO_TRACKER, 'litecoin'))
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()

            const promise = bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            setImmediate(finishDownload)
            expect(await promise).to.equal(false)
            expect(stubs.dockerService.stopContainer.called).to.equal(false)
            expect(archiveRemoved(stubs, TRACKER_ARCHIVE)).to.equal(false)

            const lines = []
            const log = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
            try { bs.reportBootstrapOutcomes() } finally { log.restore() }
            expect(lines.join('\n')).to.match(/xchain-utxo-tracker: NOT restored: Bootstrap archive identity mismatch .* declares coin litecoin/)
        })
    })
})

describe('BootstrapService', function () {
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('the node tip guard refusal is signature-verified before the archive is retired', function () {
        it('keeps a refused archive that fails its signature check and records the integrity failure, not node lag', async function () {
            // Signatures required (the default) and none published: checkBootstrapSignature throws, as it does for a tampered archive.
            savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
            delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubs.nodeTipGuard.assessNodeTipForRestore.resolves({ verdict: 'behind-refuse', refuse: true, detail: 'node behind a forged height' })
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()

            const promise = bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            setImmediate(finishDownload)
            expect(await promise).to.equal(false)
            expect(archiveRemoved(stubs, DECODER_ARCHIVE), 'the unverified archive is evidence and must be kept').to.equal(false)

            const lines = []
            const log = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
            try { bs.reportBootstrapOutcomes() } finally { log.restore() }
            const summary = lines.join('\n')
            expect(summary).to.match(/xchain-decoder: NOT restored: Refusing unsigned bootstrap/)
            expect(summary).to.not.match(/the coin node is behind the archive/)
        })

        it('retires a refused archive once its signature check passes, recording node-behind as before', async function () {
            allowUnsignedBootstrap()
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubs.nodeTipGuard.assessNodeTipForRestore.resolves({ verdict: 'behind-refuse', refuse: true, detail: 'node behind' })
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()

            const promise = bs.ensureBootstrapUtxoTracker(COIN, NETWORK)
            setImmediate(finishDownload)
            expect(await promise).to.equal(false)
            expect(archiveRemoved(stubs, TRACKER_ARCHIVE)).to.equal(true)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(allowUnsignedBootstrap)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('the node tip guard refusal checks the archive identity before the archive is retired', function () {

        // Refuse on the node tip, then run the ensure path and return its result and the end-of-install summary.
        async function refusedRun(meta, ensure) {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubs.nodeTipGuard.assessNodeTipForRestore.resolves({ verdict: 'behind-refuse', refuse: true, detail: 'node behind' })
            stubs.archiveMeta.readBootstrapArchiveMeta.resolves(meta)
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()
            const promise = ensure(bs)
            setImmediate(finishDownload)
            const result = await promise
            const lines = []
            const log = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
            try { bs.reportBootstrapOutcomes() } finally { log.restore() }
            return { stubs, result, summary: lines.join('\n') }
        }

        it('keeps a refused tracker archive declaring another coin and records the mismatch, not node lag', async function () {
            const { stubs, result, summary } = await refusedRun(declared(XChainService.XCHAIN_UTXO_TRACKER, 'litecoin'),
                bs => bs.ensureBootstrapUtxoTracker(COIN, NETWORK))
            expect(result).to.equal(false)
            expect(archiveRemoved(stubs, TRACKER_ARCHIVE), 'a mis-published archive is evidence and must be kept').to.equal(false)
            expect(summary).to.match(/xchain-utxo-tracker: NOT restored: Bootstrap archive identity mismatch .* declares coin litecoin/)
            expect(summary).to.not.match(/the coin node is behind the archive/)
        })

        it('keeps a refused indexer archive offered to the decoder (module-only mismatch)', async function () {
            const { stubs, result, summary } = await refusedRun(declared(XChainService.XCHAIN_INDEXER),
                bs => bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER))
            expect(result).to.equal(false)
            expect(archiveRemoved(stubs, DECODER_ARCHIVE)).to.equal(false)
            expect(summary).to.match(/declares module xchain-indexer but the restore target is xchain-decoder/)
            expect(summary).to.not.match(/the coin node is behind the archive/)
        })

        it('still retires a refused archive whose identity matches, recording node-behind', async function () {
            const { stubs, result, summary } = await refusedRun(declared(XChainService.XCHAIN_DECODER),
                bs => bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER))
            expect(result).to.equal(false)
            expect(archiveRemoved(stubs, DECODER_ARCHIVE)).to.equal(true)
            expect(summary).to.not.match(/identity mismatch/)
        })
    })
})

describe('BootstrapService', function () {
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('the node tip guard refusal is announced only after the archive is verified', function () {

        // Refuse on the node tip, run the ensure path, and capture what it printed while it ran.
        async function refusedRunOutput(ensure) {
            const stubs = makeStubs()
            const finishDownload = stubDownloadedArchive(stubs)
            stubs.nodeTipGuard.assessNodeTipForRestore.resolves({ verdict: 'behind-refuse', refuse: true, detail: 'the coin node is 5 blocks below the archive' })
            const bs = loadBootstrapService(stubs)
            bs.resetBootstrapOutcomes()
            const lines = []
            const log = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
            let result
            try {
                const promise = ensure(bs)
                setImmediate(finishDownload)
                result = await promise
            } finally { log.restore() }
            return { result, output: lines.join('\n') }
        }

        it('prints no REFUSING line for an unsigned archive on either restore path', async function () {
            savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
            delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
            for (const ensure of [bs => bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER), bs => bs.ensureBootstrapUtxoTracker(COIN, NETWORK)]) {
                const { result, output } = await refusedRunOutput(ensure)
                expect(result).to.equal(false)
                expect(output).to.not.match(/REFUSING the/)
                expect(output).to.match(/bootstrap auto-restore failed/)
            }
        })

        it('prints the REFUSING line once the archive verifies, before it is retired, on either restore path', async function () {
            allowUnsignedBootstrap()
            const cases = [
                [XChainService.XCHAIN_DECODER, bs => bs.ensureBootstrapMariaDb(COIN, NETWORK, XChainService.XCHAIN_DECODER)],
                [XChainService.XCHAIN_UTXO_TRACKER, bs => bs.ensureBootstrapUtxoTracker(COIN, NETWORK)]
            ]
            for (const [module, ensure] of cases) {
                const { result, output } = await refusedRunOutput(ensure)
                expect(result).to.equal(false)
                const refused = output.indexOf(`REFUSING the ${module} bootstrap restore: the coin node is 5 blocks below the archive.`)
                expect(refused, output).to.be.at.least(0)
                const removed = output.indexOf('Bootstrap archive removed')
                expect(removed, output).to.be.above(refused)
            }
        })
    })
})
