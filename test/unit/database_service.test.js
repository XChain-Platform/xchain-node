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

const { sinon, expect, VALID_CONTAINER_ID, fakeSpawn, mariadbAttempts, makeStubs, loadDatabaseService } = require('./database_service.test/helpers/harness')

describe('DatabaseService', function () {

        describe('checkIfDatabaseModuleExists()', function () {

        it('returns container ID when database container exists and is valid', async function () {
            const stubs = makeStubs()
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseModuleExists('bitcoin', 'mainnet')
            // Source now uses getDatabaseContainerId() → docker inspect → returns
            // the 64-char hex ID directly (not a DB-stored string).
            expect(result).to.equal(VALID_CONTAINER_ID)
        })

        it('returns null when container does not have State.Status', async function () {
            const stubs = makeStubs()
            stubs.getStatusFromContainer.resolves({})
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseModuleExists('bitcoin', 'mainnet')
            expect(result).to.be.null
        })

        it('returns null when docker inspect fails', async function () {
            const stubs = makeStubs()
            // Source uses getDatabaseContainerId() → execFileAsync('docker inspect ...).
            // Simulate container not found by rejecting the async exec.
            stubs.execFileAsync.rejects(new Error('not found'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseModuleExists('bitcoin', 'mainnet')
            expect(result).to.be.null
        })

        it('returns null when getStatusFromContainer throws', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            stubs.getStatusFromContainer.rejects(new Error('docker inspect status error'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.checkIfDatabaseModuleExists('bitcoin', 'mainnet')
            expect(result).to.be.null
        })
        })
})

describe('DatabaseService', function () {

        describe('executeDockerMariaDbCommand()', function () {

        it('pipes SQL via stdin (never argv) with the password in env, not argv', async function () {
            const stubs = makeStubs()
            stubs.spawn.callsFake(fakeSpawn(() => ({ stdout: '1\n' })))
            const ds = loadDatabaseService(stubs)
            const result = await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT 1')
            expect(result).to.equal('1')

            const child = stubs.spawn.firstCall.returnValue
            expect(stubs.spawn.firstCall.args[0]).to.equal('docker')
            expect(child._args).to.include('exec')
            expect(child._args).to.include('-i')
            expect(child._args).to.include('db-container')
            expect(child._args).to.include('mariadb')
            expect(child._args).to.include('-u')
            expect(child._args).to.include('root')
            // The SQL must NOT appear anywhere in argv; it is piped via stdin.
            expect(child._args.some(a => String(a).includes('SELECT 1'))).to.be.false
            expect(child._stdin).to.include('SELECT 1')
            // Password must travel via MYSQL_PWD env (forwarded with a bare
            // docker -e), never as a -p<password> argv entry.
            expect(child._args).to.include('MYSQL_PWD')
            expect(child._args.some(a => String(a).includes('rootpass'))).to.be.false
            expect(child._env.MYSQL_PWD).to.equal('rootpass')
        })

        it('appends commandOptions when provided', async function () {
            const stubs = makeStubs()
            stubs.spawn.callsFake(fakeSpawn(() => ({ stdout: '0\n' })))
            const ds = loadDatabaseService(stubs)
            await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT COUNT(*)', '-B -N')
            const child = stubs.spawn.firstCall.returnValue
            expect(child._args).to.include('-B')
            expect(child._args).to.include('-N')
        })

        it('rejects on non-zero exit', async function () {
            const stubs = makeStubs()
            stubs.spawn.callsFake(fakeSpawn(() => ({ stderr: 'db error', code: 1 })))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.executeDockerMariaDbCommand('db-container', 'rootpass', 'SELECT 1')
                expect.fail()
            } catch (err) {
                expect(err).to.be.an.instanceOf(Error)
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('executeDockerMariaDbCommand()', function () {


        // Security: a failed command must not leak the SQL (which can embed a
        // user password). The SQL is no longer in argv at all; this guards the
        // remaining vector: mariadb's stderr echoing a fragment of the failing
        // statement, which callers console.log.
        it('scrubs the SQL from a failed command (avoids leaking an embedded password)', async function () {
            const stubs = makeStubs()
            const SECRET = 'us3r-pw-do-not-leak'
            const SQL = "CREATE USER 'x'@'%' IDENTIFIED BY PASSWORD('" + SECRET + "')"
            stubs.spawn.callsFake(fakeSpawn(() => ({
                // mariadb batch-mode error echoing the offending statement
                stderr: 'ERROR 1064 (42000) at line 1 near ' + SQL,
                code: 1
            })))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.executeDockerMariaDbCommand('db-container', 'rootpass', SQL)
                expect.fail('should have rejected')
            } catch (err) {
                expect(err.message).to.not.include(SECRET)
                expect(err.message).to.include('<redacted-sql>')
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('executeNativeMariaDbCommand()', function () {


        // Security: the mariadb driver embeds the failing SQL in its error
        // (.message / .sql), which a user-creation statement fills with a
        // password. Scrub it before the error propagates to a console.log.
        it('scrubs the SQL from a driver query error (avoids leaking an embedded password)', async function () {
            const stubs = makeStubs()
            const SECRET = 'us3r-pw-do-not-leak'
            const SQL = "CREATE USER 'x'@'%' IDENTIFIED BY PASSWORD('" + SECRET + "')"
            const driverErr = new Error('(conn=1, no: 1064, SQLState: 42000) syntax error\nsql: ' + SQL)
            driverErr.sql = SQL
            stubs.mariadb._fakeConn.query.rejects(driverErr)
            const ds = loadDatabaseService(stubs)
            const cfg = { host: '127.0.0.1', port: 3306, root_user: 'root', root_password: 'rootpass' }
            try {
                await ds.executeNativeMariaDbCommand(cfg, SQL)
                expect.fail('should have rejected')
            } catch (err) {
                expect(err.message).to.not.include(SECRET)
                expect(String(err.sql || '')).to.not.include(SECRET)
                expect(err.message).to.include('<redacted-sql>')
            }
            // Connection is still closed via the finally block.
            expect(stubs.mariadb._fakeConn.end.called).to.be.true
        })
        })
})
