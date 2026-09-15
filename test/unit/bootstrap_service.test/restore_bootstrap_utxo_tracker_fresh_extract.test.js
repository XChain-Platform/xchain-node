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
    FAKE_CONTAINER_ID,
    makeSpawnProc,
    drainPassThrough,
    makeStubs,
    stubVerifiedInner,
    loadBootstrapService
} = require('./helpers/support')

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
    describe('restoreBootstrapUtxoTracker(): fresh extract', function () {
        it('extracts outer archive, verifies inner against the declared checksum, restores volume', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'

            // No prior extraction: inner archive absent until `tar xzf` runs, then
            // its bytes hash to the checksum the verified outer archive declares.
            stubVerifiedInner(stubs, { archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256', initiallyPresent: false })
            stubs.fs.promises.stat.resolves({ size: 2048, isFile: () => true })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 0) })
                return tarProc
            })

            const bs = loadBootstrapService(stubs)
            const result = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
            expect(result).to.be.true
            expect(stubs.dockerService.stopContainer.called).to.be.true
            expect(stubs.dockerService.startContainer.called).to.be.true
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapUtxoTracker(): fresh extract', function () {
        it('refuses an outer archive with an unsafe member path (never extracts)', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
            stubs.fs.existsSync.callsFake(p => p === archivePath)

            let extracted = false
            stubs.execFile = sinon.stub().callsFake((cmd, args) => {
                if (cmd === 'tar' && args[0] === 'tzf') {
                    return Promise.resolve({ stdout: 'data.tar.gz\n../escape\n' })
                }
                if (cmd === 'tar' && args[0] === 'xzf') extracted = true
                return Promise.resolve({ stdout: '' })
            })

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('unsafe member path')
            }
            expect(extracted).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapUtxoTracker(): fresh extract', function () {
        it('throws when the inner archive fails the declared checksum (before container stop, no finally restart)', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'

            // Freshly extracted inner archive whose bytes do NOT hash to the
            // checksum the verified outer archive declares (a tampered archive).
            stubVerifiedInner(stubs, {
                archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256',
                initiallyPresent: false, innerHashOverride: 'c'.repeat(64),
            })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('checksum mismatch')
            }
            // Verification fails before the container is stopped; no finally restart.
            expect(stubs.dockerService.stopContainer.called).to.be.false
            expect(stubs.dockerService.startContainer.called).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapUtxoTracker(): fresh extract', function () {
        it('throws when container ID is null (pool not ready)', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256', initiallyPresent: true })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)
            stubs.db.isReady.returns(false)

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('pool is not initialized')
            }
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapUtxoTracker(): fresh extract', function () {
        it('throws when container ID is null but DB pool is ready (no matching row)', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256', initiallyPresent: true })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)
            stubs.db.isReady.returns(true)

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('no matching row')
            }
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapUtxoTracker(): fresh extract', function () {
        it('throws when tar restore proc exits non-zero', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256', initiallyPresent: true })
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.fs.promises.stat.resolves({ size: 512 })

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 1) })
                return tarProc
            })

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('docker tar restore exited with code 1')
                // Post-wipe abort (uuid:7edc76f3): the volume was already cleared,
                // so the error is tagged and the container is NOT restarted. A
                // restart here boots a fresh tracker with halted=false over an
                // incomplete store, which then reports itself caught up.
                expect(err.postWipe).to.be.true
            }
            expect(stubs.dockerService.stopContainer.called).to.be.true
            expect(stubs.dockerService.startContainer.called).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapUtxoTracker(): fresh extract', function () {
        it('throws when malformed archive (inner archive missing after extract)', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'
            let execCalled = false

            stubs.fs.existsSync.callsFake(p => {
                if (p === archivePath) return true
                // Before exec: inner archive and checksum don't exist
                // After exec: still don't exist (malformed archive)
                if (p.includes('data.tar.gz') && p.includes('bootstrap-work')) return false
                if (p.includes('data.sha256')) return false
                if (p.includes('verify.ok')) return false
                return false
            })

            stubs.execFile = sinon.stub().callsFake(() => {
                execCalled = true
                return Promise.resolve({ stdout: '' })
            })

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('malformed')
            }
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): file not found', function () {
        it('throws when archive file does not exist', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'missing.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('Bootstrap file not found')
            }
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): file not found', function () {
        it('throws when archive file does not exist for indexer', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_INDEXER, 'missing.tar.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('Bootstrap file not found')
            }
        })
    })
})
