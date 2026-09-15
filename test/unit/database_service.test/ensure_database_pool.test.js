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

        describe('ensureDatabasePool()', function () {

        it('is a no-op when db is already ready', async function () {
            const stubs = makeStubs()
            stubs.db.isReady.returns(true)
            const ds = loadDatabaseService(stubs)
            await ds.ensureDatabasePool()
            expect(stubs.db.createDatabase.called).to.be.false
        })

        it('creates database pool when not ready (docker path)', async function () {
            const stubs = makeStubs()
            stubs.db.isReady.returns(false)
            stubs.hasCredentials.returns(true)
            stubs.loadCredentials.returns({ user: 'testuser', password: 'test-pass', database: 'xchain_node' })
            // execFileAsync calls: inspect (checkIfDatabaseIsReady for existing creds),
            // then docker port (getDatabaseHostPort)
            stubs.execFileAsync
                .onCall(0).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // inspect in getDatabaseContainerId
                .onCall(1).resolves({ stdout: VALID_CONTAINER_ID + '\n' })  // inspect in checkIfDatabaseIsReady
                .onCall(2).resolves({ stdout: 'OK' })                        // mariadb SELECT 1 → ready
                .resolves({ stdout: '0.0.0.0:13306\n' })                    // docker port
            const ds = loadDatabaseService(stubs)
            await ds.ensureDatabasePool()
            expect(stubs.db.createDatabase.calledOnce).to.be.true
        })
        })
})
