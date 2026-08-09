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
 *  section 7 pre-window gate: scan every network for a nine-field FILE.
 *
 *   XC637_DB_PASS=... node scripts/scan-nine-field-files.js \
 *       --host 127.0.0.1 --port 3306 --user xchain --database XChain_BTC_Decoder \
 *       [--label "BTC mainnet"] [--limit 500]
 *
 * Exit 0 = clean (no FILE carries a non-empty ninth field, so PC-29's STRICT validation
 * cannot flip a historical FILE during the rebase). Exit 1 = hits, each of which is an
 * operator decision BEFORE the window. Exit 2 = the scan could not run, which is not a
 * pass: it means the gate has no evidence.
 *
 * It reads the DECODER database on purpose. The indexer's stored params are truncated to
 * the format's field list, so a scan there cannot see a tenth token and returns zero hits
 * on a chain that has one. The logic and that reasoning live in
 * src/services/GatedFileFieldScan.js and are unit tested there; this file is connection,
 * paging and exit codes. The paging loop and the corpus measurement are exported behind an
 * entrypoint guard and covered by test/unit/scanNineFieldFiles.test.js .
 ********************************************************************/

'use strict';

const mariadb = require('mariadb');
const scanner = require('../src/services/GatedFileFieldScan');

function argFrom(argv, name, fallback) {
    const i = argv.indexOf('--' + name);
    return (i !== -1 && argv[i + 1] !== undefined) ? argv[i + 1] : fallback;
}

function arg(name, fallback) {
    return argFrom(process.argv, name, fallback);
}

// Keyset paging over tx_index: a mainnet decoder holds millions of rows and the point of
// the gate is to scan ALL of them, so it streams rather than materializing the set. The
// cursor guard is the load-bearing part: a page whose last tx_index does not advance would
// otherwise re-read the same rows forever and never reach a verdict.
async function paginateScan(conn, scanner, limit) {
    const total = { scanned: 0, hits: [] };
    let after = -1;
    for (;;) {
        const rows = await conn.query(scanner.scanSql(limit), [after]);
        if (!rows || rows.length === 0) break;
        const res = scanner.scanRows(rows);
        total.scanned += res.scanned;
        total.hits = total.hits.concat(res.hits);
        const next = Number(rows[rows.length - 1].tx_index);
        if (!Number.isFinite(next) || next <= after) break;
        after = next;
    }
    return total;
}

// A corpus that cannot be measured is reported as unknown, never as zero: the 2026-07-29
// fleet run found nine of ten stores holding no payload rows at all, and a CLEAN over an
// unknown corpus has to be distinguishable from a CLEAN over a scanned one.
async function measureCorpus(conn, scanner) {
    try {
        const c = await conn.query(scanner.corpusSql());
        return (c && c.length) ? Number(c[0].payload_rows) : null;
    } catch (e) {
        console.error('warning: could not measure the payload corpus (' +
                      ((e && e.message) || e) + '); the report will say so.');
        return null;
    }
}

async function main() {
    const database = arg('database');
    if (!database) {
        console.error('usage: node scripts/scan-nine-field-files.js --database <decoder db> '
                    + '[--host h] [--port p] [--user u] [--label name] [--limit n]');
        process.exit(2);
    }
    const password = process.env.XC637_DB_PASS;
    if (!password) {
        console.error('set XC637_DB_PASS in the environment (never on the command line)');
        process.exit(2);
    }
    const limit = Math.max(1, Number(arg('limit', 500)) || 500);
    const label = arg('label', database);

    const conn = await mariadb.createConnection({
        host: arg('host', '127.0.0.1'),
        port: Number(arg('port', 3306)) || 3306,
        user: arg('user', 'root'),
        password,
        database,
        connectTimeout: 10000
    });

    // Measured BEFORE the scan so the report can say which kind of clean this is.
    const corpus = await measureCorpus(conn, scanner);
    let total;
    try {
        total = await paginateScan(conn, scanner, limit);
    } finally {
        try { await conn.end(); } catch (_e) { /* a read-only conn cannot change the verdict */ }
    }

    console.log(scanner.formatReport(total, label, corpus));
    process.exit(total.hits.length === 0 ? 0 : 1);
}

module.exports = { argFrom, paginateScan, measureCorpus, main };

// See the guard note in check-rebase-completeness.js for why the undefined arm is here.
if (require.main === module || require.main === undefined) {
    main().catch((e) => {
        console.error('nine-field FILE scan could not run: ' + ((e && e.message) || e));
        process.exit(2);
    });
}
