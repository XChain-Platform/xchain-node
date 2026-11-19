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
    makeAutoSpawn,
    makeStubs,
    stubVerifiedInner,
    loadBootstrapService
} = require('../helpers/support')

const trackerHeight = require('../../../../src/services/bootstrap_service/tracker_height')

let savedRequireSigned

beforeEach(function () {
    savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
})

afterEach(function () {
    if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
})

function configureHeightReader(stdout = '103\n') {
    const execFile = sinon.stub().callsFake((command, args, options, callback) => {
        callback(null, { stdout, stderr: '' })
    })
    trackerHeight.configureDependencies({
        childProcess: { execFile },
        config: { XChainService },
        configService: { getDefaultConfig: sinon.stub().resolves({}) },
        bootstrapHealthGate: {},
        logger: { info: sinon.stub() }
    })
    return execFile
}

function configureMariaCreate(stubs) {
    stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
    stubs.databaseService.askMariadbRootPassword.resolves('rootpass')
    stubs.execFile = sinon.stub().resolves({ stdout: '1\n' })
    stubs.fs.promises.stat.resolves({ size: 512 })
    stubs.fs.createReadStream.callsFake(() => {
        const stream = new PassThrough()
        setImmediate(() => stream.end(Buffer.from('sql dump')))
        return stream
    })
    const dumpProc = makeSpawnProc()
    stubs.spawn = sinon.stub().returns(dumpProc)
    const writeStream = new PassThrough()
    drainPassThrough(writeStream)
    stubs.fs.createWriteStream.returns(writeStream)
    return { dumpProc, writeStream }
}

describe('bootstrap archive producer completion contract', function () {
    it('rejects a MariaDB dump that exits after its output stream finishes', async function () {
        const stubs = makeStubs()
        const { dumpProc, writeStream } = configureMariaCreate(stubs)
        const bs = loadBootstrapService(stubs)
        const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER)

        setImmediate(() => {
            dumpProc.stdout.end()
            writeStream.emit('finish')
            setImmediate(() => dumpProc.emit('close', 2))
        })

        let error
        try { await promise } catch (err) { error = err }
        expect(error && error.message).to.include('mariadb-dump exited with code 2')
        expect(stubs.execFile.getCalls().some(call => call.args[0] === 'tar')).to.equal(false)
    })

    it('rejects a producer killed by a signal after its output stream finishes', async function () {
        const stubs = makeStubs()
        const { dumpProc, writeStream } = configureMariaCreate(stubs)
        const bs = loadBootstrapService(stubs)
        const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER)

        setImmediate(() => {
            dumpProc.stdout.end()
            writeStream.emit('finish')
            setImmediate(() => dumpProc.emit('close', null, 'SIGKILL'))
        })

        let error
        try { await promise } catch (err) { error = err }
        expect(error && error.message).to.include('code null (signal SIGKILL)')
        expect(stubs.fs.promises.writeFile.called).to.equal(false)
    })

    it('rejects a tracker tar failure before writing its checksum or signing', async function () {
        const stubs = makeStubs()
        stubs.execFile = sinon.stub().resolves({ stdout: '1048576\n' })
        makeAutoSpawn(stubs, { exitCodes: { 0: 2 } })
        const bs = loadBootstrapService(stubs)

        let error
        try { await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER) } catch (err) { error = err }

        expect(error && error.message).to.include('docker tar exited with code 2')
        expect(stubs.fs.promises.writeFile.called).to.equal(false)
        expect(stubs.dockerService.startContainer.called).to.equal(true)
    })
})

describe('bootstrap archive frozen height contract', function () {
    it('reads LAST_BLOCK_HEIGHT from the archived tracker store through its image', async function () {
        const execFile = configureHeightReader('103\n')

        const height = await trackerHeight.readFrozenStoreHeight('tracker-volume', '/data/.snapshot', FAKE_CONTAINER_ID)

        expect(height).to.equal(103)
        const calls = execFile.getCalls().map(call => call.args[1])
        expect(calls[0]).to.include(FAKE_CONTAINER_ID)
        expect(calls[1]).to.include('tracker-volume:/data')
        expect(calls[1]).to.include('/data/.snapshot/xchain-utxo-tracker')
    })

    it('refuses live heights when the archived store height is unavailable', function () {
        configureHeightReader()
        expect(() => trackerHeight.chooseArchiveHeight(100, 102, null)).to.throw(/archived store/)
        expect(trackerHeight.chooseArchiveHeight(100, 102, 103)).to.equal(103)
    })

    it('does not wrap or sign when the archived LevelDB height cannot be read', async function () {
        const stubs = makeStubs()
        stubs.execFile = sinon.stub().callsFake((cmd, args) => {
            if (cmd === 'docker' && args[0] === 'inspect') return Promise.resolve({ stdout: 'sha256:tracker-image\n' })
            if (cmd === 'docker' && args.some(arg => String(arg).includes('LAST_BLOCK_HEIGHT'))) {
                return Promise.reject(new Error('height unavailable'))
            }
            return Promise.resolve({ stdout: '1048576\n' })
        })
        const spawnCalls = []
        stubs.spawn = sinon.stub().callsFake(() => {
            const proc = makeSpawnProc()
            spawnCalls.push(proc)
            setImmediate(() => {
                proc.stdout.end(Buffer.from('tar-bytes'))
                setImmediate(() => proc.emit('close', 0))
            })
            return proc
        })
        stubs.fs.createWriteStream.callsFake(() => {
            const stream = new PassThrough()
            drainPassThrough(stream)
            return stream
        })
        const bs = loadBootstrapService(stubs)

        let error
        try { await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER) } catch (err) { error = err }

        expect(error && error.message).to.include('archived store')
        expect(spawnCalls).to.have.length(1)
        expect(stubs.archiveMeta.writeBootstrapMeta.called).to.equal(false)
    })
})

async function rejectInvalidStagedLayout() {
    const stubs = makeStubs()
    const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
    stubVerifiedInner(stubs, { archivePath, initiallyPresent: true })
    stubs.databaseService.ensureDatabasePool.resolves()
    stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
    stubs.fs.promises.stat.resolves({ size: 512 })
    stubs.execFile.withArgs('docker', sinon.match(args => args.includes('inspect')))
        .resolves({ stdout: 'sha256:tracker-image\n' })
    stubs.execFile.withArgs('docker', sinon.match(args => args.some(arg => String(arg).includes('assertStagedLayoutOrThrow'))))
        .rejects(new Error('layout 1 is not supported'))
    const tarProc = makeSpawnProc()
    stubs.spawn = sinon.stub().callsFake(() => {
        setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 0) })
        return tarProc
    })
    const bs = loadBootstrapService(stubs)
    let error
    try { await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz') } catch (err) { error = err }
    expect(error && error.message).to.include('layout 1')
    expect(error && error.postWipe).to.not.equal(true)
    const scripts = stubs.execFile.getCalls().map(call => String((call.args[1] || []).at(-1)))
    expect(scripts.some(script => script.includes("! -name '.restore-staging'"))).to.equal(false)
    expect(stubs.dockerService.startContainer.calledOnceWithExactly(FAKE_CONTAINER_ID)).to.equal(true)
}

async function validateNestedTrackerStore() {
    const stubs = makeStubs()
    const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
    stubVerifiedInner(stubs, { archivePath, initiallyPresent: true })
    stubs.databaseService.ensureDatabasePool.resolves()
    stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
    stubs.fs.promises.stat.resolves({ size: 512 })
    const tarProc = makeSpawnProc()
    stubs.spawn = sinon.stub().callsFake(() => {
        setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 0) })
        return tarProc
    })
    const bs = loadBootstrapService(stubs)
    expect(await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')).to.equal(true)
    const calls = stubs.execFile.getCalls()
    const validation = calls.find(call => (call.args[1] || []).some(arg => String(arg).includes('assertStagedLayoutOrThrow')))
    const wipe = calls.find(call => String((call.args[1] || []).at(-1)).includes("! -name '.restore-staging'"))
    const promote = calls.find(call => String((call.args[1] || []).at(-1)).includes('-exec mv {} /data/'))
    expect(validation.args[1]).to.include('/store/.restore-staging/xchain-utxo-tracker')
    expect(validation.calledBefore(wipe)).to.equal(true)
    expect(wipe.calledBefore(promote)).to.equal(true)
}

async function leaveTrackerStoppedAfterPromotionFailure() {
    const stubs = makeStubs()
    const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
    stubVerifiedInner(stubs, { archivePath, initiallyPresent: true })
    stubs.databaseService.ensureDatabasePool.resolves()
    stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
    stubs.fs.promises.stat.resolves({ size: 512 })
    stubs.execFile.withArgs('docker', sinon.match(args =>
        String(args.at(-1)).includes('-exec mv {} /data/'))).rejects(new Error('promotion failed'))
    const tarProc = makeSpawnProc()
    stubs.spawn = sinon.stub().callsFake(() => {
        setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 0) })
        return tarProc
    })
    const bs = loadBootstrapService(stubs)
    let error
    try { await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz') } catch (err) { error = err }
    expect(error && error.message).to.include('promotion failed')
    expect(error && error.postWipe).to.equal(true)
    expect(stubs.dockerService.startContainer.called).to.equal(false)
}

describe('bootstrap tracker restore validation contract', function () {
    it('restarts the tracker without wiping when staged layout validation fails', rejectInvalidStagedLayout)
    it('validates the nested tracker store before wiping and promoting the staged volume', validateNestedTrackerStore)
    it('leaves the tracker stopped when promotion fails after the live-volume wipe', leaveTrackerStoppedAfterPromotionFailure)
})
