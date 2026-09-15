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
    describe('restoreBootstrapMariaDb(): happy path', function () {
        it('drops/recreates DB, restores dump, restarts service container', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'

            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.askMariadbRootPassword.resolves('rootpass')
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves('svc-container-id')

            stubs.fs.promises.stat.resolves({ size: 2048 })

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 0) })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            const result = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
            expect(result).to.be.true
            expect(stubs.dockerService.stopContainer.calledWith('svc-container-id')).to.be.true
            expect(stubs.dockerService.startContainer.calledWith('svc-container-id')).to.be.true

            // The restore client must receive the root password via MYSQL_PWD env, never argv
            const [spawnCmd, spawnArgs, spawnOpts] = stubs.spawn.firstCall.args
            expect(spawnCmd).to.equal('docker')
            expect(spawnArgs).to.include('mariadb')
            expect(spawnArgs).to.include('MYSQL_PWD')
            expect(spawnArgs.some(a => String(a).includes('rootpass'))).to.be.false
            expect(spawnOpts.env.MYSQL_PWD).to.equal('rootpass')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): happy path', function () {
        it('works for XCHAIN_INDEXER (picks INDEXER_BOOTSTRAP_VOLUME)', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-indexer/bootstrap/dump.sql.gz'

            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)  // service not installed yet

            stubs.fs.promises.stat.resolves({ size: 1024 })

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 0) })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            const result = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_INDEXER, 'dump.sql.gz')
            expect(result).to.be.true
            // service container was null → stopContainer should NOT be called for it
            expect(stubs.dockerService.stopContainer.called).to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): happy path', function () {
        it('throws when mariadb restore proc exits non-zero', async function () {
            const stubs = makeStubs()

            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves('svc-container-id')
            stubs.fs.promises.stat.resolves({ size: 512 })

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 2) })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('mariadb restore exited with code 2')
            }
            // service container should still be restarted
            expect(stubs.dockerService.startContainer.calledWith('svc-container-id')).to.be.true
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): happy path', function () {
        it('throws when getDatabaseContainerId returns null', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.databaseService.getDatabaseContainerId.resolves(null)
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('MariaDB container not found')
            }
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): happy path', function () {
        it('throws on malformed mariadb archive (missing dump files)', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
            stubs.fs.existsSync.callsFake(p => {
                if (p === archivePath) return true
                // inner archive + checksum never appear → malformed
                return false
            })
            stubs.execFile = sinon.stub().resolves({ stdout: '' })
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
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
    describe('restoreBootstrapMariaDb(): happy path', function () {
        it('extracts + verifies the mariadb dump against the declared checksum on a fresh run', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'

            // Fresh run: inner dump absent until `tar xzf`, then matches the checksum.
            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: false })
            stubs.fs.promises.stat.resolves({ size: 1024 })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 0) })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            const result = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
            expect(result).to.be.true
            // A fresh run really re-extracted from the verified outer archive.
            const xzfCall = stubs.execFile.getCalls().find(c => c.args[0] === 'tar' && c.args[1][0] === 'xzf')
            expect(xzfCall).to.not.be.undefined
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): happy path', function () {
        it('throws when the mariadb dump fails the declared checksum', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'

            stubVerifiedInner(stubs, {
                archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256',
                initiallyPresent: false, innerHashOverride: 'd'.repeat(64),
            })

            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('checksum mismatch')
            }
        })
    })
})


    // Wire a decoder restore whose inner dump does not match the checksum
    // the (signature-verified) outer archive declares for it.

    function makeCorruptRestore() {
        const stubs = makeStubs()
        const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
        stubVerifiedInner(stubs, {
            archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256',
            initiallyPresent: false, innerHashOverride: 'd'.repeat(64),
        })
        stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
        stubs.databaseService.ensureDatabasePool.resolves()
        stubs.db.getModuleContainer.resolves('svc-container-id')
        stubs.spawn = sinon.stub()
        return stubs
    }

// : integrity refusals are classified, and land BEFORE the DROP.
//
// The destructive restore was first exercised end-to-end on test-host against
// a throwaway MariaDB. Two properties matter and both were only implicit:
//
//   1. A refused archive must not have cost the operator their database.
//      The refusal is raised before DROP DATABASE, so a tampered archive
//      leaves the existing data intact and the operator can retry with a
//      good one. Nothing pinned that ordering, so a future edit that moved
//      the gate below the DROP would still pass every other test here.
//   2. The refusal must be distinguishable from a crash. Uncaught, it
//      printed a Node stack trace, which reads as "the tool broke, retry"
//      when it means "this archive is not trustworthy". The named class is
//      what lets cli.js/menu.js print the reason and exit 1 instead.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): integrity refusal is fail-closed and classified', function () {
        it('never issues DROP DATABASE, and never starts the import, when the archive fails integrity', async function () {
            const stubs = makeCorruptRestore()
            const bs = loadBootstrapService(stubs)

            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                expect.fail('a corrupt archive must be refused')
            } catch (err) {
                expect(err.message).to.include('checksum mismatch')
            }

            // The DROP/CREATE goes out as `docker ... mariadb -e "DROP DATABASE ..."`
            // through execFile; the import is the spawn. Neither may have happened.
            const dropCall = stubs.execFile.getCalls().find(c =>
                JSON.stringify(c.args).includes('DROP DATABASE'))
            expect(dropCall, 'the database must survive a refused restore').to.be.undefined
            expect(stubs.spawn.called, 'no dump may be piped into mariadb').to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): integrity refusal is fail-closed and classified', function () {
        it('does not stop the running service for a restore it is going to refuse', async function () {
            const stubs = makeCorruptRestore()
            const bs = loadBootstrapService(stubs)

            await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz').catch(() => {})

            expect(stubs.dockerService.stopContainer.called,
                'a refused restore must not take the service down').to.be.false
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): integrity refusal is fail-closed and classified', function () {
        it('raises BootstrapIntegrityError so the CLI can report it as a refusal, not a crash', async function () {
            const stubs = makeCorruptRestore()
            const bs = loadBootstrapService(stubs)

            const err = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                .then(() => null, e => e)
            expect(err).to.not.be.null
            expect(err.name).to.equal('BootstrapIntegrityError')
            expect(err).to.be.instanceOf(bs.BootstrapIntegrityError)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): integrity refusal is fail-closed and classified', function () {
        it('classifies a malformed archive (missing inner members) the same way', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
            stubs.fs.existsSync.callsFake(p => p === archivePath)
            stubs.execFile = sinon.stub().resolves({ stdout: '' })

            const bs = loadBootstrapService(stubs)
            const err = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                .then(() => null, e => e)
            expect(err).to.not.be.null
            expect(err.name).to.equal('BootstrapIntegrityError')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapMariaDb(): integrity refusal is fail-closed and classified', function () {
        it('leaves an operational failure unclassified so it is not mistaken for tampering', async function () {
            // A non-zero mariadb exit is a real failure but NOT an integrity
            // refusal: it must keep the generic name, or the CLI would swallow
            // its stack and the operator would go hunting for a bad archive.
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-decoder/bootstrap/dump.sql.gz'
            stubVerifiedInner(stubs, { archivePath, innerName: 'dump.sql.gz', checksumName: 'dump.sha256', initiallyPresent: true })
            stubs.databaseService.getDatabaseContainerId.resolves(FAKE_DB_CONTAINER)
            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(null)
            stubs.fs.promises.stat.resolves({ size: 512 })

            const mysqlProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(mysqlProc.stdin); mysqlProc.emit('close', 2) })
                return mysqlProc
            })

            const bs = loadBootstrapService(stubs)
            const err = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER, 'dump.sql.gz')
                .then(() => null, e => e)
            expect(err).to.not.be.null
            expect(err.name).to.not.equal('BootstrapIntegrityError')
        })
    })
})
