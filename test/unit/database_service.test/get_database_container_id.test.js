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

        describe('getDatabaseContainerId()', function () {

        it('returns container ID when inspect returns valid 64-char hex', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: VALID_CONTAINER_ID + '\n' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseContainerId()
            expect(result).to.equal(VALID_CONTAINER_ID)
        })

        it('returns null when inspect returns non-hex output', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: 'not-a-container-id\n' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseContainerId()
            expect(result).to.be.null
        })

        it('returns null when inspect command throws', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.rejects(new Error('container not found'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseContainerId()
            expect(result).to.be.null
        })
        })
})
