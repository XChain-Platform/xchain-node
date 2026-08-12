#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Rebase-completeness sweep, CLI.
 *
 *   node scripts/check-rebase-completeness.js <config.json>
 *
 * Exit 0 = every inventoried store rebased. Non-zero = at least one store carries
 * pre-batch derived state (or could not be read, which counts the same). Run this
 * BEFORE publishing the baseline anchors: publication is the window's first
 * irreversible act, and a survivor found afterwards costs an abort that is no
 * longer clean.
 *
 * The logic lives in src/services/RebaseCompletenessSweep.js and is unit tested there;
 * this file is only credentials, connections and exit codes. Those are exported behind
 * an entrypoint guard and covered by test/unit/checkRebaseCompleteness.test.js,
 * because a credential or store-lookup fault here decides a deploy just as hard as the
 * sweep verdict does.
 *
 * CONFIG SHAPE. The bucket lists come from the batch's state-reset inventory and are
 * supplied rather than discovered, because discovering tables would silently
 * re-classify whatever the inventory decided. Only REPLAYED tables may be asserted:
 * a REGENERATED table may legitimately sit empty long after the window, and a KEPT
 * table is supposed to predate it, so asserting over either produces false failures
 * that teach an operator to ignore this tool.
 *
 *   {
 *     "window_open": "2026-08-01 00:00:00",        // UTC, from the deploy report
 *     "batch_tag":   "REBASE-BATCH-1",
 *     "stores": [
 *       {
 *         "label":    "BTC mainnet indexer",
 *         "host":     "127.0.0.1",
 *         "port":     3306,
 *         "database": "XChain_BTC_Indexer",
 *         "user":     "xchain",
 *         "replayed": ["blocks", "actions", "balances", "..."],
 *         "skipped":  ["capability_snapshots", "state_checkpoints"]
 *       }
 *     ]
 *   }
 *
 * CREDENTIALS are never read from this file. Each store takes its password from the
 * environment: XC637_DB_PASS_<LABEL-SLUG> if present, else XC637_DB_PASS. Keeping them
 * out of the config means the config itself is safe to paste into the deploy report,
 * which is where the evidence has to end up.
 ********************************************************************/

'use strict';

const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');
const sweeper = require('../src/services/RebaseCompletenessSweep');

const EPOCH_MARKER_SQL = 'SELECT batch_tag FROM consensus_epoch ORDER BY id DESC LIMIT 1';

function slug(label) {
    return String(label || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Throws rather than falling back to an empty password: an anonymous connection that
// happens to succeed would sweep the wrong grants' view of the tables, and a sweep that
// cannot read a store has to fail loudly (exit 2), never quietly pass it.
function passwordFor(store, env) {
    const e = env || process.env;
    const specific = e['XC637_DB_PASS_' + slug(store.label)];
    if (specific) return specific;
    if (e.XC637_DB_PASS) return e.XC637_DB_PASS;
    throw new Error('no password in the environment for store "' + store.label
        + '" (set XC637_DB_PASS_' + slug(store.label) + ' or XC637_DB_PASS)');
}

function findStore(config, dbName) {
    return ((config && config.stores) || []).find((s) => s.database === dbName) || null;
}

// One short-lived connection per store, opened only for the read. Deliberately not
// pooled: this runs once, inside a maintenance window, against hosts whose services are
// halted, and a pool would outlive the check.
function connectionOptionsFor(store, database, env) {
    return {
        host: store.host || '127.0.0.1',
        port: Number(store.port) || 3306,
        user: store.user || 'root',
        password: passwordFor(store, env),
        database,
        connectTimeout: 8000
    };
}

function makeQueryCreateTimes(config, connect, env) {
    return async (dbName, tables) => {
        const store = findStore(config, dbName);
        if (!store) throw new Error('no store config for database ' + dbName);
        const conn = await connect(connectionOptionsFor(store, 'information_schema', env));
        try {
            // Pin the session to UTC BEFORE the read: without it MariaDB returns a zone-less
            // DATETIME in the session zone, the driver reinterprets those digits in the client's
            // local zone, and on a host west of UTC a survivor compares as fresh. See the
            // createTimeSql header; a real run reported PASS on an un-rebased store this way.
            await conn.query(sweeper.SESSION_UTC_SQL);
            return await conn.query(sweeper.createTimeSql(tables.length), [dbName].concat(tables));
        } finally {
            try { await conn.end(); } catch (_e) { /* closing a read-only conn cannot fail the verdict */ }
        }
    };
}

// Optional corroboration: a consensus_epoch marker where a service writes one. Absence
// is not a failure (services exposing a replay cursor instead are explicitly allowed),
// so every fault here degrades to "no marker" rather than to a verdict.
function makeQueryEpochMarker(config, connect, env) {
    return async (dbName) => {
        const store = findStore(config, dbName);
        if (!store) return null;
        let conn = null;
        try {
            conn = await connect(connectionOptionsFor(store, dbName, env));
            const rows = await conn.query(EPOCH_MARKER_SQL);
            return (rows && rows[0] && rows[0].batch_tag) ? String(rows[0].batch_tag) : null;
        } catch (_e) {
            return null;
        } finally {
            if (conn) { try { await conn.end(); } catch (_e) { /* ignore */ } }
        }
    };
}

function loadConfig(configPath) {
    return JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
}

async function main() {
    const configPath = process.argv[2];
    if (!configPath) {
        console.error('usage: node scripts/check-rebase-completeness.js <config.json>');
        process.exit(2);
    }
    const config = loadConfig(configPath);
    const connect = (opts) => mariadb.createConnection(opts);

    const result = await sweeper.sweepFleet(config, {
        queryCreateTimes: makeQueryCreateTimes(config, connect),
        queryEpochMarker: makeQueryEpochMarker(config, connect)
    });
    console.log(sweeper.formatReport(result));
    if (process.env.XC637_SWEEP_JSON === '1')
        console.log('\n' + JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 1);
}

module.exports = {
    EPOCH_MARKER_SQL, slug, passwordFor, findStore, connectionOptionsFor,
    makeQueryCreateTimes, makeQueryEpochMarker, loadConfig, main
};

// Guarded so test/unit/checkRebaseCompleteness.test.js can require the helpers without
// the CLI firing on import. The undefined arm covers `node -` (stdin), where require.main
// is undefined rather than this module; it costs nothing here and keeps the three
// scripts/ entrypoints on one guard that cannot be copied into a stdin-piped tool wrong.
if (require.main === module || require.main === undefined) {
    main().catch((e) => {
        // A configuration fault is not a pass. Exit 2 so a runbook can tell "the fleet failed
        // the check" (1) from "the check could not run" (2), because the second one means the
        // window has no evidence either way.
        console.error('rebase-completeness sweep could not run: ' + ((e && e.message) || e));
        process.exit(2);
    });
}
