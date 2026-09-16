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

const { sinon, expect, VALID_CONTAINER_ID, fakeSpawn, mariadbAttempts, makeStubs, loadDatabaseService } = require('./helpers/harness')

describe('DatabaseService', function () {

        describe('buildDatabaseModule(): EXTERNAL_DB path', function () {

        it('pings external MariaDB and returns true when reachable', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([])
            const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true, EXTERNAL_DB_HOST: '127.0.0.1', EXTERNAL_DB_PORT: 3306, EXTERNAL_DB_ROOT_USER: 'root' })

            // getExternalDbConfig will use env vars
            const saved = {
                XCHAIN_NODE_EXTERNAL_DB_HOST:          process.env.XCHAIN_NODE_EXTERNAL_DB_HOST,
                XCHAIN_NODE_EXTERNAL_DB_PORT:          process.env.XCHAIN_NODE_EXTERNAL_DB_PORT,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_USER:     process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD
            }
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = '127.0.0.1'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = '3306'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'root'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'test-pass'
            try {
                const result = await ds.buildDatabaseModule('bitcoin', 'mainnet')
                expect(result).to.be.true
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })

        it('throws descriptive error when external MariaDB is unreachable', async function () {
            const stubs = makeStubs()
            stubs.mariadb.createConnection.rejects(new Error('ECONNREFUSED'))
            const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true, EXTERNAL_DB_HOST: 'bad-host', EXTERNAL_DB_PORT: 3306, EXTERNAL_DB_ROOT_USER: 'root' })

            const saved = {
                XCHAIN_NODE_EXTERNAL_DB_HOST:          process.env.XCHAIN_NODE_EXTERNAL_DB_HOST,
                XCHAIN_NODE_EXTERNAL_DB_PORT:          process.env.XCHAIN_NODE_EXTERNAL_DB_PORT,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_USER:     process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER,
                XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD
            }
            process.env.XCHAIN_NODE_EXTERNAL_DB_HOST          = 'bad-host'
            process.env.XCHAIN_NODE_EXTERNAL_DB_PORT          = '3306'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_USER     = 'root'
            process.env.XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD = 'test-pass'
            try {
                await ds.buildDatabaseModule('bitcoin', 'mainnet')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('Cannot reach external MariaDB')
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]
                    else process.env[k] = v
                }
            }
        })
        })
})
