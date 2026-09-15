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

function extEnv() {
    return {
        XCHAIN_NODE_EXTERNAL_DB_HOST:          'db.example.com',
        XCHAIN_NODE_EXTERNAL_DB_PORT:          '3306',
        XCHAIN_NODE_EXTERNAL_DB_ROOT_USER:     'root',
        XCHAIN_NODE_EXTERNAL_DB_ROOT_PASSWORD: 'test-pass'
    }
}

function setExtEnv(env) {
    const saved = {}
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

        describe('ensureXchainNodeAccess(): EXTERNAL_DB path', function () {

        it('returns existing creds when they work against external MariaDB', async function () {
            const existing = { user: 'xchain_node_testuser', password: 'test-pass', database: 'xchain_node' }
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(true),
                loadCredentials: sinon.stub().returns(existing)
            })
            stubs.mariadb._fakeConn.query.resolves([])
            const saved = setExtEnv(extEnv())
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.ensureXchainNodeAccess()
                expect(result).to.deep.equal(existing)
                expect(stubs.saveCredentials.called).to.be.false
            } finally {
                restoreEnv(saved)
            }
        })

        it('reprovisions via native commands when existing creds fail on external MariaDB', async function () {
            const existing = { user: 'xchain_node_testuser', password: 'old-pass', database: 'xchain_node' }
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(true),
                loadCredentials: sinon.stub().returns(existing)
            })
            // getExternalDbConfig uses env vars path (no mariadb connection opened).
            // ensureXchainNodeAccess tries mariadb.createConnection for existing.user check -> fails.
            // executeNativeMariaDbCommand DDL calls -> succeed.
            let connCallCount = 0
            stubs.mariadb.createConnection.callsFake(() => {
                connCallCount++
                if (connCallCount === 1) return Promise.reject(new Error('auth failed')) // existing creds check
                return Promise.resolve(stubs.mariadb._fakeConn)                          // DDL commands
            })
            stubs.mariadb._fakeConn.query.resolves([])
            const saved = setExtEnv(extEnv())
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.ensureXchainNodeAccess()
                expect(stubs.saveCredentials.called).to.be.true
                expect(result.user).to.equal('xchain_node_testuser')
                expect(result.database).to.equal('xchain_node')
            } finally {
                restoreEnv(saved)
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('ensureXchainNodeAccess(): EXTERNAL_DB path', function () {

        it('provisions fresh creds when no existing credentials stored', async function () {
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(false)
            })
            stubs.mariadb._fakeConn.query.resolves([])
            const saved = setExtEnv(extEnv())
            try {
                const ds = loadDatabaseService(stubs, { EXTERNAL_DB: true })
                const result = await ds.ensureXchainNodeAccess()
                expect(result.user).to.equal('xchain_node_testuser')
                expect(result.password).to.equal('test-generated-pass')
                expect(stubs.saveCredentials.calledOnce).to.be.true
            } finally {
                restoreEnv(saved)
            }
        })
        })
})
