'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { DatabaseSync } = require('node:sqlite')
const { readAppliedMigrations } = require('../../../../src/services/migration_precondition_service')

const DATABASE = 'XChain_BTC_Mainnet_Indexer'
const RESET_MARKER = '2026-09-16-admission-height.sql'

const V0190_MIGRATIONS = `
    2026-05-30-balances-composite-index.sql 2026-06-03-unique-full-column-index-addresses.sql 2026-06-09-cross-chain-matches-partial-fill-columns.sql
    2026-06-10-mirror-id-autoincrement-repair.sql 2026-06-13-attests-request-status-add-rejected.sql 2026-06-14-capability-snapshots-add-source.sql
    2026-06-16-drop-orphaned-contract-balances.sql 2026-06-17-attests-drop-unique-request-id-version.sql 2026-06-19-index-tables-add-block-index.sql
    2026-06-21-index-tables-block-index-secondary-idx.sql 2026-06-23-tokens-action-index-idx.sql 2026-06-23-validator-rewards-block-index-idx.sql
    2026-06-26-cross-chain-settlements-block-index-idx.sql 2026-06-26-price-snapshots-status-block-round-idx.sql 2026-06-26-unstakes-cooldown-status-composite-idx.sql
    2026-06-27-polls-weight-mode-add-quadratic-time-weighted.sql 2026-07-03-votes-append-only-unique-idx.sql 2026-07-05-contract-index-columns-nullable.sql
    2026-07-05-polls-binding-callback-columns.sql 2026-07-07-cross-chain-matches-payout-legs.sql 2026-07-07-tick-id-columns-nullable.sql
    2026-07-10-contract-state-bin-key-index.sql 2026-07-13-balances-drop-redundant-address-id-index.sql 2026-07-15-markets-dedup-unique-pair.sql
    2026-07-15-sweeps-drop-legacy-escrows-column.sql 2026-07-16-mirror-id-unsigned-align.sql 2026-07-16-mirror-twin-bigint-unsigned-align.sql
    2026-07-16-reposition-state-key-bin.sql 2026-07-17-attests-add-responsible-set-json.sql 2026-07-17-cross-chain-matches-reorg-fence-columns.sql
    2026-07-17-oracle-prices-add-push-generation.sql 2026-07-17-polls-callback-delay-columns.sql 2026-07-18-reward-tables-source-block-composite-idx.sql
    2026-07-18-status-tables-status-action-composite-idx.sql 2026-07-19-anchor-actions-publisher-attestation-columns.sql 2026-07-19-events-reorg-marker-witness-columns.sql
    2026-07-19-price-snapshots-cross-chain-calls-reorg-fence-columns.sql 2026-07-20-capability-snapshots-source-in-unique-key.sql 2026-07-21-anchor-reward-attestations-table.sql
    2026-07-24-pubkeys-widen-uncompressed.sql 2026-07-26-bet-cancel-resolve-status-tables.sql 2026-07-26-tokens-backfill-lock-mint-supply.sql
    2026-07-28-escrow-leaf-journal-table.sql 2026-07-28-state-tree-roots-contract-state-root.sql 2026-07-28-state-tree-roots-escrow-shadow.sql
    2026-07-29-gated-files-threshold-and-publisher.sql 2026-07-29-state-checkpoints-uq-chain-seq.sql 2026-07-30-attests-add-relay-origin-columns.sql
    2026-08-10-bet-cancel-resolve-standalone-indexes.sql 2026-08-11-attests-relay-identity-index.sql 2026-08-12-validator-rewards-derive-block-index.sql
    2026-08-13-anchor-reward-attestations-doge-anchor-txid.sql 2026-08-13-contract-delegation-rotations-table.sql 2026-08-15-destroys-drop-unique-action-index.sql
    2026-08-15-lists-add-memo.sql 2026-08-19-attest-validator-stats-surrogate-id.sql 2026-08-19-files-name-index.sql
    2026-08-19-utf8mb4-index-memos-memo.sql 2026-08-19-utf8mb4-user-text-columns.sql 2026-08-24-validator-rewards-round-qualifier.sql
    2026-08-26-prices-add-v2-batch-columns.sql 2026-08-28-anchor-actions-section-index-pk.sql 2026-08-30-rollcall-tables.sql
    2026-09-02-issues-backfill-transfer-supply-id.sql 2026-09-02-utf8mb4-raw-wire-fields-not-null.sql 2026-09-02-utf8mb4-raw-wire-fields.sql
    2026-09-03-attestation-responses.sql 2026-09-03-attests-batch-action-index.sql 2026-09-03-attests-batch-chunk-columns.sql
    2026-09-06-attestation-responses-identity-effective-time.sql 2026-09-06-price-snapshots-status-timestamp-round-idx.sql 2026-09-06-utf8mb4-attestation-response-provider-fields.sql
    2026-09-07-rollcall-gates.sql 2026-09-08-deploy-deferred-assembly.sql 2026-09-10-markets-native-coin-side.sql
    2026-09-11-contract-meta-columns.sql 2026-09-11-cross-chain-btc-chain-id.sql 2026-09-11-price-snapshots-batch-block-time.sql
    2026-09-12-bridge-tables.sql 2026-09-12-state-tree-roots-block-index-idx.sql 2026-09-12-token-bridge-fields.sql
    2026-09-13-destroys-sends-leg-ordinal.sql
`.trim().split(/\s+/)

const PRECONDITION_MIGRATIONS = new Set([
    '2026-07-24-pubkeys-widen-uncompressed.sql',
    '2026-08-24-validator-rewards-round-qualifier.sql',
    '2026-09-12-bridge-tables.sql'
])

const RESET_BASELINED_ROWS = new Set([
    '2026-07-24-pubkeys-widen-uncompressed.sql',
    '2026-08-12-validator-rewards-derive-block-index.sql',
    '2026-08-24-validator-rewards-round-qualifier.sql'
])

const SYNTHESIZED_ROWS = new Set(`
    2026-05-30-balances-composite-index.sql 2026-06-03-unique-full-column-index-addresses.sql 2026-06-10-mirror-id-autoincrement-repair.sql
    2026-06-16-drop-orphaned-contract-balances.sql
    2026-07-10-contract-state-bin-key-index.sql 2026-07-15-markets-dedup-unique-pair.sql 2026-07-15-sweeps-drop-legacy-escrows-column.sql
    2026-07-16-mirror-twin-bigint-unsigned-align.sql 2026-07-16-reposition-state-key-bin.sql 2026-07-24-pubkeys-widen-uncompressed.sql
    2026-07-26-tokens-backfill-lock-mint-supply.sql 2026-07-29-state-checkpoints-uq-chain-seq.sql 2026-08-12-validator-rewards-derive-block-index.sql
    2026-08-19-utf8mb4-index-memos-memo.sql 2026-08-24-validator-rewards-round-qualifier.sql 2026-09-02-issues-backfill-transfer-supply-id.sql
    2026-09-02-utf8mb4-raw-wire-fields-not-null.sql 2026-09-10-markets-native-coin-side.sql 2026-09-12-bridge-tables.sql
`.trim().split(/\s+/))

const BRIDGE_TABLES = ['bridge_transfers', 'bridge_settlements', 'policy_snapshots', 'xbridges']

function resetLedger() {
    const ledger = new Set(V0190_MIGRATIONS.filter(name => !SYNTHESIZED_ROWS.has(name) || RESET_BASELINED_ROWS.has(name)))
    ledger.add(RESET_MARKER)
    return ledger
}

function column(table, name, dataType, options = {}) {
    const textType = ['char', 'varchar', 'text', 'mediumtext'].includes(dataType)
    return {
        table_schema: DATABASE,
        table_name: table,
        column_name: name,
        data_type: dataType,
        is_nullable: options.nullable ? 'YES' : 'NO',
        column_default: options.default === undefined ? null : options.default,
        extra: options.autoIncrement ? 'auto_increment' : (options.extra || ''),
        character_maximum_length: options.length === undefined ? null : options.length,
        column_type: dataType + (options.unsigned ? ' unsigned' : ''),
        ordinal_position: options.ordinal,
        character_set_name: options.charset || (textType ? 'utf8mb3' : null),
        collation_name: options.collation || (textType ? 'utf8mb3_general_ci' : null),
        generation_expression: options.generationExpression || null
    }
}

function index(table, name, columns, nonUnique) {
    return columns.map((nameOfColumn, offset) => ({
        table_schema: DATABASE,
        table_name: table,
        index_name: name,
        seq_in_index: offset + 1,
        column_name: nameOfColumn,
        sub_part: null,
        index_type: 'BTREE',
        non_unique: nonUnique
    }))
}

function resetSchemaModel() {
    const columns = [
        column('contract_state', 'state_key', 'varchar', { length: 256, ordinal: 5 }),
        column('contract_state', 'state_key_bin', 'varchar', {
            length: 256, ordinal: 6, collation: 'utf8mb3_bin', extra: 'VIRTUAL GENERATED', generationExpression: '`state_key`'
        }),
        column('pubkeys', 'pubkey', 'varchar', { length: 130, ordinal: 2 }),
        column('validator_rewards', 'round_qualifier', 'bigint', { unsigned: true, default: '0', ordinal: 6 }),
        column('validator_rewards', 'derive_block_index', 'bigint', { unsigned: true, nullable: true, ordinal: 9 }),
        column('anchor_reward_reconcile_log', 'round_qualifier', 'bigint', { unsigned: true, default: '0', ordinal: 5 }),
        column('anchor_reward_reconcile_log', 'reward_derive_block_index', 'bigint', { unsigned: true, nullable: true, ordinal: 10 }),
        column('index_memos', 'memo', 'varchar', {
            length: 250, charset: 'utf8mb4', collation: 'utf8mb4_general_ci'
        }),
        column('markets', 'coin1_id', 'bigint', { unsigned: true, default: '0', ordinal: 21 }),
        column('markets', 'coin2_id', 'bigint', { unsigned: true, default: '0', ordinal: 22 })
    ]
    for (const [table, name] of [
        ['cross_chain_calls', 'target_contract_index'], ['cross_chain_calls', 'gas_limit'],
        ['cross_chain_calls', 'effective_time'], ['cross_chain_matches', 'snapshot_block'],
        ['cross_chain_matches', 'a_action_index'], ['cross_chain_matches', 'b_action_index'],
        ['cross_chain_matches', 'effective_time'], ['capability_snapshots', 'snapshot_block']
    ]) columns.push(column(table, name, 'bigint', { unsigned: true }))
    for (const table of ['price_snapshots', 'cross_chain_matches', 'capability_snapshots', 'state_checkpoints'])
        columns.push(column(table, 'id', 'bigint', { unsigned: true, autoIncrement: true, ordinal: 1 }))
    for (const [table, name, dataType, length] of [
        ['contracts', 'code', 'mediumtext'], ['deploy_chunks', 'code_part', 'mediumtext'],
        ['deposits', 'amount', 'varchar', 250], ['withdrawals', 'amount', 'varchar', 250],
        ['stakes', 'amount', 'varchar', 250], ['unstakes', 'amount', 'varchar', 250],
        ['contract_stakes', 'amount', 'varchar', 250], ['contract_unstakes', 'amount', 'varchar', 250],
        ['reward_claims', 'amount', 'varchar', 250], ['gated_files', 'gate_ticker', 'varchar', 250],
        ['attests', 'provider_id', 'varchar', 32]
    ]) columns.push(column(table, name, dataType, { length, charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }))

    const indexes = [
        ...index('balances', 'addr_tick', ['address_id', 'tick_id'], 0),
        ...index('index_addresses', 'address', ['address'], 0),
        ...index('contract_state', 'idx_latest_bin', ['contract_index', 'state_key_bin', 'id'], 1),
        ...index('markets', 'uq_markets_pair', ['tick1_id', 'tick2_id'], 0),
        ...index('state_checkpoints', 'uq_chain_seq', ['chain', 'network', 'checkpoint_seq'], 0),
        ...index('validator_rewards', 'derive_block_index', ['derive_block_index'], 1),
        ...index('validator_rewards', 'reward_unique',
            ['source_id', 'signing_pubkey_id', 'reward_type', 'round_reference', 'round_qualifier'], 0)
    ]
    const tables = [{ table_schema: DATABASE, table_name: 'sweeps', engine: 'InnoDB', table_collation: 'utf8mb3_general_ci', table_type: 'BASE TABLE' }]
    for (const table of BRIDGE_TABLES) {
        tables.push({ table_schema: DATABASE, table_name: table, engine: 'InnoDB', table_collation: 'utf8mb3_general_ci', table_type: 'BASE TABLE' })
    }
    return { columns, indexes, tables, unsatisfiedData: false }
}

function unsatisfiedSchemaModel() {
    return {
        columns: [],
        indexes: [],
        tables: [{
            table_schema: DATABASE,
            table_name: 'contract_balances',
            engine: 'InnoDB',
            table_collation: 'utf8mb3_general_ci',
            table_type: 'BASE TABLE'
        }],
        unsatisfiedData: true
    }
}

function attachInformationSchema(db) {
    db.function('LEAST', { varargs: true }, (...values) => Math.min(...values))
    db.function('GREATEST', { varargs: true }, (...values) => Math.max(...values))
    db.exec("ATTACH DATABASE ':memory:' AS information_schema")
    db.exec("ATTACH DATABASE ':memory:' AS `" + DATABASE + "`")
    db.exec(`
        CREATE TABLE information_schema.columns (
            table_schema TEXT, table_name TEXT, column_name TEXT, data_type TEXT,
            is_nullable TEXT, column_default TEXT, extra TEXT, character_maximum_length INTEGER,
            column_type TEXT, ordinal_position INTEGER, character_set_name TEXT,
            collation_name TEXT, generation_expression TEXT
        );
        CREATE TABLE information_schema.statistics (
            table_schema TEXT, table_name TEXT, index_name TEXT, seq_in_index INTEGER,
            column_name TEXT, sub_part INTEGER, index_type TEXT, non_unique INTEGER
        );
        CREATE TABLE information_schema.tables (
            table_schema TEXT, table_name TEXT, engine TEXT, table_collation TEXT, table_type TEXT
        );
    `)
}

function createSchemaTables(db) {
    db.exec(`
        CREATE TABLE \`${DATABASE}\`.schema_migrations (name TEXT);
        CREATE TABLE \`${DATABASE}\`.tokens (tick_id INTEGER, lock_mint_supply INTEGER);
        CREATE TABLE \`${DATABASE}\`.issues (
            tick_id INTEGER, lock_mint_supply TEXT, status_id INTEGER,
            transfer_supply_id INTEGER, action_index INTEGER
        );
        CREATE TABLE \`${DATABASE}\`.index_statuses (id INTEGER, status TEXT);
        CREATE TABLE \`${DATABASE}\`.debits (action_index INTEGER, tick_id INTEGER, address_id INTEGER);
        CREATE TABLE \`${DATABASE}\`.credits (action_index INTEGER, tick_id INTEGER, address_id INTEGER);
        CREATE TABLE \`${DATABASE}\`.fees (action_index INTEGER, destination_id INTEGER);
        CREATE TABLE \`${DATABASE}\`.markets (
            id INTEGER, tick1_id INTEGER, tick2_id INTEGER, coin1_id INTEGER, coin2_id INTEGER
        );
        CREATE TABLE \`${DATABASE}\`.orders (
            action_index INTEGER, get_tick_id INTEGER, give_tick_id INTEGER,
            get_coin_id INTEGER, give_coin_id INTEGER
        );
        CREATE TABLE \`${DATABASE}\`.order_matches (
            action_index INTEGER, get_tick_id INTEGER, give_tick_id INTEGER,
            get_coin_id INTEGER, give_coin_id INTEGER
        );
    `)
}

function insertRows(db, table, rows) {
    if (!rows.length) return
    const names = Object.keys(rows[0])
    const statement = db.prepare('INSERT INTO ' + table + ' (' + names.join(', ') + ') VALUES (' + names.map(() => '?').join(', ') + ')')
    rows.forEach(row => statement.run(...names.map(name => row[name] === undefined ? null : row[name])))
}

function seedUnsatisfiedDataRows(db) {
    db.exec(`
        INSERT INTO \`${DATABASE}\`.tokens VALUES (1, 0);
        INSERT INTO \`${DATABASE}\`.index_statuses VALUES (1, 'valid');
        INSERT INTO \`${DATABASE}\`.issues VALUES (1, '1', 1, NULL, 10);
        INSERT INTO \`${DATABASE}\`.debits VALUES (10, 1, 100);
        INSERT INTO \`${DATABASE}\`.credits VALUES (10, 1, 200);
    `)
}

function createSchemaDatabase(ledger, model) {
    const db = new DatabaseSync(':memory:')
    attachInformationSchema(db)
    createSchemaTables(db)
    insertRows(db, 'information_schema.columns', model.columns)
    insertRows(db, 'information_schema.statistics', model.indexes)
    insertRows(db, 'information_schema.tables', model.tables)
    insertRows(db, '`' + DATABASE + '`.schema_migrations', [...ledger].map(name => ({ name })))
    if (model.unsatisfiedData) seedUnsatisfiedDataRows(db)
    return db
}

function sqliteSql(sql) {
    return sql
        .replace(/TRIM\(BOTH '''' FROM column_default\)/g, "trim(column_default, '''')")
        .replace(/ <=> /g, ' IS ')
}

function generatedFacts(sql) {
    const matches = [...sql.matchAll(/SELECT '([^']+\.sql)' AS name WHERE /g)]
    return matches.map((match, index) => {
        const end = matches[index + 1] ? matches[index + 1].index : sql.length
        return {
            name: match[1],
            statement: sql.slice(match.index, end).replace(/\s+UNION\s*$/, '')
        }
    })
}

function runnerFor(ledger, model) {
    const queries = []
    const evaluated = []
    const satisfied = []
    const db = createSchemaDatabase(ledger, model)
    const runner = async sql => {
        queries.push(sql)
        if (/TABLE_NAME = 'schema_migrations'/.test(sql)) return '1'
        if (/^SELECT COUNT\(\*\)/.test(sql)) return '100'
        const probe = createSchemaDatabase(new Set(), model)
        for (const fact of generatedFacts(sql)) {
            evaluated.push(fact.name)
            satisfied.push(...probe.prepare(sqliteSql(fact.statement)).all().map(row => row.name))
        }
        probe.close()
        return db.prepare(sqliteSql(sql)).all().map(row => row.name).join('\n')
    }
    return { runner, queries, evaluated, satisfied }
}

async function readResetLedger(model) {
    const ledger = resetLedger()
    const db = runnerFor(ledger, model)
    const result = await readAppliedMigrations(
        { database: DATABASE, coin: 'bitcoin', network: 'mainnet' },
        { runner: db.runner })
    return {
        result,
        ledger,
        queries: db.queries,
        evaluated: db.evaluated,
        satisfied: db.satisfied
    }
}

function queryInformationSchema(model, sql, params = []) {
    const db = createSchemaDatabase(new Set(), model)
    try {
        return db.prepare(sqliteSql(sql)).all(...params)
    } finally {
        db.close()
    }
}

module.exports = {
    DATABASE,
    V0190_MIGRATIONS,
    PRECONDITION_MIGRATIONS,
    SYNTHESIZED_ROWS,
    resetLedger,
    resetSchemaModel,
    unsatisfiedSchemaModel,
    readResetLedger,
    queryInformationSchema
}
