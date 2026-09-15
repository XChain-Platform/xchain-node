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

function buildFakeMariadbModule() {
    const rows = new Map()

    function dispatch(sql, params = []) {
        const trimmed = sql.replace(/\s+/g, ' ').trim()

        if (/^CREATE TABLE IF NOT EXISTS modules/i.test(trimmed)) return undefined
        if (/^SELECT COUNT\(\*\) AS cnt FROM modules/i.test(trimmed)) return [{ cnt: rows.size }]
        if (/^INSERT INTO modules/i.test(trimmed)) {
            const [module, coin, network, container_id] = params
            rows.set(`${module}|${coin}|${network}`, { module, coin, network, container_id })
            return undefined
        }
        throw new Error(`buildFakeMariadbModule: unhandled SQL: ${trimmed}`)
    }

    const fakeConn = { query: async (sql, params) => dispatch(sql, params), release: () => {} }
    const fakePool = {
        getConnection: async () => fakeConn,
        query: async (sql, params) => dispatch(sql, params),
        end: async () => {}
    }
    return { module: { createPool: () => fakePool }, rows }
}

function loadStore() {
    const fake = buildFakeMariadbModule()
    const MariaDbStore = proxyquire('../../../src/db', { 'mariadb': fake.module })
    return { MariaDbStore, rows: fake.rows }
}

describe('MariaDbStore', function () {
    let store

    beforeEach(async function () {
        const ctx = loadStore()
        store = new ctx.MariaDbStore()
        await store.createDatabase({
            host: '127.0.0.1', port: 3306,
            user: 'u', password: 'p', database: 'xchain_node'
        })
    })

    afterEach(async function () {
        await store.close()
    })

    describe('getModuleCount()', function () {

        it('returns 0 when no rows', async function () {
            const count = await store.getModuleCount()
            expect(count).to.equal(0)
        })

        it('returns the number of registered modules', async function () {
            await store.setModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'a')
            await store.setModuleContainer('xchain-decoder', 'bitcoin', 'mainnet', 'b')
            await store.setModuleContainer('xchain-hub',     '',        '',        'c')
            const count = await store.getModuleCount()
            expect(count).to.equal(3)
        })

        it('returns 0 when pool is not ready', async function () {
            const { MariaDbStore } = loadStore()
            const bare = new MariaDbStore()
            const count = await bare.getModuleCount()
            expect(count).to.equal(0)
        })
    })
})
