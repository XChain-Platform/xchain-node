'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    COIN,
    NETWORK,
    FAKE_DB_CONTAINER,
    PassThrough,
    XChainService,
    drainPassThrough,
    expect,
    loadBootstrapService,
    makeSpawnProc,
    makeStubs,
    sinon
} = require('../../bootstrap_service.test/helpers/support')

const CAPTURED_HALT = [
    'CREATE TABLE `sync_state` (',
    '  `state_key` varchar(128) NOT NULL,',
    '  `state_value` text DEFAULT NULL,',
    '  `updated_at` datetime DEFAULT current_timestamp(),',
    '  PRIMARY KEY (`state_key`)',
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci;',
    "INSERT INTO `sync_state` VALUES ('halt_pending:decoder','halt',NULL);",
    ''
].join('\n')

function startCreate({ skip = false } = {}) {
    const stubs = makeStubs()
    stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
    stubs.databaseService.askMariadbRootPassword.resolves('rootpass')
    stubs.healthGate.gateSkipped.returns(skip)
    stubs.execFile = sinon.stub().resolves({ stdout: '0\n' })
    stubs.fs.promises.stat.resolves({ size: 512 * 1024 })
    stubs.fs.promises.writeFile.resolves()
    stubs.fs.createReadStream.callsFake(() => {
        const stream = new PassThrough()
        setImmediate(() => stream.end(Buffer.from('compressed dump')))
        return stream
    })
    const dumpProc = makeSpawnProc()
    stubs.spawn = sinon.stub().returns(dumpProc)
    const writeStream = new PassThrough()
    drainPassThrough(writeStream)
    stubs.fs.createWriteStream.returns(writeStream)
    const service = loadBootstrapService(stubs)
    const promise = service.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER)
    setImmediate(() => {
        dumpProc.stdout.end(Buffer.from(CAPTURED_HALT))
        writeStream.emit('finish')
        dumpProc.emit('close', 0)
    })
    return { promise, stubs }
}

describe('BootstrapService captured sync_state inspection', function () {
    it('refuses a pending halt captured while both live gate readings are clean', async function () {
        const { promise, stubs } = startCreate()
        let err
        try { await promise } catch (caught) { err = caught }
        expect(err).to.exist
        expect(err.name).to.equal('BootstrapSourceUnhealthyError')
        expect(err.message).to.match(/captured dump carries an xchain-sync halt_pending copy/)
        expect(stubs.fs.rmSync.called).to.equal(true)
        expect(stubs.fs.promises.writeFile.called).to.equal(false)
        expect(stubs.execFile.getCalls().some(call =>
            call.args[0] === 'tar' && (call.args[1] || [])[0] === 'czf')).to.equal(false)
    })

    it('honors the health-gate skip for captured sync_state rows', async function () {
        const { promise, stubs } = startCreate({ skip: true })
        expect(await promise).to.equal(true)
        expect(stubs.fs.promises.writeFile.called).to.equal(true)
        expect(stubs.execFile.getCalls().some(call =>
            call.args[0] === 'tar' && (call.args[1] || [])[0] === 'czf')).to.equal(true)
    })
})
