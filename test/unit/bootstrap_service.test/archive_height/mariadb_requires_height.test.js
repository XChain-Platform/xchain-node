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
} = require('../helpers/support')

async function attemptBootstrap(heightResult) {
    const stubs = makeStubs()
    stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
    stubs.databaseService.askMariadbRootPassword.resolves('rootpass')
    stubs.execFile = sinon.stub().callsFake((cmd, args) => {
        const readsHeight = cmd === 'docker' && args.some(arg => /MAX\(block_index\)/.test(String(arg)))
        if (!readsHeight) return Promise.resolve({ stdout: '52428800\n' })
        if (heightResult instanceof Error) return Promise.reject(heightResult)
        return Promise.resolve({ stdout: heightResult })
    })
    const dumpProc = makeSpawnProc()
    stubs.spawn = sinon.stub().returns(dumpProc)
    stubs.fs.promises.stat.resolves({ size: 512 * 1024 })
    stubs.fs.promises.writeFile.resolves()
    stubs.fs.createReadStream.callsFake(() => {
        const stream = new PassThrough()
        setImmediate(() => {
            stream.emit('data', Buffer.from('sql dump content'))
            stream.emit('end')
        })
        return stream
    })
    const writeStream = new PassThrough()
    drainPassThrough(writeStream)
    stubs.fs.createWriteStream.returns(writeStream)

    const service = loadBootstrapService(stubs)
    const pending = service.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER)
    setImmediate(() => {
        dumpProc.stdout.end()
        writeStream.emit('finish')
        dumpProc.emit('close', 0)
    })
    let error = null
    try { await pending } catch (err) { error = err }
    return { error, stubs }
}

function assertRefusedBeforePackaging({ error, stubs }) {
    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/tip height/i)
    expect(stubs.archiveMeta.writeBootstrapMeta.called).to.equal(false)
    expect(stubs.execFile.getCalls().some(call =>
        call.args[0] === 'tar' && (call.args[1] || [])[0] === 'czf')).to.equal(false)
    expect(stubs.fs.rmSync.getCalls().some(call =>
        String(call.args[0]).includes('bootstrap-work'))).to.equal(true)
}

describe('BootstrapService MariaDB archive height', function () {
    let savedRequireSigned

    beforeEach(function () {
        savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
        process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
    })

    afterEach(function () {
        if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
        else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
    })

    it('refuses to package an archive when the blocks table is empty', async function () {
        assertRefusedBeforePackaging(await attemptBootstrap('NULL\n'))
    })

    it('refuses to package an archive when the tip query fails', async function () {
        assertRefusedBeforePackaging(await attemptBootstrap(new Error('query unavailable')))
    })

    it('accepts height zero as an established archive tip', async function () {
        const { error, stubs } = await attemptBootstrap('0\n')
        expect(error).to.equal(null)
        expect(stubs.archiveMeta.writeBootstrapMeta.calledOnce).to.equal(true)
        expect(stubs.archiveMeta.writeBootstrapMeta.firstCall.args[1].height).to.equal(0)
    })
})
