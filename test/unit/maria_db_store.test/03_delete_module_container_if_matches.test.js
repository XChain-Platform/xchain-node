'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function buildFakeMariadbModule() {
    const rows = new Map()
    const dispatch = (sql, params = []) => {
        const trimmed = sql.replace(/\s+/g, ' ').trim()
        if (/^CREATE TABLE IF NOT EXISTS modules/i.test(trimmed)) return undefined
        if (/^INSERT INTO modules/i.test(trimmed)) {
            const [module, coin, network, containerId] = params
            rows.set(`${module}|${coin}|${network}`, containerId)
            return undefined
        }
        if (/^SELECT container_id FROM modules WHERE/i.test(trimmed)) {
            const [module, coin, network] = params
            const containerId = rows.get(`${module}|${coin}|${network}`)
            return containerId === undefined ? [] : [{ container_id: containerId }]
        }
        if (/^DELETE FROM modules WHERE/i.test(trimmed)) {
            const [module, coin, network, containerId] = params
            const key = `${module}|${coin}|${network}`
            const matches = rows.get(key) === containerId
            if (matches) rows.delete(key)
            return { affectedRows: matches ? 1 : 0 }
        }
        throw new Error(`buildFakeMariadbModule: unhandled SQL: ${trimmed}`)
    }
    const connection = { query: async (sql, params) => dispatch(sql, params), release: () => {} }
    const pool = {
        getConnection: async () => connection,
        query: async (sql, params) => dispatch(sql, params),
        end: async () => {}
    }
    return { createPool: () => pool }
}

function loadStore() {
    return proxyquire('../../../src/db', { 'mariadb': buildFakeMariadbModule() })
}

describe('MariaDbStore', function () {
    let store

    beforeEach(async function () {
        const MariaDbStore = loadStore()
        store = new MariaDbStore()
        await store.createDatabase({
            host: '127.0.0.1', port: 3306,
            user: 'u', password: 'p', database: 'xchain_node'
        })
    })

    afterEach(async function () {
        await store.close()
    })

    describe('deleteModuleContainerIfMatches()', function () {
        it('deletes only the registry row carrying the inspected container id', async function () {
            await store.setModuleContainer('xchain-encoder', 'bitcoin', 'mainnet', 'new-id')
            const staleResult = await store.deleteModuleContainerIfMatches(
                'xchain-encoder', 'bitcoin', 'mainnet', 'old-id')
            expect(staleResult).to.equal(false)
            expect(await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')).to.equal('new-id')

            const currentResult = await store.deleteModuleContainerIfMatches(
                'xchain-encoder', 'bitcoin', 'mainnet', 'new-id')
            expect(currentResult).to.equal(true)
            expect(await store.getModuleContainer('xchain-encoder', 'bitcoin', 'mainnet')).to.equal(null)
        })

        it('returns false when the pool is not ready', async function () {
            const MariaDbStore = loadStore()
            const bare = new MariaDbStore()
            expect(await bare.deleteModuleContainerIfMatches('xchain-hub', '', '', 'id')).to.equal(false)
        })
    })
})
