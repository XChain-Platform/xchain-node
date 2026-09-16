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

databaseSuite('checkIfDatabaseIsReady', function (fixture) {

    it('retries until database responds', async function () {
        const { env, capture, fakeContainerId, makeDatabaseService } = fixture()
        const dbContainerId = fakeContainerId('d')
        await env.insertModule(DB_MODULE_NAME, '', '', dbContainerId)

        let callCount = 0
        const execFileAsyncStub = async (command, args) => {
            callCount++
            if (callCount < 3) throw new Error('Connection refused')
            return { stdout: '1', stderr: '' }
        }

        // See makeDatabaseService's identical comment above: DatabaseService
        // logs through redactSecrets(), so a bare `{ sleep }` mock throws
        // "redactSecrets is not a function" once code reaches a log line.
        const { DatabaseService } = makeDatabaseService({ execFileAsyncStub })

        const ready = await DatabaseService.checkIfDatabaseIsReady('root', 'testrootpw')
        expect(ready).to.be.true
        expect(callCount).to.equal(3)
    })
})
