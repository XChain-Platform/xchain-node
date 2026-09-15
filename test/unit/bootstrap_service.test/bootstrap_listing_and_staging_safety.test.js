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
    makeStubs,
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
    describe('bootstrap listing and staging safety', function () {
        it('lists archives NEWEST first, so "the latest" is the head of the list', async function () {
            // The list came back in raw readdir order, so a driver taking [0]
            // restored the OLDEST archive.
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['old.tar.gz', 'newest.tar.gz', 'middle.tar.gz'])
            stubs.fs.promises.stat
                .onCall(0).resolves({ isFile: () => true, mtimeMs: 100 })
                .onCall(1).resolves({ isFile: () => true, mtimeMs: 900 })
                .onCall(2).resolves({ isFile: () => true, mtimeMs: 500 })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(list).to.deep.equal(['newest.tar.gz', 'middle.tar.gz', 'old.tar.gz'])
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap listing and staging safety', function () {
        it('orders deterministically when mtimes tie or are unavailable', async function () {
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves(['a-2026-06-04.tar.gz', 'b-2026-07-24.tar.gz'])
            stubs.fs.promises.stat.resolves({ isFile: () => true })   // no mtimeMs at all
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(list).to.have.length(2)
            expect(list[0]).to.equal('b-2026-07-24.tar.gz')
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap listing and staging safety', function () {
        it('excludes the .sig and .sha256 sidecars from the restorable list', async function () {
            // Otherwise the menu offers a signature file as something to restore.
            const stubs = makeStubs()
            stubs.fs.promises.readdir.resolves([
                'boot.tar.gz', 'boot.tar.gz.sig', 'boot.sha256', 'notes.txt',
            ])
            stubs.fs.promises.stat.resolves({ isFile: () => true, mtimeMs: 1 })
            const bs = loadBootstrapService(stubs)
            const list = await bs.getBootstrapFilesList(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(list).to.deep.equal(['boot.tar.gz'])
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap listing and staging safety', function () {
        it('refuses to stage a bootstrap the work-dir filesystem cannot hold', async function () {
            // Staging 30G under <repo>/tmp filled the host's root filesystem.
            const stubs = makeStubs()
            stubs.execFile.resolves({ stdout: '32212254720\t/data' })   // 30G volume
            stubs.fs.statfsSync = sinon.stub().returns({ bavail: 1000, bsize: 4096 })  // ~4MB free
            const bs = loadBootstrapService(stubs)

            let err = null
            try {
                await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            } catch (e) { err = e }

            expect(err, 'a full work-dir filesystem must be refused').to.not.equal(null)
            expect(err.message).to.match(/Not enough space/)
            expect(err.message).to.match(/XCHAIN_NODE_TMP_DIR/)
            expect(err.message).to.match(/staging/)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap listing and staging safety', function () {
        it('refuses BEFORE stopping the container, so a capacity failure costs no downtime', async function () {
            const stubs = makeStubs()
            stubs.execFile.resolves({ stdout: '32212254720\t/data' })
            stubs.fs.statfsSync = sinon.stub().returns({ bavail: 1000, bsize: 4096 })
            const bs = loadBootstrapService(stubs)

            try { await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER) } catch { /* expected */ }

            sinon.assert.notCalled(stubs.dockerService.stopContainer)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap listing and staging safety', function () {
        it('also refuses when only the OUTPUT filesystem is too small', async function () {
            // The finished archive lands in the bootstrap output dir, which on a
            // default install is <install>/data, i.e. root as well. Guarding only
            // the staging dir would have left the outage half-fixed.
            const stubs = makeStubs()
            stubs.execFile.resolves({ stdout: '32212254720\t/data' })
            stubs.fs.statfsSync = sinon.stub()
            stubs.fs.statfsSync.onFirstCall().returns({ bavail: 20 * 1024 * 1024, bsize: 4096 })  // staging: ~80G, fine
            stubs.fs.statfsSync.returns({ bavail: 1000, bsize: 4096 })                            // output: ~4MB
            const bs = loadBootstrapService(stubs)

            let err = null
            try { await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER) } catch (e) { err = e }

            expect(err, 'a full output filesystem must be refused too').to.not.equal(null)
            expect(err.message).to.match(/Not enough space/)
            expect(err.message).to.match(/published archives/)
            sinon.assert.notCalled(stubs.dockerService.stopContainer)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('bootstrap listing and staging safety', function () {
        it('proceeds when the filesystem has room for the data plus the reserve', async function () {
            const stubs = makeStubs()
            stubs.execFile.resolves({ stdout: '1024\t/data' })         // tiny volume
            stubs.fs.statfsSync = sinon.stub().returns({ bavail: 10 * 1024 * 1024, bsize: 4096 })  // ~40G free
            const bs = loadBootstrapService(stubs)

            let err = null
            try { await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER) } catch (e) { err = e }

            // It may still fail further down the (heavily stubbed) pipeline, but
            // never on capacity, and the container stop must have been reached.
            if (err) expect(err.message).to.not.match(/Not enough space/)
            sinon.assert.called(stubs.dockerService.stopContainer)
        })
    })
})

    function loadWithRows(rows) {
        const stubs = makeStubs()
        stubs.db.getAllModuleContainers = sinon.stub().resolves(rows)
        return { stubs, bs: loadBootstrapService(stubs) }
    }


    // The whole point of reading the registry: a stopped combo keeps its row,
    // so it enters the plan and reaches the source-health gate instead of
    // being dropped by a `docker ps` that only sees running containers.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('listServedBootstrapCombos()', function () {
        it('lists a combo whose container is stopped', async function () {
            const { stubs, bs } = loadWithRows([
                { module: XChainService.XCHAIN_DECODER, coin: 'litecoin', network: 'mainnet', container_id: null },
                { module: XChainService.XCHAIN_INDEXER, coin: 'litecoin', network: 'mainnet', container_id: 'x' }
            ])
            const combos = await bs.listServedBootstrapCombos()
            expect(combos).to.deep.equal([
                'xchain-decoder:litecoin:mainnet',
                'xchain-indexer:litecoin:mainnet'
            ])
            sinon.assert.calledWith(stubs.db.getAllModuleContainers, null, null)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('listServedBootstrapCombos()', function () {
        it('filters regtest and non-bootstrappable modules', async function () {
            const { bs } = loadWithRows([
                { module: XChainService.XCHAIN_DECODER, coin: 'bitcoin',  network: 'regtest', container_id: 'a' },
                { module: 'xchain-hub',                 coin: '',         network: '',        container_id: 'b' },
                { module: 'node',                       coin: 'bitcoin',  network: 'mainnet', container_id: 'c' },
                { module: XChainService.XCHAIN_UTXO_TRACKER, coin: 'bitcoin', network: 'mainnet', container_id: 'd' }
            ])
            expect(await bs.listServedBootstrapCombos())
                .to.deep.equal(['xchain-utxo-tracker:bitcoin:mainnet'])
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('listServedBootstrapCombos()', function () {
        it('de-duplicates and sorts', async function () {
            const { bs } = loadWithRows([
                { module: XChainService.XCHAIN_INDEXER, coin: 'litecoin', network: 'mainnet', container_id: 'a' },
                { module: XChainService.XCHAIN_DECODER, coin: 'bitcoin',  network: 'mainnet', container_id: 'b' },
                { module: XChainService.XCHAIN_INDEXER, coin: 'litecoin', network: 'mainnet', container_id: 'c' }
            ])
            expect(await bs.listServedBootstrapCombos()).to.deep.equal([
                'xchain-decoder:bitcoin:mainnet',
                'xchain-indexer:litecoin:mainnet'
            ])
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('listServedBootstrapCombos()', function () {
        it('returns nothing for an empty or unconfigured store', async function () {
            expect(await loadWithRows([]).bs.listServedBootstrapCombos()).to.deep.equal([])
        })
    })
})
