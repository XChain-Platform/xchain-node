'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The node counts a migration as applied when its ledger row exists OR its end
// state already holds. The indexer baselines the same files at boot from
// MIGRATION_PRECONDITIONS, so a key with no node fact makes the deploy guard
// refuse a database the indexer would accept.

const fs = require('fs')
const path = require('path')
const { expect } = require('chai')

const { appliedMigrationsSql } = require('../../../src/db/migrations')
const { listDeployPreconditionMigrations } = require('../../../src/services/migration_precondition_service')
const { migrationsDirOf } = require('../../../src/utils/migration_files')
const { DATABASE, resetSchemaModel, readResetLedger } = require('./helpers/reset_schema_state')

const INDEXER_DIR = path.join(__dirname, '../../../../xchain-indexer')
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'
const LIST_SHARE = '2026-09-30-list-share-tables.sql'
const ORACLE_WIDEN = '2026-09-22-oracle-prices-widen-tick.sql'

function table(name) {
    return { table_schema: DATABASE, table_name: name, engine: 'InnoDB', table_collation: 'utf8mb3_general_ci', table_type: 'BASE TABLE' }
}
function tickColumn(length) {
    return {
        table_schema: DATABASE, table_name: 'oracle_prices', column_name: 'tick', data_type: 'varchar',
        is_nullable: 'NO', column_default: null, extra: '', character_maximum_length: length,
        column_type: 'varchar(' + length + ')', ordinal_position: 2,
        character_set_name: 'utf8mb3', collation_name: 'utf8mb3_general_ci', generation_expression: null
    }
}
async function satisfiedWith({ tables = [], columns = [] }) {
    const model = resetSchemaModel()
    model.tables.push(...tables)
    model.columns.push(...columns)
    return (await readResetLedger(model)).satisfied
}

describe('indexer precondition fact parity', () => {
    it('has a node fact for every indexer baseline predicate and every deploy-precondition file', function () {
        if (!fs.existsSync(INDEXER_DIR)) {
            if (REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-indexer is not checked out at ' + INDEXER_DIR)
            return this.skip()      // sibling repo not checked out
        }
        const { MIGRATION_PRECONDITIONS } = require(path.join(INDEXER_DIR, 'src/db/database/migration_tables.js'))
        const required = listDeployPreconditionMigrations(migrationsDirOf(INDEXER_DIR))
        const names = new Set([...Object.keys(MIGRATION_PRECONDITIONS), ...required])
        expect(required, 'the indexer declares deploy-precondition files').to.include(LIST_SHARE)
        const sql = appliedMigrationsSql('XChain_BTC_Mainnet_Indexer', 'schema_migrations')
        const missing = [...names].filter(name => !sql.includes("SELECT '" + name + "' AS name WHERE "))
        expect(missing, 'indexer migrations with no node schema fact').to.deep.equal([])
    })

    it('treats the list-share migration as applied once both tables exist', async () => {
        expect(await satisfiedWith({ tables: [table('list_snapshots'), table('list_share_mirrors')] })).to.include(LIST_SHARE)
    })

    it('keeps the list-share migration missing while either table is absent', async () => {
        expect(await satisfiedWith({ tables: [table('list_snapshots')] })).to.not.include(LIST_SHARE)
        expect(await satisfiedWith({ tables: [table('list_share_mirrors')] })).to.not.include(LIST_SHARE)
    })

    it('treats the oracle tick widening as applied at 250 characters or wider, and not below', async () => {
        expect(await satisfiedWith({ columns: [tickColumn(250)] })).to.include(ORACLE_WIDEN)
        expect(await satisfiedWith({ columns: [tickColumn(300)] })).to.include(ORACLE_WIDEN)
        expect(await satisfiedWith({ columns: [tickColumn(50)] })).to.not.include(ORACLE_WIDEN)
        expect(await satisfiedWith({ columns: [tickColumn(249)] })).to.not.include(ORACLE_WIDEN)
    })
})
