/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Coverage for scripts/scan-nine-field-files.js.
 *
 * GatedFileFieldScan proves what counts as a hit. Untested until now was the paging that
 * decides HOW MUCH of the corpus a verdict covers, and that is where a false CLEAN comes
 * from: a loop that stops early scans a fraction of a mainnet decoder and reports the same
 * "no hits" a full scan does. The cursor tests below are all about the difference between
 * finishing and stopping.
 ********************************************************************/

'use strict';

const assert  = require('assert');
const scanner = require('../../src/services/GatedFileFieldScan');
const cli     = require('../../scripts/scan-nine-field-files');

const HASH   = 'a'.repeat(64);
const eight  = ['0', 'f.txt', 'text/plain', 'Title', 'memo', 'GATED', '1', HASH];
const clean  = 'FILE|' + eight.join('|');
const ninth  = 'FILE|' + eight.concat(['100']).join('|');

const row = (tx_index, data) => ({ tx_index, block_index: 1, hash: HASH, data });

// Serves canned pages and counts queries, so a loop that fails to terminate fails the test
// instead of hanging the suite.
function fakeConn(pages, opts) {
    const o = opts || {};
    const state = { calls: 0, afters: [], sqls: [] };
    return {
        state,
        conn: {
            query: async (sql, params) => {
                state.calls++;
                if (state.calls > 40) throw new Error('runaway paging: the cursor never advanced');
                state.sqls.push(sql);
                if (o.corpusFails && sql === scanner.corpusSql()) throw new Error('no such table');
                if (sql === scanner.corpusSql()) return o.corpus;
                state.afters.push(params[0]);
                return pages.shift() || [];
            },
            end: async () => {}
        }
    };
}

describe('scan-nine-field-files CLI', function () {

    describe('argument reading', function () {

        it('reads a flag value out of the vector', function () {
            const argv = ['node', 'x', '--database', 'XChain_BTC_Decoder', '--limit', '500'];
            assert.strictEqual(cli.argFrom(argv, 'database'), 'XChain_BTC_Decoder');
            assert.strictEqual(cli.argFrom(argv, 'limit'), '500');
        });

        it('returns the fallback for an absent flag', function () {
            assert.strictEqual(cli.argFrom(['node', 'x'], 'host', '127.0.0.1'), '127.0.0.1');
            assert.strictEqual(cli.argFrom(['node', 'x'], 'host'), undefined);
        });

        it('returns the fallback when a trailing flag has no value', function () {
            // `--database` as the last token must not yield undefined-as-a-database.
            assert.strictEqual(cli.argFrom(['node', 'x', '--database'], 'database', 'fb'), 'fb');
        });

        it('does not match a flag name appearing as another flag value', function () {
            // indexOf finds the literal "--host"; a bare value "host" must not count.
            assert.strictEqual(cli.argFrom(['node', 'x', '--label', 'host', '--host', 'h1'], 'host'), 'h1');
        });
    });

    describe('corpus measurement', function () {

        it('reports the payload row count', async function () {
            const { conn } = fakeConn([], { corpus: [{ payload_rows: 40123 }] });
            assert.strictEqual(await cli.measureCorpus(conn, scanner), 40123);
        });

        it('reports unknown rather than zero when the count cannot be read', async function () {
            // "0 hits over an unknown corpus" and "0 hits over 40k rows" are different
            // facts; collapsing the first into 0 would print a confident vacuous CLEAN.
            const { conn } = fakeConn([], { corpusFails: true });
            const errs = [];
            const original = console.error;
            console.error = (m) => errs.push(m);
            try {
                assert.strictEqual(await cli.measureCorpus(conn, scanner), null);
            } finally { console.error = original; }
            assert.strictEqual(errs.length, 1);
            assert.match(errs[0], /could not measure the payload corpus/);
        });

        it('reports unknown for an empty result set', async function () {
            const { conn } = fakeConn([], { corpus: [] });
            assert.strictEqual(await cli.measureCorpus(conn, scanner), null);
        });
    });

    describe('keyset paging', function () {

        it('starts the cursor below zero so tx_index 0 is scanned', async function () {
            // tx_index is zero-based; a cursor starting at 0 would skip the first row and
            // a nine-field FILE there would go unreported.
            const { conn, state } = fakeConn([[row(0, clean)], []]);
            await cli.paginateScan(conn, scanner, 500);
            assert.strictEqual(state.afters[0], -1);
        });

        it('advances the cursor to the last tx_index of each page', async function () {
            const { conn, state } = fakeConn([
                [row(0, clean), row(7, clean)],
                [row(12, clean)],
                []
            ]);
            const total = await cli.paginateScan(conn, scanner, 500);
            assert.deepStrictEqual(state.afters, [-1, 7, 12]);
            assert.strictEqual(total.scanned, 3);
        });

        it('accumulates hits across pages', async function () {
            const { conn } = fakeConn([
                [row(1, clean), row(2, ninth)],
                [row(3, ninth)],
                []
            ]);
            const total = await cli.paginateScan(conn, scanner, 500);
            assert.strictEqual(total.scanned, 3);
            assert.strictEqual(total.hits.length, 2);
            assert.deepStrictEqual(total.hits.map(h => h.tx_index), [2, 3]);
            assert.strictEqual(total.hits[0].ninth, '100');
        });

        it('reports a clean store as scanned, not as unexamined', async function () {
            const { conn } = fakeConn([[row(1, clean), row(2, clean)], []]);
            const total = await cli.paginateScan(conn, scanner, 500);
            assert.strictEqual(total.hits.length, 0);
            assert.strictEqual(total.scanned, 2);
        });

        it('stops on the first empty page', async function () {
            const { conn, state } = fakeConn([[], [row(9, ninth)]]);
            const total = await cli.paginateScan(conn, scanner, 500);
            assert.strictEqual(state.calls, 1);
            assert.strictEqual(total.scanned, 0);
        });

        it('breaks rather than spinning when the cursor does not advance', async function () {
            // A page whose last tx_index is not greater than the cursor would otherwise be
            // re-read forever and the gate would never return a verdict.
            const pages = [];
            for (let i = 0; i < 60; i++) pages.push([row(5, clean)]);
            const { conn, state } = fakeConn(pages);
            const total = await cli.paginateScan(conn, scanner, 500);
            assert.strictEqual(state.calls, 2, 'the second identical page must end the loop');
            assert.strictEqual(total.scanned, 2);
        });

        it('breaks on a non-numeric tx_index instead of paging from NaN', async function () {
            const pages = [];
            for (let i = 0; i < 60; i++) pages.push([row('not-a-number', clean)]);
            const { conn, state } = fakeConn(pages);
            await cli.paginateScan(conn, scanner, 500);
            assert.strictEqual(state.calls, 1);
        });

        it('counts the stalled page before stopping, so its rows are not lost', async function () {
            const { conn } = fakeConn([[row(3, ninth)], [row(3, ninth)]]);
            const total = await cli.paginateScan(conn, scanner, 500);
            assert.strictEqual(total.hits.length, 2,
                'the stalled page is still scanned; the loop stops after it, not before');
        });

        it('carries the limit into the paging SQL', async function () {
            const { conn, state } = fakeConn([[]]);
            await cli.paginateScan(conn, scanner, 250);
            assert.strictEqual(state.sqls[0], scanner.scanSql(250));
            assert.match(state.sqls[0], /LIMIT 250$/);
        });
    });

    describe('the entrypoint guard', function () {

        it('exports the helpers without running the scan on require', function () {
            assert.strictEqual(typeof cli.main, 'function');
            assert.strictEqual(typeof cli.paginateScan, 'function');
        });
    });
});
