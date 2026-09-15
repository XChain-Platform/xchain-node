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

function setExtEnv() {
    const saved = {}
    const env = {
        XCHAIN_NODE_EXTERNAL_DB_HOST:          '127.0.0.1',
        XCHAIN_NODE_EXTERNAL_DB_PORT:          '3306',
        XCHAIN_NODE_EXTERNAL_DB_ROOT_USER:     'root',
        XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: 'test-pass'
    }
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k]
        process.env[k] = v
    }
    return saved
}

function restoreEnv(saved) {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
}

describe('DatabaseService', function () {

        describe('addUserPasswordToDatabase(): EXTERNAL_DB path', function () {

        it('creates database and user via native mariadb when EXTERNAL_DB=true', async function () {
            const stubs = makeStubs()
            // batch mode query returns '0' (db doesn't exist, user doesn't exist)
            stubs.mariadb._fakeConn.query.resolves([['0']])
            const saved = setExtEnv()
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass',
                    true  // inDocker=true but EXTERNAL_DB overrides
                )
                expect(result).to.be.true
                expect(stubs.mariadb.createConnection.called).to.be.true
            } finally {
                restoreEnv(saved)
            }
        })

        it('skips creates when db and user already exist (EXTERNAL_DB)', async function () {
            const stubs = makeStubs()
            // Return '1' for all COUNT queries (already exist) and full grant for SHOW GRANTS
            let queryCount = 0
            stubs.mariadb._fakeConn.query.callsFake((sql) => {
                queryCount++
                if (sql.includes('SELECT COUNT')) return Promise.resolve([['1']])
                if (sql.includes('SHOW GRANTS')) {
                    return Promise.resolve([["GRANT ALL PRIVILEGES ON 'XChain_BTC_Mainnet_Decoder'.* TO 'xchain_decoder_bitcoin_mainnet'@'%'"]])
                }
                return Promise.resolve([])
            })
            const saved = setExtEnv()
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass',
                    true
                )
                expect(result).to.be.true
            } finally {
                restoreEnv(saved)
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('addUserPasswordToDatabase(): EXTERNAL_DB path', function () {

        it('grants MVH permissions for hub module via native mariadb (EXTERNAL_DB)', async function () {
            const stubs = makeStubs()
            const queries = []
            stubs.mariadb._fakeConn.query.callsFake((sql) => {
                queries.push(sql)
                if (sql.includes('SELECT COUNT')) return Promise.resolve([['0']])
                if (sql.includes('SHOW GRANTS')) return Promise.resolve([['GRANT USAGE ON *.* TO user']])
                return Promise.resolve([])
            })
            const saved = setExtEnv()
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true, HUB_MODULE_NAME: 'xchain-hub' })
                await ds.addUserPasswordToDatabase(
                    'xchain-hub', 'bitcoin', 'mainnet',
                    'xchain_node', 'xchain_node_user', 'test-pass', true
                )
                const mvhQuery = queries.find(q => q && q.includes('MVH'))
                expect(mvhQuery).to.exist
            } finally {
                restoreEnv(saved)
            }
        })

        it('grants SLAVE MONITOR to an indexer account via native mariadb (EXTERNAL_DB)', async function () {
            // The native-DB boxes are the ones whose schemas can be fed by real MariaDB
            // replication, so the probe this unblocks is the only signal separating a
            // stopped SQL thread from a quiet chain.
            const stubs = makeStubs()
            const queries = []
            stubs.mariadb._fakeConn.query.callsFake((sql) => {
                queries.push(sql)
                if (sql.includes('SELECT COUNT')) return Promise.resolve([['0']])
                if (sql.includes('SHOW GRANTS')) return Promise.resolve([['GRANT USAGE ON *.* TO user']])
                return Promise.resolve([])
            })
            const saved = setExtEnv()
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                await ds.addUserPasswordToDatabase(
                    'xchain-indexer', 'bitcoin', 'mainnet',
                    'XChain_BTC_Mainnet_Indexer', 'xchain_indexer_bitcoin_mainnet', 'test-pass', true
                )
                const grant = queries.find(q => q && q.includes('SLAVE MONITOR'))
                expect(grant).to.exist
                expect(grant).to.include('ON *.*')
                expect(grant, 'the grant must name the account being provisioned').to.include('xchain_indexer_bitcoin_mainnet')
            } finally {
                restoreEnv(saved)
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('addUserPasswordToDatabase(): EXTERNAL_DB path', function () {

        it('throws when native mariadb command fails (EXTERNAL_DB)', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.rejects(new Error('native query error'))
            const saved = setExtEnv()
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                await ds.addUserPasswordToDatabase(
                    'xchain-decoder', 'bitcoin', 'mainnet',
                    'XChain_BTC_Mainnet_Decoder', 'xchain_decoder_bitcoin_mainnet', 'test-pass', true
                )
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.equal('native query error')
            } finally {
                restoreEnv(saved)
            }
        })
        })
})
