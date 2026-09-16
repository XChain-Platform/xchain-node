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

const { DB_MODULE_NAME } = require('../../../src/config')
const { databaseSuite } = require('./support/fixture')

databaseSuite('buildDatabaseModule (already exists)', function (fixture) {

    it('reuses existing container and adds to network', async function () {
        const { env, capture, fakeContainerId, makeDatabaseService } = fixture()
        const dbContainerId = fakeContainerId('d')
        await env.insertModule(DB_MODULE_NAME, '', '', dbContainerId)

        // getDatabaseContainerId() (checkIfDatabaseModuleExists's probe)
        // resolves the running database container via a real `docker
        // inspect --type container --format {{.Id}}` call, not the module
        // registry env.insertModule() just populated; without this route
        // it reads back empty stdout, checkIfDatabaseModuleExists()
        // returns null, and buildDatabaseModule wrongly takes the
        // fresh-install branch instead of the reuse branch under test.
        capture.when(/docker inspect --type container --format/).returns({ stdout: dbContainerId + '\n' })

        const networkConnections = []
        // Fresh install: see the identical note in makeDatabaseService.
        // See makeDatabaseService's identical comment above: DatabaseService
        // logs through redactSecrets(), so a bare `{ sleep }` mock throws
        // "redactSecrets is not a function" once code reaches a log line.
        const { DatabaseService } = makeDatabaseService({
            dbContainerId,
            containerExists: true,
            networkConnections
        })

        const state = require('../../../src/state')
        state.setDbRootPassword('testrootpw')

        await DatabaseService.buildDatabaseModule('litecoin', 'mainnet')

        capture.assertNotCalled(/docker pull/)
        capture.assertNotCalled(/docker run/)

        expect(networkConnections).to.have.length(1)
        expect(networkConnections[0].id).to.equal(dbContainerId)
        expect(networkConnections[0].network).to.equal('xchain-node-litecoin-mainnet')
    })
})
