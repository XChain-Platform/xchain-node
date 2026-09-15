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

        describe('ensureXchainNodeAccess()', function () {

        it('returns existing working credentials without reprovisioning', async function () {
            const existing = { user: 'xchain_node_testuser', password: 'test-pass', database: 'xchain_node' }
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(true),
                loadCredentials: sinon.stub().returns(existing)
            })
            // checkIfDatabaseIsReady for existing creds returns true
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // inspect (in getDatabaseContainerId)
                .onCall(1).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // inspect again
                .resolves({ stdout: 'OK' })                                  // mariadb responds
            const ds = loadDatabaseService(stubs)
            const result = await ds.ensureXchainNodeAccess()
            expect(result).to.deep.equal(existing)
            expect(stubs.saveCredentials.called).to.be.false
        })
        })
})

describe('DatabaseService', function () {

        describe('ensureXchainNodeAccess()', function () {

        it('reprovisions when stored credentials no longer work', async function () {
            const existing = { user: 'xchain_node_testuser', password: 'old-pass', database: 'xchain_node' }
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(true),
                loadCredentials: sinon.stub().returns(existing)
            })
            // Flow:
            //   1. getDatabaseContainerId -> valid container ID
            //   2. checkIfDatabaseIsReady(existing.user, existing.password, ...) ->
            //      mariadb SELECT fails as that user
            //   3. askMariadbRootPassword returns the CACHED password (this test
            //      never overrides getDbRootPassword, so it stays the makeStubs()
            //      default 'rootpass') and returns before reaching env-var /
            //      ping-verification logic (uuid:2c5ec698) -> no extra exec calls
            //   4. checkIfDatabaseIsReady("root", rootPassword) -> succeeds
            //   5. DDL via executeDockerMariaDbCommand (execFile callback style)
            //
            // Discriminating on the ACCOUNT rather than on a call ordinal: the two
            // probes now carry different retry budgets, and a fake keyed on "after
            // N calls" silently re-describes the flow whenever either budget moves.
            stubs.execFileAsync.callsFake((cmd, args) => {
                if (Array.isArray(args) && args.includes('inspect')) {
                    return Promise.resolve({ stdout: VALID_CONTAINER_ID + '\n' })
                }
                if (Array.isArray(args) && args[args.indexOf('-u') + 1] === existing.user) {
                    return Promise.reject(new Error('auth failed'))
                }
                return Promise.resolve({ stdout: 'OK' })
            })
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'root-pass'
            try {
                stubs.spawn.callsFake(fakeSpawn(() => ({ stdout: '' })))
                const ds = loadDatabaseService(stubs)
                const result = await ds.ensureXchainNodeAccess()
                expect(stubs.saveCredentials.called).to.be.true
                expect(result.user).to.equal('xchain_node_testuser')
                // preCheck holds the global command lock across this call, so the
                // stored-credential probe must not sit through the readiness budget
                // to learn an answer (access denied / unknown DB) that is permanent:
                // ten attempts ten seconds apart blocked every other xchain-node
                // invocation on the box for ~100s with no output.
                expect(mariadbAttempts(stubs, existing.user)).to.have.length(2)
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })
        })
})

describe('DatabaseService', function () {

        describe('ensureXchainNodeAccess()', function () {

        it('throws when container not found and no credentials', async function () {
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(false)
            })
            stubs.execFileAsync.rejects(new Error('no container'))
            const ds = loadDatabaseService(stubs)
            try {
                await ds.ensureXchainNodeAccess()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('MariaDB container not found')
            }
        })

        it('throws "MariaDB is not responding" when root checkIfDatabaseIsReady returns false', async function () {
            // Force: no existing creds, container found, but root mariadb check fails all retries
            const stubs = makeStubs({
                hasCredentials: sinon.stub().returns(false)
            })
            // getDatabaseContainerId (inspect) → valid, then all mariadb checks fail → ready=false
            stubs.execFileAsync.callsFake((cmd, args) => {
                if (Array.isArray(args) && args.includes('inspect')) {
                    return Promise.resolve({ stdout: VALID_CONTAINER_ID + '\n' })
                }
                return Promise.reject(new Error('mariadb not responding'))
            })
            const saved = process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
            process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = 'root-pass'
            try {
                const ds = loadDatabaseService(stubs)
                await ds.ensureXchainNodeAccess()
                expect.fail('should have thrown')
            } catch (err) {
                expect(err.message).to.include('MariaDB is not responding')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_DB_ROOT_PASSWORD
                else process.env.XCHAIN_NODE_DB_ROOT_PASSWORD = saved
            }
        })
        })
})
