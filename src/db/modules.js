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
 * XChain Node - the module registry table
 *
 * Every query against the per-stack `modules` registry, plus the DDL that
 * creates it. Installed onto the store's prototype by db/index.js, so a caller
 * still writes `store.getModuleContainer(...)` and cannot tell the file split
 * happened.
 *
 ********************************************************************/

const crypto = require('crypto')
const { NODE_PREFIX, DEFAULT_NODE_PREFIX } = require('../config')
const { assertSafeDbIdentifier } = require('../utils/sql_safety')
const { getLogger } = require('../observability/logger');
const logger = getLogger();

/*
 * Registry table, scoped to THIS stack.
 *
 * The row key is (module, coin, network) and carries no stack identity, while
 * the database name is the fixed xchain_node. In bundled-DB mode each
 * NODE_PREFIX gets its own MariaDB container, so the registries never met. In
 * external-DB mode (XCHAIN_NODE_EXTERNAL_DB=1) two co-located stacks, a layout
 * the host-port guard, the docker networks, the utxo volume and the explorer
 * port override are all built for, point at ONE host-native MariaDB and share
 * the table. Same coin and network on both stacks means the same key on both, so
 * each stack's upsert overwrote the other's container_id, and DiscoveryService's
 * orphan purge (which classifies containers by its OWN prefix and deletes every
 * row it did not see) deleted the other stack's live rows outright.
 *
 * The default prefix keeps the bare `modules` name, so an existing install
 * migrates nothing. A renamed prefix starts on an empty table, which is safe
 * because the registry is DERIVED state: precheck runs scanAndRegisterModules
 * against `docker ps -a` on every command, immediately after createDatabase, so
 * the first command after the change repopulates it.
 *
 * THE NAME MUST BE INJECTIVE IN THE PREFIX, and the sanitized head alone is not.
 * NODE_PREFIX admits `-`, `.` and `_` (constants.js), and the sanitizer folds the
 * first two onto the third, so `stack-a`, `stack.a` and `stack_a` all named ONE
 * table; truncation collapsed any two prefixes sharing a long head the same way.
 * Two stacks that collide there are back to sharing a registry, which is the
 * overwrite-and-purge failure this scoping exists to prevent (uuid:c8e46a8b). So
 * the readable head is shortened to make room for a digest of the RAW prefix:
 * distinct prefixes now differ in the digest even when the head is identical.
 * 8 + 30 + 1 + 12 = 51 characters, inside MariaDB's 64-character identifier limit.
 */
const MODULES_TABLE = NODE_PREFIX === DEFAULT_NODE_PREFIX
    ? 'modules'
    : assertSafeDbIdentifier(
        'modules_' + NODE_PREFIX.replace(/[^a-z0-9_]/g, '_').substring(0, 30)
            + '_' + crypto.createHash('sha256').update(NODE_PREFIX).digest('hex').substring(0, 12),
        'registry table name')

// The DDL for the table above. It is created on every open rather than
// migrated, because the registry is derived state that precheck repopulates.
const CREATE_MODULES_TABLE_SQL =
    `CREATE TABLE IF NOT EXISTS ${MODULES_TABLE} (
                    module       VARCHAR(64)  NOT NULL,
                    coin         VARCHAR(32)  NOT NULL DEFAULT '',
                    network      VARCHAR(32)  NOT NULL DEFAULT '',
                    container_id VARCHAR(128) NOT NULL,
                    created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                    updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (module, coin, network)
                )`

const modulesMixin = {
    async getAllModuleContainers(coin, network) {
        if (!this.pool) return []

        let rows
        if (coin == null && network == null) {
            rows = await this.pool.query(
                `SELECT module, coin, network, container_id FROM ${MODULES_TABLE}`
            )
        } else {
            rows = await this.pool.query(
                `SELECT module, coin, network, container_id FROM ${MODULES_TABLE}
                 WHERE (coin = ? AND network = ?) OR (coin = '' AND network = '')`,
                [coin || '', network || '']
            )
        }

        return rows.map(r => ({
            module: r.module,
            network: r.network,
            coin: r.coin,
            container_id: r.container_id
        }))
    },

    async setModuleContainer(module, coin, network, containerId) {
        if (!this.pool) return false
        try {
            await this.pool.query(
                `INSERT INTO ${MODULES_TABLE} (module, coin, network, container_id)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE container_id = VALUES(container_id)`,
                [module, coin || '', network || '', containerId]
            )
            return true
        } catch (err) {
            return false
        }
    },

    async getModuleContainer(module, coin, network) {
        if (!this.pool) return null
        try {
            const rows = await this.pool.query(
                `SELECT container_id FROM ${MODULES_TABLE}
                 WHERE module = ? AND coin = ? AND network = ?`,
                [module, coin || '', network || '']
            )
            if (rows.length === 0) return null
            return rows[0].container_id
        } catch (err) {
            return null
        }
    },

    // Answer the same question as getModuleContainer, but only from evidence.
    // getModuleContainer returns null for a genuine zero-row miss AND for every
    // SQL error AND for an unopened pool, so a registry blip is indistinguishable
    // from "not installed". A caller that acts DESTRUCTIVELY on that answer then
    // skips stopping a live service and wipes its store underneath it
    // (uuid:846cc40d). Here the pool is asserted and the query error propagates,
    // so only an empty result set means absent.
    async getModuleContainerStrict(module, coin, network) {
        this.assertReady(`the ${module} registry lookup`)
        const rows = await this.pool.query(
            `SELECT container_id FROM ${MODULES_TABLE}
             WHERE module = ? AND coin = ? AND network = ?`,
            [module, coin || '', network || '']
        )
        if (rows.length === 0) return null
        return rows[0].container_id
    },

    async deleteModuleContainer(module, coin, network) {
        if (!this.pool) return false
        try {
            const rows = await this.pool.query(
                `SELECT container_id FROM ${MODULES_TABLE}
                 WHERE module = ? AND coin = ? AND network = ?`,
                [module, coin || '', network || '']
            )
            await this.pool.query(
                `DELETE FROM ${MODULES_TABLE}
                 WHERE module = ? AND coin = ? AND network = ?`,
                [module, coin || '', network || '']
            )
            if (rows.length > 0) {
                return rows[0].container_id
            }
            return true
        } catch (err) {
            logger.info(err)
            return false
        }
    },

    async getModuleCount() {
        if (!this.pool) return 0
        const rows = await this.pool.query(`SELECT COUNT(*) AS cnt FROM ${MODULES_TABLE}`)
        return Number(rows[0].cnt)
    }
}

module.exports = { MODULES_TABLE, CREATE_MODULES_TABLE_SQL, modulesMixin }
