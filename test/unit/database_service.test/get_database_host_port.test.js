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

        describe('getDatabaseHostPort()', function () {

        it('parses port from docker port output', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: '0.0.0.0:13306\n' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseHostPort()
            expect(result).to.equal(13306)
        })

        it('returns default port when docker port fails', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.rejects(new Error('no such container'))
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseHostPort()
            expect(result).to.equal(13306) // XCHAIN_NODE_DB_DEFAULT_PORT
        })

        it('returns default port when output has no port match', async function () {
            const stubs = makeStubs()
            stubs.execFileAsync.resolves({ stdout: 'no port info\n' })
            const ds = loadDatabaseService(stubs)
            const result = await ds.getDatabaseHostPort()
            expect(result).to.equal(13306)
        })
        })
})
