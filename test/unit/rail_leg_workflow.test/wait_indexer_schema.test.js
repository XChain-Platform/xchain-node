'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')
const path = require('path')

const HELPER = path.join(__dirname, '../../../.github/attest-mirror/wait-indexer-schema.js')
const ready = require(HELPER)

function response (body, ok) {
    return { ok: ok !== false, json: async () => body }
}

function config (overrides) {
    return Object.assign({
        statusUrl: 'http://127.0.0.1:1/status',
        fetchImpl: async () => response({ schemaReady: true }),
        dbOptions: { host: '127.0.0.1', port: 2, user: 'root', password: 'secret' },
        connect: async () => ({ query: async () => [{ n: 1 }], end: async () => {} }),
        waitMs: 10,
        intervalMs: 0,
        now: Date.now,
        sleep: async () => {},
    }, overrides || {})
}

describe('attest-mirror wait-indexer-schema.js', function () {
    it('trusts schemaReady true without opening a database connection', async function () {
        let connected = false
        const value = await ready.schemaReady(config({ connect: async () => { connected = true } }))
        expect(value).to.equal(true)
        expect(connected).to.equal(false)
    })

    it('waits on schemaReady false even when the issues table exists', async function () {
        let connected = false
        const value = await ready.schemaReady(config({
            fetchImpl: async () => response({ schemaReady: false }),
            connect: async () => { connected = true; return { query: async () => [{ n: 1 }] } },
        }))
        expect(value).to.equal(false)
        expect(connected).to.equal(false)
    })

    it('uses the issues table for an older status response without schemaReady', async function () {
        let query = ''
        let ended = false
        const value = await ready.schemaReady(config({
            fetchImpl: async () => response({ isSynced: false }),
            connect: async () => ({
                query: async (sql) => { query = sql; return [{ n: 1 }] },
                end: async () => { ended = true },
            }),
        }))
        expect(value).to.equal(true)
        expect(query).to.include("table_schema = '" + ready.DATABASE + "'")
        expect(query).to.include("table_name = '" + ready.TABLE + "'")
        expect(ended).to.equal(true)
    })

    it('does not use the fallback when status is unavailable or malformed', async function () {
        let connections = 0
        const connect = async () => { connections++; return { query: async () => [{ n: 1 }] } }
        expect(await ready.schemaReady(config({ fetchImpl: async () => response({}, false), connect }))).to.equal(false)
        const invalidJson = async () => ({ ok: true, json: async () => { throw new Error('bad json') } })
        expect(await ready.schemaReady(config({ fetchImpl: invalidJson, connect }))).to.equal(false)
        expect(connections).to.equal(0)
    })

    it('polls until schemaReady changes from false to true', async function () {
        let polls = 0
        let sleeps = 0
        const value = await ready.waitForSchema(config({
            fetchImpl: async () => response({ schemaReady: ++polls > 1 }),
            sleep: async () => { sleeps++ },
        }))
        expect(value).to.equal(true)
        expect(polls).to.equal(2)
        expect(sleeps).to.equal(1)
    })

    it('closes a fallback connection when the issues-table query fails', async function () {
        let ended = false
        const value = await ready.schemaReady(config({
            fetchImpl: async () => response({}),
            connect: async () => ({
                query: async () => { throw new Error('query failed') },
                end: async () => { ended = true },
            }),
        }))
        expect(value).to.equal(false)
        expect(ended).to.equal(true)
    })
})
