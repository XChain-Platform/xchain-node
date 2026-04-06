'use strict'

const sinon      = require('sinon')
const { expect } = require('chai')
const levelup    = require('levelup')
const memdown    = require('memdown')
const proxyquire = require('proxyquire').noCallThru()

const LevelUpStore = require('../../src/LevelUpDb')

describe('Chaos: LevelDB Resilience', function () {

    let store

    beforeEach(async function () {
        store = new LevelUpStore('test', '')
        store.db = levelup(memdown())
    })

    afterEach(async function () {
        if (store && store.db && store.db.isOpen()) {
            await store.db.close()
        }
        sinon.restore()
    })

    // -------------------------------------------------------------------
    // Experiment 5: LevelDB lock contention (LDB-01)
    // -------------------------------------------------------------------

    describe('Experiment 5: LevelDB lock contention', function () {

        it('handles IO error with lock message by calling _handleLockedDatabase', async function () {
            const testStore = new LevelUpStore('test-lock', '/nonexistent')

            // Stub _openDb to simulate lock error
            sinon.stub(testStore, '_openDb').rejects(
                new Error('IO error: lock /nonexistent/test-lock/LOCK: Resource temporarily unavailable')
            )

            // Stub _handleLockedDatabase since it needs interactive input
            sinon.stub(testStore, '_handleLockedDatabase').resolves(levelup(memdown()))

            await testStore.createDatabase()
            expect(testStore._handleLockedDatabase.calledOnce).to.be.true

            if (testStore.db && testStore.db.isOpen()) await testStore.db.close()
        })

        it('throws descriptive error in non-interactive mode when locked', async function () {
            const testStore = new LevelUpStore('test-lock', '/tmp')

            sinon.stub(testStore, '_openDb').rejects(
                new Error('IO error: lock /tmp/test-lock/LOCK: Resource temporarily unavailable')
            )

            // Simulate non-interactive mode
            const origIsTTY = process.stdin.isTTY
            process.stdin.isTTY = false

            try {
                await testStore.createDatabase()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Database is locked')
                expect(err.message).to.include('non-interactive')
                expect(err.message).to.include('LOCK')
            } finally {
                process.stdin.isTTY = origIsTTY
            }
        })

        it('throws when lock file cannot be removed', async function () {
            const testStore = new LevelUpStore('test-lock', '/tmp')

            sinon.stub(testStore, '_openDb').rejects(
                new Error('IO error: lock /tmp/test-lock/LOCK: Resource temporarily unavailable')
            )

            const origIsTTY = process.stdin.isTTY
            process.stdin.isTTY = true

            // Stub enquirer Confirm to return true (user says yes)
            const LevelUpStoreMocked = proxyquire('../../src/LevelUpDb', {
                'enquirer': {
                    Confirm: class {
                        constructor() {}
                        async run() { return true }
                    }
                },
                'fs': {
                    unlinkSync: sinon.stub().throws(new Error('EPERM: operation not permitted'))
                }
            })

            const mockedStore = new LevelUpStoreMocked('test-lock', '/tmp')
            sinon.stub(mockedStore, '_openDb').rejects(
                new Error('IO error: lock /tmp/test-lock/LOCK: Resource temporarily unavailable')
            )

            try {
                await mockedStore.createDatabase()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include("Couldn't remove the lock file")
            } finally {
                process.stdin.isTTY = origIsTTY
            }
        })

        it('throws generic error for non-lock IO errors', async function () {
            const testStore = new LevelUpStore('test-corrupt', '/nonexistent')

            sinon.stub(testStore, '_openDb').rejects(
                new Error('Corruption: some internal error')
            )

            try {
                await testStore.createDatabase()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include("Couldn't open/create levelup database")
                expect(err.message).to.include('Corruption')
            }
        })
    })

    // -------------------------------------------------------------------
    // Experiment 6: Empty/null container IDs (LDB-03)
    // -------------------------------------------------------------------

    describe('Experiment 6: Empty and null container ID handling', function () {

        it('stores and retrieves an empty string container ID', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'regtest', '')
            const id = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'regtest')
            expect(id).to.equal('')
        })

        it('stores container ID with only whitespace', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'regtest', '   ')
            const id = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'regtest')
            expect(id).to.equal('   ')
        })

        it('getAllModuleContainers includes entries with empty container IDs', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'regtest', '')
            const modules = await store.getAllModuleContainers(null, null)
            expect(modules).to.have.length(1)
            expect(modules[0].container_id).to.equal('')
        })

        it('returns null for key that was never inserted', async function () {
            const id = await store.getModuleContainer('nonexistent', 'bitcoin', 'regtest')
            expect(id).to.be.null
        })

        it('handles get after database is closed', async function () {
            await store.db.close()
            try {
                await store.getModuleContainer('xchain-encoder', 'bitcoin', 'regtest')
                // Should return null from catch block
            } catch {
                // Also acceptable
            }
        })

        it('handles insert after database is closed', async function () {
            await store.db.close()
            const result = await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'regtest', 'id')
            // insertModuleContainer returns false on error
            expect(result).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // Experiment 6b: LevelDB corruption recovery (LDB-02)
    // -------------------------------------------------------------------

    describe('Experiment 6b: Database operation resilience', function () {

        it('remove returns false for non-existent key', async function () {
            const result = await store.removeModuleContainer('nonexistent', 'bitcoin', 'regtest')
            expect(result).to.equal(false)
        })

        it('getAllModuleContainers returns empty array for empty db', async function () {
            const modules = await store.getAllModuleContainers(null, null)
            expect(modules).to.deep.equal([])
        })

        it('handles rapid insert/remove cycles without corruption', async function () {
            for (let i = 0; i < 50; i++) {
                const id = 'container-' + i
                await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'regtest', id)
            }
            const finalId = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'regtest')
            expect(finalId).to.equal('container-49')

            await store.removeModuleContainer('xchain-encoder', 'bitcoin', 'regtest')
            const afterRemove = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'regtest')
            expect(afterRemove).to.be.null
        })

        it('handles concurrent reads and writes without error', async function () {
            // Insert some baseline data
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'regtest', 'enc-id')
            await store.insertModuleContainer('xchain-decoder', 'bitcoin', 'regtest', 'dec-id')

            // Run concurrent operations
            const results = await Promise.all([
                store.getModuleContainer('xchain-encoder', 'bitcoin', 'regtest'),
                store.getModuleContainer('xchain-decoder', 'bitcoin', 'regtest'),
                store.getAllModuleContainers(null, null),
                store.insertModuleContainer('xchain-indexer', 'bitcoin', 'regtest', 'idx-id'),
                store.getModuleContainer('xchain-encoder', 'bitcoin', 'regtest')
            ])

            expect(results[0]).to.equal('enc-id')
            expect(results[1]).to.equal('dec-id')
            expect(results[3]).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // Experiment 14: Multiple keys with same prefix
    // -------------------------------------------------------------------

    describe('Experiment 14: Key collision and boundary checks', function () {

        it('handles keys with special characters in module names', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'regtest', 'id1')
            await store.insertModuleContainer('xchain-encoder-v2', 'bitcoin', 'regtest', 'id2')

            const id1 = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'regtest')
            const id2 = await store.getModuleContainer('xchain-encoder-v2', 'bitcoin', 'regtest')

            expect(id1).to.equal('id1')
            expect(id2).to.equal('id2')
        })

        it('does not return keys outside the MC prefix range', async function () {
            // Manually insert a key outside the MC prefix
            await store.db.put('OTHER_KEY', 'other-value')
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'regtest', 'enc-id')

            const modules = await store.getAllModuleContainers(null, null)
            expect(modules).to.have.length(1)
            expect(modules[0].module).to.equal('xchain-encoder')
        })

        it('handles very long container IDs', async function () {
            const longId = 'f'.repeat(1000)
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'regtest', longId)
            const id = await store.getModuleContainer('xchain-encoder', 'bitcoin', 'regtest')
            expect(id).to.equal(longId)
        })

        it('filters correctly by coin/network when many entries exist', async function () {
            const coins = ['bitcoin', 'dogecoin', 'litecoin']
            const networks = ['mainnet', 'testnet', 'regtest']
            const modules = ['xchain-encoder', 'xchain-decoder', 'xchain-indexer']

            for (const coin of coins) {
                for (const network of networks) {
                    for (const mod of modules) {
                        await store.insertModuleContainer(mod, coin, network, `${mod}-${coin}-${network}`)
                    }
                }
            }

            // Also add shared modules
            await store.insertModuleContainer('xchain-hub', '', '', 'hub-id')

            const btcMainnet = await store.getAllModuleContainers('bitcoin', 'mainnet')
            const btcSpecific = btcMainnet.filter(m => m.coin === 'bitcoin' && m.network === 'mainnet')
            const shared = btcMainnet.filter(m => m.coin === '' && m.network === '')

            expect(btcSpecific).to.have.length(3) // encoder, decoder, indexer
            expect(shared).to.have.length(1)       // hub
            expect(shared[0].container_id).to.equal('hub-id')
        })
    })
})
