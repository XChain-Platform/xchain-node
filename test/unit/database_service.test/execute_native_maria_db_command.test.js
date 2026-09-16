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

const extCfg = { host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'test-pass' }

describe('DatabaseService', function () {

        describe('executeNativeMariaDbCommand()', function () {

        it('returns empty string for DDL (non-array result)', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves({ affectedRows: 1 }) // non-array = DDL
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'CREATE DATABASE foo')
            expect(result).to.equal('')
        })

        it('returns empty string for SELECT without batch mode', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([{ col: 'val' }])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT 1')
            expect(result).to.equal('')
        })

        it('returns tab-delimited rows in batch mode (-B -N)', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([['3'], ['5']])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT id FROM tbl', '-B -N')
            expect(result).to.equal('3\n5')
        })

        it('returns tab-joined columns in batch mode for multi-column rows', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([['a', 'b', 'c']])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT a,b,c FROM tbl', '-B -N')
            expect(result).to.equal('a\tb\tc')
        })

        it('returns empty string for empty batch result', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT id FROM tbl', '-B -N')
            expect(result).to.equal('')
        })

        it('recognizes --batch flag', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([['1']])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT 1', '--batch --skip-column-names')
            expect(result).to.equal('1')
        })
        })
})

describe('DatabaseService', function () {

        describe('executeNativeMariaDbCommand()', function () {


        // The real mariadb client clusters short flags, and the docker sibling
        // hands this string to it verbatim, so '-BN' has to mean batch mode here
        // too. It did not: the token regexes demanded a whitespace-delimited
        // '-B', so every '-BN' caller (the halt-marker probe in the bootstrap
        // health gate, the external-DB freshness check that gates a DROP/restore)
        // read '' and parsed it into a NaN that loses every comparison.
        it('recognizes the clustered short flag -BN as batch mode', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([['3'], ['5']])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT id FROM tbl', '-BN')
            expect(result).to.equal('3\n5')
        })

        it('recognizes the clustered short flag in either order (-NB)', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([['7']])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT id FROM tbl', '-NB')
            expect(result).to.equal('7')
        })

        it('asks the driver for array rows when a clustered flag grants batch mode', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([['1']])
            const ds = loadDatabaseService(stubs)
            await ds.executeNativeMariaDbCommand(extCfg, 'SELECT 1', '-BN')
            expect(stubs.mariadb.createConnection.lastCall.args[0].rowsAsArray).to.equal(true)
        })

        it('still returns empty for an option string carrying no batch flag', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.resolves([['1']])
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeNativeMariaDbCommand(extCfg, 'SELECT 1', '-N')
            expect(result).to.equal('')
        })

        it('closes connection even when query throws', async function () {
            const stubs = makeStubs()
            stubs.mariadb._fakeConn.query.rejects(new Error('query error'))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.executeNativeMariaDbCommand(extCfg, 'SELECT 1')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.equal('query error')
            }
            expect(stubs.mariadb._fakeConn.end.calledOnce).to.be.true
        })
        })
})
