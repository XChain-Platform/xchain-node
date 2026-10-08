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
} = require('./helpers/support')

// The support stub derives every module's default name as this one string.
const DEFAULT_NAME = 'xchain_btc_mainnet_decoder'
const VOLUMES = {
    DECODER_BOOTSTRAP_VOLUME: '/data/bitcoin/mainnet/xchain-decoder/bootstrap/',
    INDEXER_BOOTSTRAP_VOLUME: '/data/bitcoin/mainnet/xchain-indexer/bootstrap/'
}

let savedRequireSigned

function saveRequireSignedBootstrapSetting() {
    savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
}

function restoreRequireSignedBootstrapSetting() {
    if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
}

function stubsWithConfig(overrides) {
    const stubs = makeStubs()
    stubs.configService.getDefaultConfig.resolves({ ...VOLUMES, ...overrides })
    return stubs
}

// Every argv element the module handed to execFile and spawn, flattened to strings.
function issuedArgs(stubs) {
    const calls = [...stubs.execFile.getCalls(), ...(stubs.spawn ? stubs.spawn.getCalls() : [])]
    return calls.flatMap(c => [c.args[0], ...(Array.isArray(c.args[1]) ? c.args[1] : [])]).map(String)
}

async function restoreWithConfig(module, overrides) {
    const stubs = stubsWithConfig(overrides)
    const archivePath = `${module === XChainService.XCHAIN_DECODER ? VOLUMES.DECODER_BOOTSTRAP_VOLUME : VOLUMES.INDEXER_BOOTSTRAP_VOLUME}dump.sql.gz`
    stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
    stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
    stubs.db.getModuleContainer.resolves('svc-container-id')
    stubs.fs.promises.stat.resolves({ size: 1024 })
    const mysqlProc = makeSpawnProc()
    stubs.spawn = sinon.stub().callsFake(() => {
        setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 0) })
        return mysqlProc
    })
    const bs = loadBootstrapService(stubs)
    let error = null
    try { await bs.restoreBootstrap(COIN, NETWORK, module, 'dump.sql.gz') } catch (err) { error = err }
    return { stubs, error }
}

async function dumpWithConfig(overrides) {
    const stubs = stubsWithConfig(overrides)
    stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
    stubs.execFile = sinon.stub().resolves({ stdout: '1024\n' })
    const dumpProc = makeSpawnProc()
    stubs.spawn = sinon.stub().returns(dumpProc)
    stubs.fs.promises.stat.resolves({ size: 512 })
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
    setImmediate(() => { dumpProc.stdout.end(); writeStream.emit('finish') })
    await promise
    return stubs
}

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)

    describe('operator-overridden database names', function () {
        it('restores into the configured decoder database, never the derived default', async function () {
            const { stubs, error } = await restoreWithConfig(XChainService.XCHAIN_DECODER, { DECODER_DB_NAME: 'CustomDecoder' })
            expect(error).to.equal(null)
            const args = issuedArgs(stubs)
            expect(args.some(a => a.includes('DROP DATABASE IF EXISTS CustomDecoder'))).to.equal(true)
            expect(args).to.include('CustomDecoder')
            expect(args.some(a => a.includes(DEFAULT_NAME))).to.equal(false)
        })

        it('restores into the configured indexer database', async function () {
            const { stubs, error } = await restoreWithConfig(XChainService.XCHAIN_INDEXER,
                { DECODER_DB_NAME: 'CustomDecoder', INDEXER_DB_NAME: 'CustomIndexer' })
            expect(error).to.equal(null)
            const args = issuedArgs(stubs)
            expect(args.some(a => a.includes('DROP DATABASE IF EXISTS CustomIndexer'))).to.equal(true)
            expect(args.some(a => a.includes('CustomDecoder') || a.includes(DEFAULT_NAME))).to.equal(false)
        })

        it('refuses an unsafe configured name before stopping the service or dropping anything', async function () {
            const { stubs, error } = await restoreWithConfig(XChainService.XCHAIN_DECODER,
                { DECODER_DB_NAME: 'Custom; DROP DATABASE mysql' })
            expect(error && error.message).to.match(/Unsafe MariaDB database name/)
            expect(stubs.dockerService.stopContainer.called).to.equal(false)
            expect(issuedArgs(stubs).some(a => a.includes('DROP DATABASE'))).to.equal(false)
        })

        it('samples freshness from the configured database', async function () {
            const stubs = stubsWithConfig({ INDEXER_DB_NAME: 'CustomIndexer' })
            stubs.execFile = sinon.stub().resolves({ stdout: '1\n' })
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_INDEXER)
            expect(result).to.equal('populated')
            const args = issuedArgs(stubs)
            expect(args.some(a => a.includes('CustomIndexer'))).to.equal(true)
            expect(args.some(a => a.includes(DEFAULT_NAME))).to.equal(false)
        })

        it('samples freshness from the derived default when the configured name is blank', async function () {
            const stubs = stubsWithConfig({ INDEXER_DB_NAME: '  ' })
            stubs.execFile = sinon.stub().resolves({ stdout: '1\n' })
            const bs = loadBootstrapService(stubs)
            await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_INDEXER)
            expect(issuedArgs(stubs).some(a => a.includes(DEFAULT_NAME))).to.equal(true)
        })

        it('reports freshness unknown, probing nothing, when the configured name is unsafe', async function () {
            const stubs = stubsWithConfig({ DECODER_DB_NAME: 'Custom; DROP DATABASE mysql' })
            stubs.execFile = sinon.stub().resolves({ stdout: '0\n' })
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('unknown')
            expect(stubs.execFile.called).to.equal(false)
        })

        it('dumps the configured database when publishing a bootstrap', async function () {
            const stubs = await dumpWithConfig({ DECODER_DB_NAME: 'CustomDecoder' })
            const [, dumpArgs] = stubs.spawn.firstCall.args
            expect(dumpArgs).to.include('mariadb-dump')
            expect(dumpArgs[dumpArgs.length - 1]).to.equal('CustomDecoder')
            expect(issuedArgs(stubs).some(a => a.includes(DEFAULT_NAME))).to.equal(false)
        })
    })
})
