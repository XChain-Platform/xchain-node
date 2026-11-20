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
const { DATABASE, resetSchemaModel, readResetLedger, queryInformationSchema } = require('./helpers/reset_schema_state')

const INDEXER_DIR = path.join(__dirname, '../../../../xchain-indexer')
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'
const LIST_SHARE = '2026-09-30-list-share-tables.sql'
const ORACLE_WIDEN = '2026-09-22-oracle-prices-widen-tick.sql'
const PUBKEYS_WIDEN = '2026-07-24-pubkeys-widen-uncompressed.sql'
const OUTBOX_WIDEN = '2026-11-19-pending-hub-pushes-widen-payload.sql'
const BRIDGE_TABLES = '2026-09-12-bridge-tables.sql'
const ROUND_QUALIFIER = '2026-08-24-validator-rewards-round-qualifier.sql'
const BRIDGE_NAMES = ['bridge_transfers', 'bridge_settlements', 'policy_snapshots', 'xbridges']

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
function payloadColumn(dataType, charset) {
    return {
        table_schema: DATABASE, table_name: 'pending_hub_pushes', column_name: 'payload', data_type: dataType,
        is_nullable: 'NO', column_default: null, extra: '', character_maximum_length: null,
        column_type: dataType, ordinal_position: 4, character_set_name: charset,
        collation_name: charset + '_general_ci', generation_expression: null
    }
}
async function satisfiedWith({ tables = [], columns = [] }) {
    const model = resetSchemaModel()
    model.tables.push(...tables)
    model.columns.push(...columns)
    return (await readResetLedger(model)).satisfied
}
function tableNamesFromInList(sql) {
    const match = /table_name IN \(([^)]+)\)/.exec(sql)
    return match ? [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort() : []
}
// True when the indexer sibling is checked out; otherwise skips the test, or fails it under XCHAIN_REQUIRE_SIBLINGS.
function indexerPresent(ctx) {
    if (fs.existsSync(INDEXER_DIR)) return true
    if (REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-indexer is not checked out at ' + INDEXER_DIR)
    ctx.skip()
    return false
}
function qualifierColumn(model, tableName) {
    return model.columns.find(row => row.table_name === tableName && row.column_name === 'round_qualifier')
}
function rewardUniqueRows(model) {
    return model.indexes.filter(row => row.index_name === 'reward_unique')
}
// Off-position variants the indexer baselines; node must accept every one of them.
function qualifierOrdinalVariants() {
    const variants = [resetSchemaModel(), resetSchemaModel(), resetSchemaModel()]
    qualifierColumn(variants[0], 'validator_rewards').ordinal_position = 7
    qualifierColumn(variants[1], 'anchor_reward_reconcile_log').ordinal_position = 9
    qualifierColumn(variants[2], 'validator_rewards').ordinal_position = 17
    qualifierColumn(variants[2], 'anchor_reward_reconcile_log').ordinal_position = 12
    return variants
}
// Identity-shape drift: a signed, nullable or re-defaulted qualifier, or a reward key with members
// missing or added, changes which rewards the unique key treats as duplicates.
function qualifierIdentityDriftVariants() {
    const drifts = {
        signed: model => { qualifierColumn(model, 'validator_rewards').column_type = 'bigint' },
        nullable: model => { qualifierColumn(model, 'validator_rewards').is_nullable = 'YES' },
        default: model => { qualifierColumn(model, 'anchor_reward_reconcile_log').column_default = '9' },
        qualifierOnlyKey: model => {
            const member = rewardUniqueRows(model).find(row => row.column_name === 'round_qualifier')
            model.indexes = model.indexes.filter(row => row.index_name !== 'reward_unique')
            model.indexes.push({ ...member, seq_in_index: 1 })
        },
        extraKeyMember: model => {
            const rows = rewardUniqueRows(model)
            model.indexes.push({ ...rows[rows.length - 1], seq_in_index: rows.length + 1, column_name: 'id' })
        }
    }
    return Object.entries(drifts).map(([name, apply]) => {
        const model = resetSchemaModel()
        apply(model)
        return [name, model]
    })
}

describe('indexer precondition fact parity', () => {
    it('has a node fact for every indexer baseline predicate and every deploy-precondition file', function () {
        if (!indexerPresent(this)) return
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

    it('treats bridge tables as applied from table presence even with DATETIME created_at columns', async () => {
        const model = resetSchemaModel()
        model.columns.push(
            { ...tickColumn(null), table_name: 'bridge_transfers', column_name: 'created_at', data_type: 'datetime' },
            { ...tickColumn(null), table_name: 'policy_snapshots', column_name: 'created_at', data_type: 'datetime' })
        expect((await readResetLedger(model)).satisfied).to.include(BRIDGE_TABLES)
    })

    it('keeps the bridge migration missing when any required table is absent', async () => {
        for (const missing of BRIDGE_NAMES) {
            const model = resetSchemaModel()
            model.tables = model.tables.filter(row => row.table_name !== missing)
            expect((await readResetLedger(model)).satisfied, missing).to.not.include(BRIDGE_TABLES)
        }
    })

    it('uses the same bridge table list as the indexer baseline', function () {
        if (!indexerPresent(this)) return
        const { MIGRATION_PRECONDITIONS } = require(path.join(INDEXER_DIR, 'src/db/database/migration_tables.js'))
        const nodeSql = appliedMigrationsSql('XChain_BTC_Mainnet_Indexer', 'schema_migrations')
        const nodeFact = nodeSql.split("SELECT '" + BRIDGE_TABLES + "' AS name WHERE ")[1].split(' UNION ')[0]
        expect(tableNamesFromInList(nodeFact)).to.deep.equal(
            tableNamesFromInList(MIGRATION_PRECONDITIONS[BRIDGE_TABLES].sql))
    })
})

describe('indexer precondition fact parity', () => {

    it('treats the oracle tick widening as applied at 250 characters or wider, and not below', async () => {
        expect(await satisfiedWith({ columns: [tickColumn(250)] })).to.include(ORACLE_WIDEN)
        expect(await satisfiedWith({ columns: [tickColumn(300)] })).to.include(ORACLE_WIDEN)
        expect(await satisfiedWith({ columns: [tickColumn(50)] })).to.not.include(ORACLE_WIDEN)
        expect(await satisfiedWith({ columns: [tickColumn(249)] })).to.not.include(ORACLE_WIDEN)
    })

    it('matches the indexer pubkey-width baseline without requiring cosmetic column shape', async () => {
        for (const override of [
            {}, { character_maximum_length: 200 }, { ordinal_position: 3 },
            { character_set_name: 'utf8mb4', collation_name: 'utf8mb4_general_ci' }, { is_nullable: 'YES' }
        ]) {
            const model = resetSchemaModel()
            const row = model.columns.find(c => c.table_name === 'pubkeys' && c.column_name === 'pubkey')
            Object.assign(row, override)
            expect((await readResetLedger(model)).satisfied, JSON.stringify(override)).to.include(PUBKEYS_WIDEN)
        }
        for (const length of [66, 129, null]) {
            const model = resetSchemaModel()
            model.columns.find(c => c.table_name === 'pubkeys' && c.column_name === 'pubkey').character_maximum_length = length
            expect((await readResetLedger(model)).satisfied, String(length)).to.not.include(PUBKEYS_WIDEN)
        }
        const missing = resetSchemaModel()
        missing.columns = missing.columns.filter(c => c.table_name !== 'pubkeys' || c.column_name !== 'pubkey')
        expect((await readResetLedger(missing)).satisfied).to.not.include(PUBKEYS_WIDEN)
    })

    it('matches the indexer payload baseline for capacity and charset', async () => {
        expect(await satisfiedWith({ columns: [payloadColumn('mediumtext', 'utf8mb4')] })).to.include(OUTBOX_WIDEN)
        expect(await satisfiedWith({ columns: [payloadColumn('longtext', 'utf8mb4')] })).to.include(OUTBOX_WIDEN)
        expect(await satisfiedWith({ columns: [payloadColumn('text', 'utf8mb4')] })).to.not.include(OUTBOX_WIDEN)
        expect(await satisfiedWith({ columns: [payloadColumn('mediumtext', 'utf8mb3')] })).to.not.include(OUTBOX_WIDEN)
    })
})

describe('indexer precondition fact parity', () => {
    it('accepts the round-qualifier columns at any column position', async () => {
        for (const [index, model] of qualifierOrdinalVariants().entries()) {
            expect((await readResetLedger(model)).satisfied, 'variant ' + index).to.include(ROUND_QUALIFIER)
        }
    })

    it('keeps the round-qualifier migration missing when the reward identity shape drifts', async () => {
        for (const [name, model] of qualifierIdentityDriftVariants()) {
            expect((await readResetLedger(model)).satisfied, name).to.not.include(ROUND_QUALIFIER)
        }
    })

    it('keeps the round-qualifier migration missing when either column or its unique key member is absent', async () => {
        for (const tableName of ['validator_rewards', 'anchor_reward_reconcile_log']) {
            const model = resetSchemaModel()
            model.columns = model.columns.filter(row => row.table_name !== tableName || row.column_name !== 'round_qualifier')
            expect((await readResetLedger(model)).satisfied, tableName).to.not.include(ROUND_QUALIFIER)
        }
        for (const nonUnique of [null, 1]) {
            const model = resetSchemaModel()
            model.indexes = nonUnique === null
                ? model.indexes.filter(row => row.index_name !== 'reward_unique' || row.column_name !== 'round_qualifier')
                : model.indexes.map(row => row.index_name === 'reward_unique' ? { ...row, non_unique: nonUnique } : row)
            expect((await readResetLedger(model)).satisfied, String(nonUnique)).to.not.include(ROUND_QUALIFIER)
        }
    })

    it('agrees with the indexer round-qualifier predicate on accepted and rejected schema variants', async function () {
        if (!indexerPresent(this)) return
        const { MIGRATION_PRECONDITIONS } = require(path.join(INDEXER_DIR, 'src/db/database/migration_tables.js'))
        const predicate = MIGRATION_PRECONDITIONS[ROUND_QUALIFIER]
        const variants = [resetSchemaModel(), ...qualifierOrdinalVariants(), resetSchemaModel(), resetSchemaModel()]
        const missingMember = variants[variants.length - 2]
        missingMember.indexes = missingMember.indexes.filter(row => row.index_name !== 'reward_unique'
            || row.column_name !== 'round_qualifier')
        const nonUniqueKey = variants[variants.length - 1]
        nonUniqueKey.indexes = nonUniqueKey.indexes.map(row => row.index_name === 'reward_unique'
            ? { ...row, non_unique: 1 } : row)
        const outcomes = []
        for (const [index, model] of variants.entries()) {
            const nodeSatisfied = (await readResetLedger(model)).satisfied.includes(ROUND_QUALIFIER)
            const indexerSatisfied = predicate.skipWhen(queryInformationSchema(model, predicate.sql, [DATABASE])) !== null
            expect(nodeSatisfied, 'variant ' + index).to.equal(indexerSatisfied)
            outcomes.push(indexerSatisfied)
        }
        expect(outcomes).to.deep.equal([true, true, true, true, false, false])
    })
})
