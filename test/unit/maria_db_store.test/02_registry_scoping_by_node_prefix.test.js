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
const { configStub } = require('../../helpers/config_stub');
const proxyquire = require('proxyquire').noCallThru()

function loadWithPrefix(prefix) {
    const statements = []
    const record = async (sql) => {
        statements.push(String(sql).replace(/\s+/g, ' ').trim())
        return [{ cnt: 0 }]
    }
    const pool = {
        getConnection: async () => ({ query: record, release: () => {} }),
        query: record,
        end: async () => {}
    }
    const constants = require('../../../src/config')
    // The table name is resolved inside the registry mixin, not in the
    // store, so the prefix has to be stubbed where it is READ and the
    // stubbed mixin handed to the store. Stubbing constants at the store
    // reaches nothing: proxyquire only intercepts a module's own requires.
    const modules = proxyquire('../../../src/db/modules', {
        '../config/index': configStub({ NODE_PREFIX: prefix })
    })
    const MariaDbStore = proxyquire('../../../src/db', {
        'mariadb': { createPool: () => pool },
        './modules': modules
    })
    return { MariaDbStore, statements }
}

async function statementsFor(prefix) {
    const { MariaDbStore, statements } = loadWithPrefix(prefix)
    const store = new MariaDbStore()
    await store.createDatabase({ host: '127.0.0.1', port: 3306, user: 'u', password: 'p', database: 'xchain_node' })
    await store.setModuleContainer('xchain-indexer', 'bitcoin', 'mainnet', 'aaa')
    await store.getModuleContainer('xchain-indexer', 'bitcoin', 'mainnet')
    await store.getAllModuleContainers(null, null)
    await store.getAllModuleContainers('bitcoin', 'mainnet')
    await store.deleteModuleContainer('xchain-indexer', 'bitcoin', 'mainnet')
    await store.getModuleCount()
    await store.close()
    return statements
}

// A non-default prefix names its table with a readable head plus a digest of the
// RAW prefix, so the name is injective (see the MODULES_TABLE stanza).
const TABLE_RE = /\bmodules_[a-z0-9_]+_[0-9a-f]{12}\b/

function tableNameFrom(statements) {
    const hit = statements[0].match(TABLE_RE)
    expect(hit, statements[0]).to.not.equal(null)
    return hit[0]
}

/*
 * The registry is per STACK, not per host.
 *
 * In external-DB mode two co-located stacks (distinct NODE_PREFIX) point at one
 * host-native MariaDB and share the xchain_node database. The row key
 * (module, coin, network) is identical on both, so an unscoped table let each
 * stack's upsert overwrite the other's container_id and let DiscoveryService's
 * orphan purge - which classifies containers by its own prefix - delete the
 * other stack's live rows. The table name carries the stack identity instead.
 */
describe('MariaDbStore registry scoping by NODE_PREFIX', function () {
    it('keeps the bare `modules` table on the default prefix, so an existing install migrates nothing', async function () {
        const statements = await statementsFor('xchain-node')
        expect(statements.length).to.be.greaterThan(5)
        for (const sql of statements) expect(sql, sql).to.not.match(/\bmodules_/)
        expect(statements[0]).to.match(/^CREATE TABLE IF NOT EXISTS modules \(/)
    })
})

describe('MariaDbStore registry scoping by NODE_PREFIX', function () {
    it('gives a second stack its own table, so neither upsert nor purge can reach the first', async function () {
        const statements = await statementsFor('stack-b')
        expect(statements.length).to.be.greaterThan(5)
        const table = tableNameFrom(statements)
        expect(table).to.match(/^modules_stack_b_/)
        // Every statement, DDL and DML alike: one missed site is a cross-stack write.
        for (const sql of statements) {
            expect(sql, sql).to.contain(table)
            expect(sql.split(table).join(''), sql).to.not.match(/\bmodules\b/)
        }
    })
})

describe('MariaDbStore registry scoping by NODE_PREFIX', function () {
    it('sanitizes a prefix that is legal for docker but not for a MariaDB identifier', async function () {
        const statements = await statementsFor('node.1-alt')
        for (const sql of statements) expect(sql, sql).to.match(/\bmodules_node_1_alt_[0-9a-f]{12}\b/)
    })
})

// The sanitizer folds `-` and `.` onto `_`, and the head is truncated, so a
// head-only name put DISTINCT stacks back on ONE registry - the overwrite and
// orphan-purge failure this scoping exists to prevent (uuid:c8e46a8b).
describe('MariaDbStore registry scoping by NODE_PREFIX', function () {
    it('never gives two distinct prefixes the same table, separator or length', async function () {
        const separatorVariants = ['stack-a', 'stack.a', 'stack_a']
        const names = []
        for (const prefix of separatorVariants) names.push(tableNameFrom(await statementsFor(prefix)))
        expect(new Set(names).size, names.join(', ')).to.equal(separatorVariants.length)

        // Two prefixes agreeing on a long head and differing only past the old
        // 40-character truncation point.
        const head  = 'a'.repeat(45)
        const longA = tableNameFrom(await statementsFor(head + '-one'))
        const longB = tableNameFrom(await statementsFor(head + '-two'))
        expect(longA).to.not.equal(longB)

        // Still legal MariaDB identifiers.
        for (const name of names.concat([longA, longB])) expect(name.length).to.be.at.most(64)
    })
})
