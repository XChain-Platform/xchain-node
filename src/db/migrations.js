/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Node - a service's migration ledger
 *
 * One read against the `schema_migrations` table every XChain service keeps and,
 * for indexers, the live schema and data facts represented by historical manual
 * migrations. It answers which migrations a database has applied or already
 * embodies without rewriting migration history.
 *
 ********************************************************************/

// Derive satisfied indexer rows without mutating the ledger; decoders keep their plain query.
function appliedMigrationsSql(database, ledgerTable) {
    const ledger = 'SELECT name FROM `' + database + '`.' + ledgerTable
    if (!/_Indexer$/.test(database)) return ledger
    return ledger + ' UNION ' + indexerSatisfiedMigrationsSql(database).join(' UNION ')
}
function exactIndexSql(database, table, index, columns, nonUnique) {
    const members = columns.map((column, offset) =>
        '(seq_in_index = ' + (offset + 1) + " AND column_name = '" + column + "' AND sub_part IS NULL)"
    ).join(' OR ')
    return '(SELECT COUNT(1) = ' + columns.length +
        ' AND COALESCE(SUM(CASE WHEN ' + members + ' THEN 1 ELSE 0 END), 0) = ' + columns.length +
        ' FROM information_schema.statistics' +
        " WHERE table_schema = '" + database + "'" +
        " AND table_name = '" + table + "'" +
        " AND index_name = '" + index + "'" +
        " AND index_type = 'BTREE'" +
        ' AND non_unique = ' + nonUnique + ')'
}
const CHARSET_TYPES = new Set(['char', 'varchar', 'text', 'mediumtext'])
const CHARSET_UTF8_ALIASES = ['utf8', 'utf8mb3']
const COLLATION_UTF8_ALIASES = ['utf8_general_ci', 'utf8mb3_general_ci']
function inSql(column, value) {
    const values = Array.isArray(value) ? value : [value]
    return column + ' IN (' + values.map(v => "'" + v + "'").join(', ') + ')'
}
function columnDefaultSql(value) {
    if (value === 'CURRENT_TIMESTAMP') return "REPLACE(LOWER(column_default), '()', '') = 'current_timestamp'"
    return "TRIM(BOTH '''' FROM column_default) = '" + value + "'"
}
function noDefaultSql(nullable) { return nullable ? "(column_default IS NULL OR column_default = 'NULL')" : 'column_default IS NULL' }

// Match every column fact, including absent defaults and the exact EXTRA value.
function columnSql(database, table, column, dataType, opts = {}) {
    const conditions = [
        "table_schema = '" + database + "'",
        "table_name = '" + table + "'",
        "column_name = '" + column + "'",
        "data_type = '" + dataType + "'",
        "is_nullable = '" + (opts.nullable ? 'YES' : 'NO') + "'",
        opts.default !== undefined ? columnDefaultSql(opts.default) : noDefaultSql(opts.nullable),
        "extra = '" + (opts.autoIncrement ? 'auto_increment' : '') + "'"
    ]
    if (opts.length !== undefined) conditions.push('character_maximum_length = ' + opts.length)
    if (opts.unsigned === true) conditions.push("column_type LIKE '%unsigned%'")
    if (opts.unsigned === false) conditions.push("column_type NOT LIKE '%unsigned%'")
    if (opts.ordinal !== undefined) conditions.push('ordinal_position = ' + opts.ordinal)
    const charset = opts.charset || (CHARSET_TYPES.has(dataType) ? CHARSET_UTF8_ALIASES : null)
    const collation = opts.collation || (CHARSET_TYPES.has(dataType) ? COLLATION_UTF8_ALIASES : null)
    if (charset) conditions.push(inSql('character_set_name', charset))
    if (collation) conditions.push(inSql('collation_name', collation))
    return '(SELECT COUNT(1) FROM information_schema.columns WHERE ' + conditions.join(' AND ') + ') = 1'
}
function tableShapeSql(database, table, engine, collation) {
    return "(SELECT COUNT(1) FROM information_schema.tables" +
        " WHERE table_schema = '" + database + "' AND table_name = '" + table + "'" +
        " AND engine = '" + engine + "' AND " + inSql('table_collation', collation) + ') = 1'
}
function tableColumnsSql(database, table, columns) {
    const perColumn = columns.map(([name, dataType, opts], index) =>
        columnSql(database, table, name, dataType, Object.assign({ ordinal: index + 1 }, opts))
    ).join(' AND ')
    const total = "(SELECT COUNT(1) FROM information_schema.columns" +
        " WHERE table_schema = '" + database + "' AND table_name = '" + table +
        "') = " + columns.length
    return perColumn + ' AND ' + total
}
function tableIndexesSql(database, table, indexes) {
    const perIndex = indexes.map(([name, columns, nonUnique]) => exactIndexSql(database, table, name, columns, nonUnique)).join(' AND ')
    const total = "(SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics" +
        " WHERE table_schema = '" + database + "' AND table_name = '" + table +
        "') = " + indexes.length
    return perIndex + ' AND ' + total
}
function migrationFactSql(name, predicate) {
    return "SELECT '" + name + "' AS name WHERE " + predicate
}
function stateKeyBinSatisfiedSql(database) {
    const column = 'EXISTS (SELECT 1 FROM information_schema.columns child' +
        ' JOIN information_schema.columns parent' +
        ' ON parent.table_schema = child.table_schema' +
        ' AND parent.table_name = child.table_name' +
        " AND parent.column_name = 'state_key'" +
        ' AND parent.ordinal_position + 1 = child.ordinal_position' +
        " WHERE child.table_schema = '" + database + "'" +
        " AND child.table_name = 'contract_state'" +
        " AND child.column_name = 'state_key_bin'" +
        " AND child.data_type = 'varchar'" +
        ' AND child.character_maximum_length = 256' +
        " AND child.character_set_name IN ('utf8', 'utf8mb3')" +
        " AND child.collation_name IN ('utf8_bin', 'utf8mb3_bin')" +
        " AND child.extra LIKE '%VIRTUAL GENERATED%'" +
        " AND child.generation_expression = '`state_key`')"
    const index = exactIndexSql(database, 'contract_state', 'idx_latest_bin',
        ['contract_index', 'state_key_bin', 'id'], 1)
    return column + ' AND ' + index
}
function mirrorIdsAutoIncrementSatisfiedSql(database) {
    const tables = "'price_snapshots', 'cross_chain_matches', 'capability_snapshots', 'state_checkpoints'"
    return `(SELECT COUNT(DISTINCT table_name) FROM information_schema.columns WHERE table_schema = '${database}'` +
        ` AND column_name = 'id' AND data_type = 'bigint' AND extra LIKE '%auto_increment%' AND table_name IN (${tables})) = 4`
}
function mirrorTwinWidthsSatisfiedSql(database) {
    return '(SELECT COUNT(1) FROM information_schema.columns' +
        " WHERE table_schema = '" + database + "'" +
        " AND data_type = 'bigint'" +
        " AND column_type LIKE '%unsigned%'" +
        " AND is_nullable = 'NO'" +
        " AND (table_name, column_name) IN (" +
        "('cross_chain_calls', 'target_contract_index'),('cross_chain_calls', 'gas_limit')," +
        "('cross_chain_calls', 'effective_time'),('cross_chain_matches', 'snapshot_block')," +
        "('cross_chain_matches', 'a_action_index'),('cross_chain_matches', 'b_action_index')," +
        "('cross_chain_matches', 'effective_time')," +
        "('capability_snapshots', 'snapshot_block'))) = 8"
}
function tokenLockBackfillSatisfiedSql(database) {
    return 'NOT EXISTS (SELECT 1 FROM `' + database + '`.tokens t' +
        ' WHERE t.lock_mint_supply <> 1' +
        ' AND EXISTS (SELECT 1 FROM `' + database + '`.issues i' +
        ' INNER JOIN `' + database + '`.index_statuses s ON s.id = i.status_id' +
        ' WHERE i.tick_id = t.tick_id' +
        " AND s.status = 'valid' AND i.lock_mint_supply = '1'))"
}
function issueTransferSupplyBackfillSatisfiedSql(database) {
    return 'NOT EXISTS (SELECT 1 FROM `' + database + '`.issues i' +
        ' WHERE i.transfer_supply_id IS NULL AND i.tick_id IS NOT NULL' +
        ' AND EXISTS (SELECT 1 FROM `' + database + '`.debits d' +
        ' WHERE d.action_index = i.action_index AND d.tick_id = i.tick_id)' +
        ' AND (SELECT COUNT(1) FROM `' + database + '`.credits c' +
        ' WHERE c.action_index = i.action_index AND c.tick_id = i.tick_id' +
        ' AND c.address_id IS NOT NULL' +
        ' AND NOT EXISTS (SELECT 1 FROM `' + database + '`.debits d2' +
        ' WHERE d2.action_index = i.action_index AND d2.tick_id = i.tick_id' +
        ' AND d2.address_id = c.address_id)' +
        ' AND NOT EXISTS (SELECT 1 FROM `' + database + '`.fees f' +
        ' WHERE f.action_index = i.action_index AND f.destination_id = c.address_id)) = 1)'
}
function rawWireFieldsSatisfiedSql(database) {
    return '(SELECT COUNT(1) FROM information_schema.columns' +
        " WHERE table_schema = '" + database + "'" +
        " AND character_set_name = 'utf8mb4'" +
        " AND collation_name = 'utf8mb4_general_ci'" +
        " AND is_nullable = 'NO' AND (" +
        "((table_name, column_name) IN (('contracts', 'code'), ('deploy_chunks', 'code_part'))" +
        " AND data_type = 'mediumtext') OR " +
        "((table_name, column_name) IN (('deposits', 'amount'), ('withdrawals', 'amount')," +
        "('stakes', 'amount'), ('unstakes', 'amount'), ('contract_stakes', 'amount')," +
        "('contract_unstakes', 'amount'), ('reward_claims', 'amount'), ('gated_files', 'gate_ticker'))" +
        " AND data_type = 'varchar' AND character_maximum_length = 250) OR " +
        "(table_name = 'attests' AND column_name = 'provider_id'" +
        " AND data_type = 'varchar' AND character_maximum_length = 32))) = 11"
}
const ADMIT_BLOCK_COLUMNS = ['btc', 'ltc', 'doge'].map(chain =>
    ['admit_block_' + chain, 'bigint', { unsigned: true, nullable: true }])
const SIGNED_ROW_TAIL_COLUMNS = [
    ['finalizing_view', 'int', { unsigned: false, default: '0' }], ['validator_signatures', 'text', {}],
    ['status', 'varchar', { length: 20, default: 'finalized' }], ['push_generation', 'bigint', { unsigned: false, default: '0' }],
    ['btc_chain_id', 'char', { length: 64, nullable: true }],
    ['created_at', 'timestamp', { nullable: true, default: 'CURRENT_TIMESTAMP' }]
]
// Every column and index in 2026-09-12-bridge-tables.sql's end state.
const BRIDGE_TABLE_SHAPES = {
    bridge_transfers: {
        admitBlockColumns: true,
        columns: [
            ['id', 'bigint', { unsigned: true, autoIncrement: true }], ['transfer_id', 'char', { length: 64 }],
            ['snapshot_block', 'bigint', { unsigned: true }], ['network', 'varchar', { length: 20 }],
            ['src_chain', 'varchar', { length: 10 }], ['src_action_index', 'bigint', { unsigned: true }],
            ['src_address', 'varchar', { length: 255 }], ['dest_chain', 'varchar', { length: 10 }],
            ['dest_address', 'varchar', { length: 255 }], ['tick', 'varchar', { length: 250 }],
            ['decimals', 'tinyint', { unsigned: true }], ['amount', 'varchar', { length: 250 }],
            ['effective_time', 'bigint', { unsigned: true }],
            ...SIGNED_ROW_TAIL_COLUMNS
        ],
        indexes: [
            ['PRIMARY', ['id'], 0], ['uq_transfer_id', ['transfer_id'], 0],
            ['idx_snapshot_block', ['snapshot_block'], 1], ['idx_src_ref', ['src_chain', 'src_action_index'], 1],
            ['idx_dest_chain', ['dest_chain'], 1], ['idx_effective', ['effective_time'], 1],
            ['idx_status', ['status'], 1], ['idx_tick', ['tick'], 1]
        ]
    },
    bridge_settlements: {
        columns: [
            ['action_index', 'bigint', { unsigned: true }], ['transfer_id', 'char', { length: 64 }],
            ['kind', 'varchar', { length: 10, default: 'transfer' }], ['block_index', 'bigint', { unsigned: true }],
            ['src_chain', 'varchar', { length: 10, nullable: true }], ['src_action_index', 'bigint', { unsigned: true, nullable: true }],
            ['dest_chain', 'varchar', { length: 10, nullable: true }], ['dest_address', 'varchar', { length: 255, nullable: true }],
            ['tick', 'varchar', { length: 250, nullable: true }]
        ],
        indexes: [
            ['uq_transfer_kind', ['transfer_id', 'kind'], 0], ['idx_action_index', ['action_index'], 1],
            ['idx_block_index', ['block_index'], 1],
            ['idx_src_ref', ['src_chain', 'src_action_index'], 1]
        ]
    },
    policy_snapshots: {
        admitBlockColumns: true,
        columns: [
            ['id', 'bigint', { unsigned: true, autoIncrement: true }], ['snapshot_id', 'char', { length: 64 }],
            ['snapshot_block', 'bigint', { unsigned: true }], ['origin_chain', 'varchar', { length: 10 }],
            ['tick', 'varchar', { length: 250 }], ['policy_seq', 'bigint', { unsigned: true }],
            ['origin_block', 'bigint', { unsigned: true }], ['policy_hash', 'char', { length: 64 }],
            ['allow_list', 'mediumtext', { nullable: true }], ['block_list', 'mediumtext', { nullable: true }],
            ['sleeping', 'tinyint', { unsigned: false, default: '0' }], ['effective_time', 'bigint', { unsigned: true }],
            ['network', 'varchar', { length: 20 }],
            ...SIGNED_ROW_TAIL_COLUMNS
        ],
        indexes: [
            ['PRIMARY', ['id'], 0], ['uq_policy_seq', ['network', 'origin_chain', 'tick', 'policy_seq'], 0],
            ['uq_snapshot_id', ['snapshot_id'], 0], ['idx_effective', ['effective_time'], 1],
            ['idx_origin_tick', ['origin_chain', 'tick'], 1]
        ]
    },
    xbridges: {
        columns: [
            ['action_index', 'bigint', { unsigned: true }], ['version', 'tinyint', { unsigned: true, nullable: true }],
            ['tick_id', 'bigint', { unsigned: true, nullable: true }], ['dest_chain', 'varchar', { length: 10, nullable: true }],
            ['dest_address_id', 'bigint', { unsigned: true, nullable: true }],
            ['amount', 'varchar', { length: 250, nullable: true, charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }],
            ['decimals', 'tinyint', { unsigned: true, nullable: true }], ['min_depth', 'bigint', { unsigned: true, nullable: true }],
            ['memo_id', 'bigint', { unsigned: true, nullable: true }], ['status_id', 'bigint', { unsigned: true, nullable: true }],
            ['block_index', 'bigint', { unsigned: true }]
        ],
        indexes: [
            ['uq_action_index', ['action_index'], 0], ['idx_tick_id', ['tick_id'], 1],
            ['idx_dest_address_id', ['dest_address_id'], 1], ['idx_status_id', ['status_id'], 1],
            ['idx_block_index', ['block_index'], 1],
            ['idx_version_block', ['version', 'block_index'], 1]
        ]
    }
}
function bridgeTableColumnsSql(database, table, { columns, admitBlockColumns }) {
    const base = tableColumnsSql(database, table, columns)
    if (!admitBlockColumns) return base
    const tailStart = columns.length - SIGNED_ROW_TAIL_COLUMNS.length
    const withAdmit = columns.slice(0, tailStart).concat(ADMIT_BLOCK_COLUMNS, columns.slice(tailStart))
    return '((' + base + ') OR (' + tableColumnsSql(database, table, withAdmit) + '))'
}
function bridgeTablesSatisfiedSql(database) {
    return Object.entries(BRIDGE_TABLE_SHAPES).map(([table, shape]) => [
        bridgeTableColumnsSql(database, table, shape),
        tableIndexesSql(database, table, shape.indexes),
        tableShapeSql(database, table, 'InnoDB', COLLATION_UTF8_ALIASES)
    ].join(' AND ')).join(' AND ')
}
// The indexer's own baseline test: the file is CREATE TABLE IF NOT EXISTS only, so with both
// tables present running it changes nothing and no shape check could be satisfied by applying it.
function listShareTablesSatisfiedSql(database) {
    return "(SELECT COUNT(1) FROM information_schema.tables WHERE table_schema = '" + database + "'" +
        " AND table_name IN ('list_snapshots', 'list_share_mirrors')) = 2"
}
// Width alone, as the indexer baselines it: the file only widens oracle_prices.tick to 250.
function oraclePricesTickWidthSatisfiedSql(database) {
    return "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '" + database + "'" +
        " AND table_name = 'oracle_prices' AND column_name = 'tick' AND character_maximum_length >= 250)"
}
function pubkeyWidthSatisfiedSql(database) { return columnSql(database, 'pubkeys', 'pubkey', 'varchar', { length: 130, ordinal: 2 }) }

function validatorRewardsDeriveBlockIndexSatisfiedSql(database) {
    return [
        columnSql(database, 'validator_rewards', 'derive_block_index', 'bigint', { unsigned: true, nullable: true, ordinal: 9 }),
        exactIndexSql(database, 'validator_rewards', 'derive_block_index', ['derive_block_index'], 1),
        columnSql(database, 'anchor_reward_reconcile_log', 'reward_derive_block_index', 'bigint', { unsigned: true, nullable: true, ordinal: 10 })
    ].join(' AND ')
}

function validatorRewardsRoundQualifierSatisfiedSql(database) {
    return [
        columnSql(database, 'validator_rewards', 'round_qualifier', 'bigint', { unsigned: true, default: '0', ordinal: 6 }),
        exactIndexSql(database, 'validator_rewards', 'reward_unique',
            ['source_id', 'signing_pubkey_id', 'reward_type', 'round_reference', 'round_qualifier'], 0),
        columnSql(database, 'anchor_reward_reconcile_log', 'round_qualifier', 'bigint', { unsigned: true, default: '0', ordinal: 5 })
    ].join(' AND ')
}

function marketsNativeCoinSideSatisfiedSql(database) {
    const db = '`' + database + '`.'
    const pairKey = (a, b) =>
        'LEAST(COALESCE(' + a + ', 0), COALESCE(' + b + ', 0)) AS lo, ' +
        'GREATEST(COALESCE(' + a + ', 0), COALESCE(' + b + ', 0)) AS hi'
    const nativeSide = (table, alias) =>
        'SELECT ' + alias + '.action_index * 2' + (table === 'order_matches' ? ' + 1' : '') + ' AS ord_key, ' +
        'COALESCE(' + alias + '.get_tick_id, 0) AS tick1_id, ' +
        'COALESCE(' + alias + '.give_tick_id, 0) AS tick2_id, ' +
        alias + '.get_coin_id AS coin1_id, ' + alias + '.give_coin_id AS coin2_id, ' +
        pairKey(alias + '.get_tick_id', alias + '.give_tick_id') +
        ' FROM ' + db + table + ' ' + alias +
        ' WHERE ' + alias + '.give_coin_id = ' + alias + '.get_coin_id' +
        ' AND (' + alias + '.get_tick_id IS NULL OR ' + alias + '.give_tick_id IS NULL)'

    const markets = '(SELECT m.id, m.tick1_id, m.tick2_id, coin1_id, coin2_id' +
        ' FROM (SELECT NULL AS coin1_id, NULL AS coin2_id) fallback' +
        ' NATURAL RIGHT JOIN ' + db + 'markets m)'

    const columns = [
        columnSql(database, 'markets', 'coin1_id', 'bigint', { unsigned: true, default: '0', ordinal: 21 }),
        columnSql(database, 'markets', 'coin2_id', 'bigint', { unsigned: true, default: '0', ordinal: 22 })
    ].join(' AND ')

    const noNullSide = 'NOT EXISTS (SELECT 1 FROM ' + db + 'markets' +
        ' WHERE tick1_id IS NULL OR tick2_id IS NULL)'

    const noDuplicatePair = 'NOT EXISTS (SELECT 1 FROM ' + db + 'markets' +
        ' GROUP BY LEAST(COALESCE(tick1_id, 0), COALESCE(tick2_id, 0)),' +
        ' GREATEST(COALESCE(tick1_id, 0), COALESCE(tick2_id, 0))' +
        ' HAVING COUNT(1) > 1)'

    const nativeRows = nativeSide('orders', 'o') + ' UNION ALL ' + nativeSide('order_matches', 'om')
    const everyNativePairListed = 'NOT EXISTS (SELECT 1 FROM (' +
        'SELECT n.*, ROW_NUMBER() OVER (PARTITION BY n.lo, n.hi ORDER BY n.ord_key) AS pair_order' +
        ' FROM (' + nativeRows + ') n) f WHERE f.pair_order = 1' +
        ' AND NOT EXISTS (SELECT 1 FROM ' + markets + ' m' +
        ' WHERE m.tick1_id = f.tick1_id AND m.tick2_id = f.tick2_id' +
        ' AND m.coin1_id <=> f.coin1_id AND m.coin2_id <=> f.coin2_id))'

    const orderLabels = 'NOT EXISTS (SELECT 1 FROM ' + markets + ' m JOIN (' +
        'SELECT ' + pairKey('o.get_tick_id', 'o.give_tick_id') +
        ', MIN(o.get_coin_id) AS coin1_id, MIN(o.give_coin_id) AS coin2_id' +
        ' FROM ' + db + 'orders o WHERE o.give_coin_id = o.get_coin_id' +
        ' GROUP BY LEAST(COALESCE(o.get_tick_id, 0), COALESCE(o.give_tick_id, 0)),' +
        ' GREATEST(COALESCE(o.get_tick_id, 0), COALESCE(o.give_tick_id, 0))) labels' +
        ' ON (m.tick1_id = labels.lo AND m.tick2_id = labels.hi)' +
        ' OR (m.tick1_id = labels.hi AND m.tick2_id = labels.lo)' +
        ' WHERE NOT (m.coin1_id <=> labels.coin1_id)' +
        ' OR NOT (m.coin2_id <=> labels.coin2_id))'

    return [columns, noNullSide, noDuplicatePair, everyNativePairListed, orderLabels].join(' AND ')
}

function indexerSatisfiedMigrationsSql(database) {
    const stateKey = stateKeyBinSatisfiedSql(database)
    return [
        migrationFactSql('2026-05-30-balances-composite-index.sql',
            exactIndexSql(database, 'balances', 'addr_tick', ['address_id', 'tick_id'], 0) +
            " AND NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema = '" + database +
            "' AND table_name = 'balances' AND index_name = 'address_id')"),
        migrationFactSql('2026-06-03-unique-full-column-index-addresses.sql',
            exactIndexSql(database, 'index_addresses', 'address', ['address'], 0)),
        migrationFactSql('2026-06-10-mirror-id-autoincrement-repair.sql',
            mirrorIdsAutoIncrementSatisfiedSql(database)),
        migrationFactSql('2026-06-16-drop-orphaned-contract-balances.sql',
            "NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = '" + database +
            "' AND table_name = 'contract_balances')"),
        migrationFactSql('2026-07-10-contract-state-bin-key-index.sql', stateKey),
        migrationFactSql('2026-07-15-markets-dedup-unique-pair.sql',
            exactIndexSql(database, 'markets', 'uq_markets_pair', ['tick1_id', 'tick2_id'], 0)),
        migrationFactSql('2026-07-15-sweeps-drop-legacy-escrows-column.sql',
            "EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = '" + database +
            "' AND table_name = 'sweeps' AND table_type = 'BASE TABLE')" +
            " AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '" + database +
            "' AND table_name = 'sweeps' AND column_name = 'escrows')"),
        migrationFactSql('2026-07-16-mirror-twin-bigint-unsigned-align.sql', mirrorTwinWidthsSatisfiedSql(database)),
        migrationFactSql('2026-07-16-reposition-state-key-bin.sql', stateKey),
        migrationFactSql('2026-07-24-pubkeys-widen-uncompressed.sql', pubkeyWidthSatisfiedSql(database)),
        migrationFactSql('2026-07-26-tokens-backfill-lock-mint-supply.sql', tokenLockBackfillSatisfiedSql(database)),
        migrationFactSql('2026-07-29-state-checkpoints-uq-chain-seq.sql',
            exactIndexSql(database, 'state_checkpoints', 'uq_chain_seq',
                ['chain', 'network', 'checkpoint_seq'], 0) +
            " AND NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema = '" + database +
            "' AND table_name = 'state_checkpoints' AND index_name = 'uq_chain_block_seq')"),
        migrationFactSql('2026-08-12-validator-rewards-derive-block-index.sql', validatorRewardsDeriveBlockIndexSatisfiedSql(database)),
        migrationFactSql('2026-08-19-utf8mb4-index-memos-memo.sql',
            "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = '" + database +
            "' AND table_name = 'index_memos' AND column_name = 'memo' AND data_type = 'varchar'" +
            " AND character_maximum_length = 250 AND character_set_name = 'utf8mb4'" +
            " AND collation_name = 'utf8mb4_general_ci' AND is_nullable = 'NO')"),
        migrationFactSql('2026-08-24-validator-rewards-round-qualifier.sql', validatorRewardsRoundQualifierSatisfiedSql(database)),
        migrationFactSql('2026-09-02-issues-backfill-transfer-supply-id.sql', issueTransferSupplyBackfillSatisfiedSql(database)),
        migrationFactSql('2026-09-02-utf8mb4-raw-wire-fields-not-null.sql', rawWireFieldsSatisfiedSql(database)),
        migrationFactSql('2026-09-10-markets-native-coin-side.sql', marketsNativeCoinSideSatisfiedSql(database)),
        migrationFactSql('2026-09-12-bridge-tables.sql', bridgeTablesSatisfiedSql(database)),
        migrationFactSql('2026-09-22-oracle-prices-widen-tick.sql', oraclePricesTickWidthSatisfiedSql(database)),
        migrationFactSql('2026-09-30-list-share-tables.sql', listShareTablesSatisfiedSql(database))
    ]
}

module.exports = { appliedMigrationsSql }
