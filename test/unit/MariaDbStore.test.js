'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

/**
 * Minimal in-memory SQL fake covering the queries MariaDbStore issues.
 * Lets us exercise the real MariaDbStore logic without a live MariaDB.
 */
function buildFakeMariadbModule() {
    const rows = new Map()  // key: `${module}|${coin}|${network}` → { module, coin, network, container_id }

    function dispatch(sql, params = []) {
        const trimmed = sql.replace(/\s+/g, ' ').trim()

        if (/^CREATE TABLE IF NOT EXISTS modules/i.test(trimmed)) {
            return undefined
        }

        if (/^SELECT COUNT\(\*\) AS cnt FROM modules/i.test(trimmed)) {
            return [{ cnt: rows.size }]
        }

        if (/^SELECT module, coin, network, container_id FROM modules$/i.test(trimmed)) {
            return Array.from(rows.values()).map(r => ({ ...r }))
        }

        if (/^SELECT module, coin, network, container_id FROM modules WHERE/i.test(trimmed)) {
            const [coin, network] = params
            const out = []
            for (const r of rows.values()) {
                if ((r.coin === coin && r.network === network) || (r.coin === '' && r.network === '')) {
                    out.push({ ...r })
                }
            }
            return out
        }

        if (/^SELECT container_id FROM modules WHERE/i.test(trimmed)) {
            const [module, coin, network] = params
            const r = rows.get(`${module}|${coin}|${network}`)
            return r ? [{ container_id: r.container_id }] : []
        }

        if (/^INSERT INTO modules/i.test(trimmed)) {
            const [module, coin, network, container_id] = params
            rows.set(`${module}|${coin}|${network}`, { module, coin, network, container_id })
            return undefined
        }

        if (/^DELETE FROM modules WHERE/i.test(trimmed)) {
            const [module, coin, network] = params
            rows.delete(`${module}|${coin}|${network}`)
            return undefined
        }

        throw new Error(`buildFakeMariadbModule: unhandled SQL: ${trimmed}`)
    }

    const fakeConn = {
        query: async (sql, params) => dispatch(sql, params),
        release: () => {}
    }

    const fakePool = {
        getConnection: async () => fakeConn,
        query: async (sql, params) => dispatch(sql, params),
        end: async () => {}
    }

    return {
        module: { createPool: () => fakePool },
        rows
    }
}

function loadStore() {
    const fake = buildFakeMariadbModule()
    const MariaDbStore = proxyquire('../../src/MariaDbStore', { 'mariadb': fake.module })
    return { MariaDbStore, rows: fake.rows }
}

describe('MariaDbStore', function () {

    let store
    let rows

    const config = {
        host: '127.0.0.1', port: 3306,
        user: 'u', password: 'p', database: 'xchain_node'
    }

    beforeEach(async function () {
        const ctx = loadStore()
        store = new ctx.MariaDbStore()
        rows = ctx.rows
        await store.createDatabase(config)
    })

    afterEach(async function () {
        await store.close()
    })

    describe('createDatabase() / isReady() / close()', function () {

        it('opens the pool and reports ready', function () {
            expect(store.isReady()).to.be.true
        })

        it('reports not ready before createDatabase', function () {
            const { MariaDbStore } = loadStore()
            const fresh = new MariaDbStore()
            expect(fresh.isReady()).to.be.false
        })

        it('reports not ready after close', async function () {
            await store.close()
            expect(store.isReady()).to.be.false
        })

        it('throws when createDatabase is called without config', async function () {
            const { MariaDbStore } = loadStore()
            const bare = new MariaDbStore()
            try {
                await bare.createDatabase()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.match(/needs config/)
            }
        })

        it('is idempotent: second createDatabase returns the existing pool', async function () {
            const first  = await store.createDatabase()
            const second = await store.createDatabase()
            expect(second).to.equal(first)
        })
    })

    describe('createDatabase() connection retry', function () {

        const config = {
            host: '127.0.0.1', port: 3306,
            user: 'u', password: 'p', database: 'xchain_node'
        }

        // Load a store whose pool.getConnection() rejects `failCount` times
        // before succeeding, with helpers.sleep swapped for a counter so the
        // 2s backoff between attempts costs no real wall-clock time.
        function loadStoreWithFlakyConnect(failCount) {
            let attempts = 0
            let sleepCalls = 0
            const fakeConn = { query: async () => undefined, release: () => {} }
            const fakePool = {
                getConnection: async () => {
                    attempts++
                    if (attempts <= failCount) throw new Error('ECONNREFUSED')
                    return fakeConn
                },
                query: async () => undefined,
                end: async () => {}
            }
            const MariaDbStore = proxyquire('../../src/MariaDbStore', {
                'mariadb': { createPool: () => fakePool },
                './utils/helpers': { sleep: async () => { sleepCalls++ } }
            })
            return { MariaDbStore, getAttempts: () => attempts, getSleepCalls: () => sleepCalls }
        }

        it('retries and succeeds after transient connection failures', async function () {
            const { MariaDbStore, getAttempts, getSleepCalls } = loadStoreWithFlakyConnect(2)
            const store = new MariaDbStore()
            await store.createDatabase(config)
            expect(store.isReady()).to.be.true
            expect(getAttempts()).to.equal(3)     // 2 failed + 1 successful
            expect(getSleepCalls()).to.equal(2)   // one backoff per failure
            await store.close()
        })

        it('throws after 6 failed connection attempts', async function () {
            const { MariaDbStore, getAttempts, getSleepCalls } = loadStoreWithFlakyConnect(99)
            const store = new MariaDbStore()
            try {
                await store.createDatabase(config)
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.match(/Couldn't open\/create MariaDB database/)
            }
            expect(getAttempts()).to.equal(6)     // loop caps at 6 attempts
            expect(getSleepCalls()).to.equal(6)   // backoff after each failure
            await store.close()
        })
    })

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
            await store.insertModuleContainer('xchain-encoder', 'bitcoin',  'mainnet', 'btc-main')
            await store.insertModuleContainer('xchain-encoder', 'dogecoin', 'testnet', 'doge-test')
            const btc  = await store.getModuleContainer('xchain-encoder', 'bitcoin',  'mainnet')
            const doge = await store.getModuleContainer('xchain-encoder', 'dogecoin', 'testnet')
            expect(btc).to.equal('btc-main')
            expect(doge).to.equal('doge-test')
        })

        it('returns true on successful insert', async function () {
            const result = await store.insertModuleContainer('xchain-hub', '', '', 'id123')
            expect(result).to.be.true
        })

        it('insert is a no-op (returns false) when pool is not ready', async function () {
            const { MariaDbStore } = loadStore()
            const bare = new MariaDbStore()
            const result = await bare.insertModuleContainer('xchain-hub', '', '', 'id123')
            expect(result).to.be.false
        })

        it('get returns null when pool is not ready', async function () {
            const { MariaDbStore } = loadStore()
            const bare = new MariaDbStore()
            const id = await bare.getModuleContainer('xchain-hub', '', '')
            expect(id).to.be.null
        })

        it('coerces null coin/network to empty string for keying', async function () {
            await store.insertModuleContainer('xchain-hub', null, null, 'hub-id')
            const id = await store.getModuleContainer('xchain-hub', '', '')
            expect(id).to.equal('hub-id')
        })
    })

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

        it('returns true for non-existent key (idempotent delete)', async function () {
            const result = await store.removeModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            expect(result).to.equal(true)
        })

        it('does not affect other entries', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin',  'mainnet', 'btc-main')
            await store.insertModuleContainer('xchain-encoder', 'dogecoin', 'testnet', 'doge-test')
            await store.removeModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')
            const doge = await store.getModuleContainer('xchain-encoder', 'dogecoin', 'testnet')
            expect(doge).to.equal('doge-test')
        })

        it('returns false when pool is not ready', async function () {
            const { MariaDbStore } = loadStore()
            const bare = new MariaDbStore()
            const result = await bare.removeModuleContainer('xchain-hub', '', '')
            expect(result).to.be.false
        })
    })

    describe('getAllModuleContainers()', function () {

        beforeEach(async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin',  'mainnet', 'enc-btc-main')
            await store.insertModuleContainer('xchain-decoder', 'bitcoin',  'mainnet', 'dec-btc-main')
            await store.insertModuleContainer('xchain-encoder', 'dogecoin', 'testnet', 'enc-doge-test')
            await store.insertModuleContainer('xchain-hub',     '',         '',        'hub-id')
        })

        it('returns all entries when no filters', async function () {
            const modules = await store.getAllModuleContainers(null, null)
            expect(modules).to.have.length(4)
        })

        it('filters by coin and network and includes shared modules', async function () {
            const modules = await store.getAllModuleContainers('bitcoin', 'mainnet')
            const coinSpecific = modules.filter(m => m.coin === 'bitcoin' && m.network === 'mainnet')
            const shared       = modules.filter(m => m.coin === '' && m.network === '')
            expect(coinSpecific.length).to.equal(2)
            expect(shared.length).to.equal(1)
        })

        it('always includes shared modules in filtered results', async function () {
            const modules = await store.getAllModuleContainers('dogecoin', 'testnet')
            const shared = modules.filter(m => m.coin === '' && m.network === '')
            expect(shared.length).to.equal(1)
            expect(shared[0].module).to.equal('xchain-hub')
        })

        it('returns rows shaped as { module, coin, network, container_id }', async function () {
            const modules = await store.getAllModuleContainers(null, null)
            const encoder = modules.find(m => m.module === 'xchain-encoder' && m.coin === 'bitcoin')
            expect(encoder).to.exist
            expect(encoder.network).to.equal('mainnet')
            expect(encoder.container_id).to.equal('enc-btc-main')
        })

        it('returns empty array when no rows', async function () {
            const { MariaDbStore } = loadStore()
            const empty = new MariaDbStore()
            await empty.createDatabase(config)
            const modules = await empty.getAllModuleContainers(null, null)
            expect(modules).to.deep.equal([])
            await empty.close()
        })

        it('returns empty array when pool is not ready', async function () {
            const { MariaDbStore } = loadStore()
            const bare = new MariaDbStore()
            const modules = await bare.getAllModuleContainers(null, null)
            expect(modules).to.deep.equal([])
        })
    })

    // The empty array above is why a probe against an uninitialized
    // singleton read as "the node lost track of its whole stack". Reads can live
    // with it; callers that ACT on the row set need a distinguishable signal.
    describe('assertReady()', function () {

        it('throws on an unconfigured store, naming the operation', function () {
            const { MariaDbStore } = loadStore()
            const bare = new MariaDbStore()
            expect(() => bare.assertReady('autoheal')).to.throw(/not connected.*autoheal/)
        })

        it('passes once the pool is open', function () {
            expect(() => store.assertReady('module discovery')).to.not.throw()
        })
    })

    describe('countModules()', function () {

        it('returns 0 when no rows', async function () {
            const count = await store.countModules()
            expect(count).to.equal(0)
        })

        it('returns the number of registered modules', async function () {
            await store.insertModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'a')
            await store.insertModuleContainer('xchain-decoder', 'bitcoin', 'mainnet', 'b')
            await store.insertModuleContainer('xchain-hub',     '',        '',        'c')
            const count = await store.countModules()
            expect(count).to.equal(3)
        })

        it('returns 0 when pool is not ready', async function () {
            const { MariaDbStore } = loadStore()
            const bare = new MariaDbStore()
            const count = await bare.countModules()
            expect(count).to.equal(0)
        })
    })
})

/*
 * The registry is per STACK, not per host.
 *
 * In external-DB mode two co-located stacks (distinct NODE_PREFIX) point at one
 * host-native MariaDB and share the xchain_node database. The row key
 * (module, coin, network) is identical on both, so an unscoped table let each
 * stack's upsert overwrite the other's container_id and let DiscoveryService's
 * orphan purge - which classifies containers by its own prefix - delete the
 * other stack's live rows. The table name carries the stack identity instead.
 */
describe('MariaDbStore registry scoping by NODE_PREFIX', function () {

    function loadWithPrefix(prefix) {
        const statements = []
        const record = async (sql) => {
            statements.push(String(sql).replace(/\s+/g, ' ').trim())
            return [{ cnt: 0 }]
        }
        const pool = {
            getConnection: async () => ({ query: record, release: () => {} }),
            query: record,
            end: async () => {}
        }
        const constants = require('../../src/config/constants')
        const MariaDbStore = proxyquire('../../src/MariaDbStore', {
            'mariadb': { createPool: () => pool },
            './config/constants': Object.assign({}, constants, { NODE_PREFIX: prefix })
        })
        return { MariaDbStore, statements }
    }

    async function statementsFor(prefix) {
        const { MariaDbStore, statements } = loadWithPrefix(prefix)
        const store = new MariaDbStore()
        await store.createDatabase({ host: '127.0.0.1', port: 3306, user: 'u', password: 'p', database: 'xchain_node' })
        await store.insertModuleContainer('xchain-indexer', 'bitcoin', 'mainnet', 'aaa')
        await store.getModuleContainer('xchain-indexer', 'bitcoin', 'mainnet')
        await store.getAllModuleContainers(null, null)
        await store.getAllModuleContainers('bitcoin', 'mainnet')
        await store.removeModuleContainer('xchain-indexer', 'bitcoin', 'mainnet')
        await store.countModules()
        await store.close()
        return statements
    }

    it('keeps the bare `modules` table on the default prefix, so an existing install migrates nothing', async function () {
        const statements = await statementsFor('xchain-node')
        expect(statements.length).to.be.greaterThan(5)
        for (const sql of statements) expect(sql, sql).to.not.match(/\bmodules_/)
        expect(statements[0]).to.match(/^CREATE TABLE IF NOT EXISTS modules \(/)
    })

    it('gives a second stack its own table, so neither upsert nor purge can reach the first', async function () {
        const statements = await statementsFor('stack-b')
        expect(statements.length).to.be.greaterThan(5)
        // Every statement, DDL and DML alike: one missed site is a cross-stack write.
        for (const sql of statements) {
            expect(sql, sql).to.match(/\bmodules_stack_b\b/)
            expect(sql.replace(/modules_stack_b/g, ''), sql).to.not.match(/\bmodules\b/)
        }
    })

    it('sanitizes a prefix that is legal for docker but not for a MariaDB identifier', async function () {
        const statements = await statementsFor('node.1-alt')
        for (const sql of statements) expect(sql, sql).to.match(/\bmodules_node_1_alt\b/)
    })
})
