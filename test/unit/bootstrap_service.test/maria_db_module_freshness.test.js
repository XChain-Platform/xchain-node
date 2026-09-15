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

// uuid:7037604f: ModuleService turns a "fresh" answer into DROP DATABASE +
// restore, so every failure below must answer unknown. Only a SUCCESSFUL read
// may authorise that path.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports unknown when getDatabaseContainerId throws', async function () {
            const stubs = makeStubs()
            stubs.databaseService.getDatabaseContainerId.rejects(new Error('docker error'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('unknown')
        })
    })
})


    // No DB container at all is a real fresh install, and must stay one or
    // first installs stop bootstrapping. Only docker SAYING so counts.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports empty when docker says the database container is gone', async function () {
            const stubs = makeStubs()
            stubs.databaseService.getDatabaseContainerPresence.resolves('gone')
            stubs.databaseService.getDatabaseContainerId.resolves(null)
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('empty')
        })
    })
})


    // The failure this whole block exists for: an inspect that cannot answer
    // must report "unknown", since a null reads as "fresh install".
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports unknown when the container presence probe cannot answer', async function () {
            const stubs = makeStubs()
            stubs.databaseService.getDatabaseContainerPresence.resolves('unknown')
            stubs.databaseService.getDatabaseContainerId.resolves(null)
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('unknown')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports unknown when the container presence probe throws', async function () {
            const stubs = makeStubs()
            stubs.databaseService.getDatabaseContainerPresence.rejects(new Error('daemon unreachable'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('unknown')
        })
    })
})


    // A container docker just confirmed cannot also be an absence: a null id
    // here is an unparseable or failed lookup, never a fresh install.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports unknown when the container exists but its id will not resolve', async function () {
            const stubs = makeStubs()
            stubs.databaseService.getDatabaseContainerPresence.resolves('exists')
            stubs.databaseService.getDatabaseContainerId.resolves(null)
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('unknown')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports unknown when askMariadbRootPassword throws', async function () {
            const stubs = makeStubs()
            stubs.databaseService.askMariadbRootPassword.rejects(new Error('password error'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('unknown')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports empty when the blocks table does not exist (tblOut = 0)', async function () {
            const stubs = makeStubs()
            // First exec → table count = 0
            stubs.execFile = sinon.stub().resolves({ stdout: '0\n' })
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('empty')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports empty when the blocks table exists but has 0 rows', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '1\n' })  // table exists
                return Promise.resolve({ stdout: '0\n' })                        // zero rows
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('empty')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports populated when the blocks table has data', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '1\n' })   // table exists
                return Promise.resolve({ stdout: '1000\n' })                      // rows present
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('populated')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports populated for XCHAIN_INDEXER module', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '1\n' })
                return Promise.resolve({ stdout: '500\n' })
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_INDEXER)
            expect(result).to.equal('populated')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports unknown when exec throws on the table check', async function () {
            const stubs = makeStubs()
            stubs.execFile = sinon.stub().rejects(new Error('mariadb exec error'))
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('unknown')
        })
    })
})


    // A count that does not parse is not a count: NaN is refused as unknown,
    // never reported as the reassuring "fresh".
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('mariaDbModuleFreshness()', function () {
        it('reports unknown when the row count does not parse', async function () {
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile = sinon.stub().callsFake(() => {
                callCount++
                if (callCount === 1) return Promise.resolve({ stdout: '1\n' })   // table exists
                return Promise.resolve({ stdout: 'ERROR 2002 (HY000)\n' })
            })
            const bs = loadBootstrapService(stubs)
            const result = await bs.mariaDbModuleFreshness(COIN, NETWORK, XChainService.XCHAIN_DECODER)
            expect(result).to.equal('unknown')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapUtxoTracker(): file not found', function () {
        it('throws when archive file does not exist', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'missing.tar.gz')
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
    describe('restoreBootstrapUtxoTracker(): resumable reuse (inner archive already matches verified checksum)', function () {
        it('reuses a work-dir inner archive whose bytes match the verified checksum (skips outer extract)', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'

            // Inner archive already on disk; its bytes hash to exactly the
            // checksum the signature-verified outer archive declares, so the
            // outer extract is skipped and the reused bytes are trusted.
            stubVerifiedInner(stubs, { archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256', initiallyPresent: true })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().callsFake(() => {
                setImmediate(() => { drainPassThrough(tarProc.stdin); tarProc.emit('close', 0) })
                return tarProc
            })
            stubs.fs.promises.stat.resolves({ size: 1024, isFile: () => true })

            const bs = loadBootstrapService(stubs)
            const result = await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
            expect(result).to.be.true
            expect(stubs.dockerService.startContainer.called).to.be.true
            // The big outer archive was NOT re-extracted (tar xzf never called).
            const xzfCall = stubs.execFile.getCalls().find(c => c.args[0] === 'tar' && c.args[1][0] === 'xzf')
            expect(xzfCall, 'outer extract should be skipped on a valid reuse').to.be.undefined
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('restoreBootstrapUtxoTracker(): resumable reuse (inner archive already matches verified checksum)', function () {
        it('discards a pre-planted work-dir inner archive that does NOT match the verified checksum, and re-extracts', async function () {
            const stubs = makeStubs()
            const archivePath = '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/data.tar.gz'

            // Adversarial: a malicious inner archive is already on disk (e.g.
            // pre-planted in a shared XCHAIN_NODE_TMP_DIR), but the checksum the
            // signature-verified outer archive declares is for the legit bytes.
            // The reused bytes must be rejected and re-extracted from the archive.
            stubVerifiedInner(stubs, {
                archivePath, innerName: 'data.tar.gz', checksumName: 'data.sha256',
                initiallyPresent: true, innerHashOverride: 'b'.repeat(64),
            })

            stubs.databaseService.ensureDatabasePool.resolves()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            const bs = loadBootstrapService(stubs)
            try {
                await bs.restoreBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER, 'data.tar.gz')
                expect.fail('should not restore an inner archive that fails the verified checksum')
            } catch (err) {
                expect(err.message).to.include('checksum mismatch')
            }
            // It DID try to re-extract from the verified outer archive (not trust the plant).
            const xzfCall = stubs.execFile.getCalls().find(c => c.args[0] === 'tar' && c.args[1][0] === 'xzf')
            expect(xzfCall, 'a mismatched reuse must force a re-extract').to.not.be.undefined
            // And it never started restoring into the volume / touched the container.
            expect(stubs.dockerService.stopContainer.called).to.be.false
        })
    })
})
