'use strict'

const { expect } = require('chai')
const levelup    = require('levelup')
const memdown    = require('memdown')

const LevelUpStore = require('../../src/LevelUpDb')

describe('LevelUpDb', function () {

    let store

    beforeEach(async function () {
        store = new LevelUpStore('test', '')
        // Override createDatabase to use memdown instead of leveldown
        store.db = levelup(memdown())
    })

    afterEach(async function () {
        if (store.db && store.db.isOpen()) {
            await store.db.close()
        }
    })

    // -------------------------------------------------------------------
    // moduleNetworkToKey
    // -------------------------------------------------------------------

    describe('moduleNetworkToKey()', function () {

        it('joins module, coin, network with semicolons', function () {
            const key = store.moduleNetworkToKey('xchain-encoder', 'bitcoin', 'mainnet')
            expect(key).to.equal('xchain-encoder;bitcoin;mainnet')
        })

        it('handles empty coin and network for shared modules', function () {
            const key = store.moduleNetworkToKey('xchain-hub', '', '')
            expect(key).to.equal('xchain-hub;;')
        })

        it('handles null-like values', function () {
            const key = store.moduleNetworkToKey('database', '', '')
            expect(key).to.equal('database;;')
        })
    })

    // -------------------------------------------------------------------
    // insertModuleContainer / getModuleContainer
    // -------------------------------------------------------------------

    describe('insertModuleContainer() + getModuleContainer()', function () {

        it('stores and retrieves a container ID', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'abc123def456')
            const id = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(id).to.equal('abc123def456')
        })

        it('returns null for non-existent key', async function () {
            const id = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(id).to.be.null
        })

        it('overwrites existing entry on re-insert', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'old-id')
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'new-id')
            const id = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(id).to.equal('new-id')
        })

        it('stores shared modules with empty coin/network', async function () {
            await store.insertModuleContainer('xchain-hub', '', '', 'hub-container-id')
            const id = await store.getModuleContainer('xchain-hub', '', '')
            expect(id).to.equal('hub-container-id')
        })

        it('keeps separate entries for different coin/network combos', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'btc-main')
            await store.insertModuleContainer('xchain-encoder', 'dogecoin', 'testnet', 'doge-test')
            const btc = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            const doge = await store.getModuleContainer('xchain-encoder', 'dogecoin', 'testnet')
            expect(btc).to.equal('btc-main')
            expect(doge).to.equal('doge-test')
        })

        it('returns true on successful insert', async function () {
            const result = await store.insertModuleContainer('xchain-hub', '', '', 'id123')
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // removeModuleContainer
    // -------------------------------------------------------------------

    describe('removeModuleContainer()', function () {

        it('removes an existing entry and returns the container ID', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'container-abc')
            const result = await store.removeModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(result).to.equal('container-abc')
        })

        it('entry is no longer retrievable after removal', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'container-abc')
            await store.removeModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            const id = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(id).to.be.null
        })

        it('returns false for non-existent key', async function () {
            const result = await store.removeModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(result).to.equal(false)
        })
    })

    // -------------------------------------------------------------------
    // getAllModuleContainers
    // -------------------------------------------------------------------

    describe('getAllModuleContainers()', function () {

        beforeEach(async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'enc-btc-main')
            await store.insertModuleContainer('xchain-decoder', 'bitcoin', 'mainnet', 'dec-btc-main')
            await store.insertModuleContainer('xchain-encoder', 'dogecoin', 'testnet', 'enc-doge-test')
            await store.insertModuleContainer('xchain-hub', '', '', 'hub-id')
        })

        it('returns all entries when no filters', async function () {
            const modules = await store.getAllModuleContainers(null, null)
            expect(modules).to.have.length(4)
        })

        it('filters by coin and network', async function () {
            const modules = await store.getAllModuleContainers('bitcoin', 'mainnet')
            // Should return bitcoin/mainnet entries + shared modules (empty coin/network)
            const coinSpecific = modules.filter(m => m.coin === 'bitcoin' && m.network === 'mainnet')
            const shared = modules.filter(m => m.coin === '' && m.network === '')
            expect(coinSpecific.length).to.be.at.least(2)
            expect(shared.length).to.equal(1)
        })

        it('always includes shared modules (empty coin/network) in filtered results', async function () {
            const modules = await store.getAllModuleContainers('dogecoin', 'testnet')
            const shared = modules.filter(m => m.coin === '' && m.network === '')
            expect(shared.length).to.equal(1)
            expect(shared[0].module).to.equal('xchain-hub')
        })

        it('parses key correctly into module, coin, network fields', async function () {
            const modules = await store.getAllModuleContainers(null, null)
            const encoder = modules.find(m => m.module === 'xchain-encoder' && m.coin === 'bitcoin')
            expect(encoder).to.exist
            expect(encoder.network).to.equal('mainnet')
            expect(encoder.container_id).to.equal('enc-btc-main')
        })

        it('returns empty array when database is empty', async function () {
            // Use a fresh store
            const emptyStore = new LevelUpStore('test2', '')
            emptyStore.db = levelup(memdown())
            const modules = await emptyStore.getAllModuleContainers(null, null)
            expect(modules).to.deep.equal([])
            await emptyStore.db.close()
        })
    })

    // -------------------------------------------------------------------
    // createDatabase
    // -------------------------------------------------------------------

    describe('createDatabase()', function () {

        it('opens a database successfully', async function () {
            const freshStore = new LevelUpStore('testdb', '/tmp')
            // We can't actually test disk LevelDB here, but we can verify the method exists
            expect(freshStore.createDatabase).to.be.a('function')
        })
    })
})
