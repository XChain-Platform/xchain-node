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
 * XChain Node - MariaDbStore Class
 *
 * Drop-in replacement for LevelUpStore. Persists module→container ID
 * mappings in a shared MariaDB instance (the xchain_node database, in the
 * per-stack registry table `db/modules.js` resolves).
 *
 * This file is the constructor, the pool and the plumbing; every query lives
 * in a table-family file beside it and is installed onto the prototype below,
 * so call sites keep writing `store.getModuleContainer(...)` and the split is
 * invisible to them.
 *
 ********************************************************************/

const mariadb = require('mariadb')
const { sleep } = require('../utils/helpers')
const { CREATE_MODULES_TABLE_SQL, modulesMixin } = require('./modules')

function installMethods(target, methods) {
    const descriptors = Object.getOwnPropertyDescriptors(methods)
    for (const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false
    Object.defineProperties(target, descriptors)
}

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

        // Right after a fresh container start, mariadbd may already answer
        // through the unix socket (so docker exec checks pass) while the TCP
        // listener / docker port mapping aren't quite ready. Retry briefly.
        let conn
        let lastErr
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                conn = await this.pool.getConnection()
                break
            } catch (err) {
                lastErr = err
                await sleep(2000)
            }
        }
        if (!conn) {
            throw new Error("Couldn't open/create MariaDB database: " + lastErr.message)
        }

        try {
            await conn.query(CREATE_MODULES_TABLE_SQL)
        } catch (err) {
            throw new Error("Couldn't open/create MariaDB database: " + err.message)
        } finally {
            conn.release()
        }

        return this.pool
    }

    async close() {
        if (this.pool) {
            await this.pool.end()
            this.pool = null
        }
    }

    isReady() {
        return this.pool !== null
    }

    // Callers that treat "no rows" as a valid answer (status printing, early
    // precheck) can live with the empty array getAllModuleContainers returns
    // when the pool isn't open yet. Callers that act ON the row set cannot: an
    // unconfigured store is indistinguishable from an empty install, so they
    // silently do nothing and report success. Those sites assert first.
    assertReady(operation) {
        if (!this.pool) {
            throw new Error(
                "MariaDbStore is not connected, so " + operation + " would silently operate on an empty " +
                "module set and report success. Run precheck (db.createDatabase) before this call."
            )
        }
    }
}

// Every query against the registry table, installed onto the prototype so a
// call site cannot tell the split happened. One place to add a table family:
// a new file beside this one, and its row here.
installMethods(MariaDbStore.prototype, modulesMixin)

module.exports = MariaDbStore
