'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    sinon,
    expect,
    XChainService,
    COIN,
    NETWORK,
    FAKE_DB_CONTAINER,
    makeStubs,
    stubVerifiedInner,
    loadBootstrapService
} = require('./helpers/support')

const ARCHIVE_PATH = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'

function makeRestoreStubs() {
    const stubs = makeStubs()
    process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
    stubVerifiedInner(stubs, { archivePath: ARCHIVE_PATH, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
    stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
    stubs.databaseService.askMariadbRootPassword.resolves('rootpass')
    stubs.databaseService.ensureDatabasePool.resolves()
    stubs.fs.promises.stat.resolves({ size: 2048 })
    stubs.spawn = sinon.stub()
    return stubs
}

describe('BootstrapService', function () {
    let savedRequireSigned

    beforeEach(function () { savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP })
    afterEach(function () {
        if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
        else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
    })

    describe('restoreBootstrapMariaDb(): registry lookup', function () {
        it('aborts before touching the database when the registry lookup fails', async function () {
            const stubs = makeRestoreStubs()
            stubs.db.getModuleContainerStrict = sinon.stub().rejects(new Error('registry unavailable'))

            const bs = loadBootstrapService(stubs)
            let error = null
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
            } catch (err) { error = err }

            expect(error, 'restore must reject').to.be.an('error')
            expect(error.message).to.include('registry unavailable')
            expect(stubs.dockerService.stopContainer.called).to.be.false
            expect(stubs.spawn.called).to.be.false
        })

        it('restores without stopping anything when the registry confirms no service row', async function () {
            const stubs = makeRestoreStubs()
            stubs.db.getModuleContainerStrict = sinon.stub().resolves(null)
            stubs.spawn.callsFake(() => { throw new Error('reached restore') })

            const bs = loadBootstrapService(stubs)
            let error = null
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
            } catch (err) { error = err }

            expect(stubs.db.getModuleContainerStrict.calledOnce).to.be.true
            expect(stubs.dockerService.stopContainer.called).to.be.false
            expect(error && error.message).to.not.include('registry')
        })

        it('stops the service container found by the strict lookup', async function () {
            const stubs = makeRestoreStubs()
            stubs.db.getModuleContainerStrict = sinon.stub().resolves('svc-container-id')
            stubs.spawn.callsFake(() => { throw new Error('reached restore') })

            const bs = loadBootstrapService(stubs)
            await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz').catch(() => {})

            expect(stubs.dockerService.stopContainer.calledWith('svc-container-id')).to.be.true
        })
    })
})
