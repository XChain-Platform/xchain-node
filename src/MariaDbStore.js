/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Node - MariaDbStore Class
 *
 * Drop-in replacement for LevelUpStore. Persists module→container ID
 * mappings in a shared MariaDB instance (xchain_node.modules table).
 *
 ********************************************************************/

const mariadb = require('mariadb')

class MariaDbStore {
    constructor(config = null) {
        this.config = config
        this.pool = null
    }

    setConfig(config) {
        this.config = config
    }

    async createDatabase(config = null) {
        if (this.pool) return this.pool

        if (config) this.config = config
        if (!this.config) {
            throw new Error("MariaDbStore needs config (host, port, user, password, database) before createDatabase")
        }

        try {
            this.pool = mariadb.createPool({
                host:            this.config.host,
                port:            this.config.port,
                user:            this.config.user,
                password:        this.config.password,
                database:        this.config.database,
                connectionLimit: this.config.connectionLimit || 5
            })
        } catch (err) {
            throw new Error("Couldn't create MariaDB pool: " + err.message)
        }

        let conn
        try {
            conn = await this.pool.getConnection()
            await conn.query(
                `CREATE TABLE IF NOT EXISTS modules (
                    module       VARCHAR(64)  NOT NULL,
                    coin         VARCHAR(32)  NOT NULL DEFAULT '',
                    network      VARCHAR(32)  NOT NULL DEFAULT '',
                    container_id VARCHAR(128) NOT NULL,
                    created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
                    updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (module, coin, network)
                )`
            )
        } catch (err) {
            throw new Error("Couldn't open/create MariaDB database: " + err.message)
        } finally {
            if (conn) conn.release()
        }

        return this.pool
    }

    async close() {
        if (this.pool) {
            await this.pool.end()
            this.pool = null
        }
    }

    async getAllModuleContainers(coin, network) {
        if (!this.pool) return []

        let rows
        if (coin == null && network == null) {
            rows = await this.pool.query(
                'SELECT module, coin, network, container_id FROM modules'
            )
        } else {
            rows = await this.pool.query(
                `SELECT module, coin, network, container_id FROM modules
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
    }

    async insertModuleContainer(module, coin, network, containerId) {
        if (!this.pool) return false
        try {
            await this.pool.query(
                `INSERT INTO modules (module, coin, network, container_id)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE container_id = VALUES(container_id)`,
                [module, coin || '', network || '', containerId]
            )
            return true
        } catch (err) {
            return false
        }
    }

    async getModuleContainer(module, coin, network) {
        if (!this.pool) return null
        try {
            const rows = await this.pool.query(
                `SELECT container_id FROM modules
                 WHERE module = ? AND coin = ? AND network = ?`,
                [module, coin || '', network || '']
            )
            if (rows.length === 0) return null
            return rows[0].container_id
        } catch (err) {
            return null
        }
    }

    async removeModuleContainer(module, coin, network) {
        if (!this.pool) return false
        try {
            const rows = await this.pool.query(
                `SELECT container_id FROM modules
                 WHERE module = ? AND coin = ? AND network = ?`,
                [module, coin || '', network || '']
            )
            await this.pool.query(
                `DELETE FROM modules
                 WHERE module = ? AND coin = ? AND network = ?`,
                [module, coin || '', network || '']
            )
            if (rows.length > 0) {
                return rows[0].container_id
            }
            return true
        } catch (err) {
            console.log(err)
            return false
        }
    }

    async countModules() {
        if (!this.pool) return 0
        const rows = await this.pool.query('SELECT COUNT(*) AS cnt FROM modules')
        return Number(rows[0].cnt)
    }
}

module.exports = MariaDbStore
