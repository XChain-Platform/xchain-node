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
 * The rebase-completeness sweep.
 *
 * What this guards is the batch's load-bearing invariant: after the rebase NO service
 * keeps pre-batch derived state, because one survivor forks the fleet against every
 * node that replayed. The sweep's whole value is that it says NO when a store survived,
 * so the tests that matter here are the ones proving it cannot say yes by accident:
 * a marker present over stale tables, an empty table list, an unreadable store, and a
 * missing CREATE_TIME all have to fail.
 ********************************************************************/

'use strict';

const assert = require('assert');
const sweep  = require('../../src/services/RebaseCompletenessSweep');

const WINDOW_OPEN = '2026-08-01 00:00:00';           // UTC, as the module documents
const WINDOW_MS   = Date.parse('2026-08-01T00:00:00Z');
const AFTER       = '2026-08-01 02:30:00';           // replayed inside the window
const BEFORE      = '2026-07-20 09:00:00';           // a survivor

// A store double: CREATE_TIME per table, plus optional faults.
function makeQuery(times, opts) {
    opts = opts || {};
    return async (dbName, tables) => {
        if (opts.throwFor === dbName) throw new Error('connection refused');
        return tables
            .filter((t) => !(opts.absent || []).includes(t))
            .map((t) => ({ table_name: t, create_time: Object.prototype.hasOwnProperty.call(times, t) ? times[t] : AFTER }));
    };
}

const store = (over) => Object.assign({ label: 'btc-mainnet indexer', database: 'XChain_BTC_Indexer',
    replayed: ['blocks', 'actions', 'balances'], skipped: ['capability_snapshots'] }, over || {});

describe('rebase-completeness sweep', function () {

    describe('the sweep says yes only when every replayed table postdates the window', function () {

        it('passes a store whose replayed tables were all recreated inside the window', async function () {
            const r = await sweep.sweepStore(store(), {
                windowOpenMs: WINDOW_MS, queryCreateTimes: makeQuery({})
            });
            assert.strictEqual(r.pass, true);
            assert.strictEqual(r.code, sweep.OK);
            assert.strictEqual(r.checked, 3);
            assert.deepStrictEqual(r.failures, []);
        });

        it('FAILS the store and names the survivor when one table predates the window', async function () {
            // The case the whole tool exists for: three tables look replayed, one is a
            // survivor carrying pre-batch derived state.
            const r = await sweep.sweepStore(store(), {
                windowOpenMs: WINDOW_MS, queryCreateTimes: makeQuery({ balances: BEFORE })
            });
            assert.strictEqual(r.pass, false);
            assert.strictEqual(r.code, sweep.STALE_TABLE);
            assert.strictEqual(r.failures.length, 1);
            assert.strictEqual(r.failures[0].table, 'balances');
            assert.match(r.failures[0].detail, /survived the rebase/);
        });

        it('a table created exactly at the window opening counts as replayed', async function () {
            // The boundary is inclusive: the wipe is the first thing the window does, so a
            // table stamped at the opening instant is the expected case, not a survivor.
            const r = await sweep.sweepStore(store(), {
                windowOpenMs: WINDOW_MS, queryCreateTimes: makeQuery({ blocks: WINDOW_OPEN })
            });
            assert.strictEqual(r.pass, true);
        });
    });

    describe('it cannot say yes by accident', function () {

        it('an epoch marker does NOT rescue a stale table (the vacuous-marker case)', async function () {
            // The spec's own warning: new code booting over a surviving DB would stamp a
            // marker happily, proving only that new code ran. The marker is corroboration.
            const r = await sweep.sweepStore(store(), {
                windowOpenMs: WINDOW_MS,
                queryCreateTimes: makeQuery({ actions: BEFORE }),
                queryEpochMarker: async () => 'rebase-2026-08'
            });
            assert.strictEqual(r.markerTag, 'rebase-2026-08', 'the marker was read');
            assert.strictEqual(r.pass, false, 'and it did not rescue the store');
            assert.strictEqual(r.failures[0].code, sweep.STALE_TABLE);
        });

        it('a missing marker does not fail a store whose tables all postdate the window', async function () {
            // Services that expose a replay cursor instead of a marker row are explicitly
            // allowed; absence must not be a failure or the sweep is unusable on them.
            const r = await sweep.sweepStore(store(), {
                windowOpenMs: WINDOW_MS,
                queryCreateTimes: makeQuery({}),
                queryEpochMarker: async () => null
            });
            assert.strictEqual(r.pass, true);
            assert.strictEqual(r.markerTag, null);
        });

        it('an empty replayed list FAILS instead of reporting green', async function () {
            // The shape a mis-wired config takes. Reporting pass here would be the tool
            // certifying a store nobody checked.
            const r = await sweep.sweepStore(store({ replayed: [] }), {
                windowOpenMs: WINDOW_MS, queryCreateTimes: makeQuery({})
            });
            assert.strictEqual(r.pass, false);
            assert.strictEqual(r.code, sweep.NO_TABLES_CHECKED);
        });

        it('an unreadable store FAILS rather than skipping', async function () {
            const r = await sweep.sweepStore(store(), {
                windowOpenMs: WINDOW_MS,
                queryCreateTimes: makeQuery({}, { throwFor: 'XChain_BTC_Indexer' })
            });
            assert.strictEqual(r.pass, false);
            assert.strictEqual(r.code, sweep.UNREADABLE);
            assert.match(r.failures[0].detail, /connection refused/);
        });

        it('an inventoried table absent from the store FAILS', async function () {
            const r = await sweep.sweepStore(store(), {
                windowOpenMs: WINDOW_MS, queryCreateTimes: makeQuery({}, { absent: ['balances'] })
            });
            assert.strictEqual(r.pass, false);
            assert.strictEqual(r.failures[0].code, sweep.MISSING_TABLE);
        });

        it('a NULL CREATE_TIME FAILS rather than comparing as ancient or as now', async function () {
            const r = await sweep.sweepStore(store(), {
                windowOpenMs: WINDOW_MS, queryCreateTimes: makeQuery({ actions: null })
            });
            assert.strictEqual(r.pass, false);
            assert.strictEqual(r.failures[0].code, sweep.NO_CREATE_TIME);
            assert.strictEqual(r.checked, 2, 'the other two tables were still checked');
        });
    });

    describe('timestamp handling', function () {
        it('accepts Date, ISO, MariaDB DATETIME text, seconds and milliseconds', function () {
            const expect = Date.parse('2026-08-01T02:30:00Z');
            assert.strictEqual(sweep.toEpochMs(new Date(expect)), expect);
            assert.strictEqual(sweep.toEpochMs('2026-08-01T02:30:00Z'), expect);
            assert.strictEqual(sweep.toEpochMs('2026-08-01 02:30:00'), expect, 'DATETIME text is read as UTC');
            assert.strictEqual(sweep.toEpochMs(expect / 1000), expect, 'epoch seconds');
            assert.strictEqual(sweep.toEpochMs(expect), expect, 'epoch milliseconds');
        });

        it('returns null for what it cannot establish, never 0 and never now', function () {
            for (const bad of [null, undefined, '', 'whenever', NaN, Infinity])
                assert.strictEqual(sweep.toEpochMs(bad), null, JSON.stringify(bad));
        });

        it('reads DATETIME text as UTC, not local time', function () {
            // Guessing local time would shift the comparison by hours in exactly the
            // direction that passes a survivor on a host west of UTC.
            assert.strictEqual(sweep.toEpochMs('2026-08-01 00:00:00'),
                               Date.parse('2026-08-01T00:00:00Z'));
        });
    });

    describe('fleet sweep', function () {
        const cfg = (stores) => ({ window_open: WINDOW_OPEN, batch_tag: 'rebase-2026-08', stores });

        it('fails the fleet when any single store fails, and keeps sweeping the rest', async function () {
            const stores = [
                store({ label: 'btc indexer', database: 'db1' }),
                store({ label: 'hub',         database: 'db2' }),
                store({ label: 'doge indexer', database: 'db3' })
            ];
            const times = { db2: { actions: BEFORE } };
            const q = async (dbName, tables) => tables.map((t) => ({
                table_name: t, create_time: (times[dbName] && times[dbName][t]) || AFTER }));

            const res = await sweep.sweepFleet(cfg(stores), { queryCreateTimes: q });
            assert.strictEqual(res.pass, false);
            assert.strictEqual(res.summary.stores, 3);
            assert.strictEqual(res.summary.failed, 1);
            assert.strictEqual(res.summary.survivors, 1);
            assert.strictEqual(res.stores[2].pass, true, 'stores after the failure were still swept');
        });

        it('refuses to run without a window_open, which would pass everything', async function () {
            await assert.rejects(
                () => sweep.sweepFleet({ stores: [store()] }, { queryCreateTimes: makeQuery({}) }),
                /window_open is required/);
        });

        it('refuses an empty store list rather than reporting an empty pass', async function () {
            await assert.rejects(
                () => sweep.sweepFleet(cfg([]), { queryCreateTimes: makeQuery({}) }),
                /stores is empty/);
        });

        it('the report names the survivor and refuses to bless the window', async function () {
            const res = await sweep.sweepFleet(cfg([store({ database: 'db1' })]), {
                queryCreateTimes: makeQuery({ balances: BEFORE })
            });
            const text = sweep.formatReport(res);
            assert.match(text, /FAIL/);
            assert.match(text, /balances/);
            assert.match(text, /Do not proceed to anchor publication/);
        });

        it('a passing report says so plainly', async function () {
            const res = await sweep.sweepFleet(cfg([store({ database: 'db1' })]), {
                queryCreateTimes: makeQuery({})
            });
            assert.match(sweep.formatReport(res), /RESULT: PASS/);
        });
    });

    describe('the SQL shape', function () {
        it('binds one placeholder per table plus the schema, so no name is interpolated', function () {
            const sql = sweep.createTimeSql(3);
            assert.match(sql, /information_schema\.TABLES/);
            assert.match(sql, /TABLE_SCHEMA = \?/);
            assert.strictEqual((sql.match(/\?/g) || []).length, 4, 'schema + one per table');
        });

        // REGRESSION, and it is the most important test in this file because the bug it
        // guards does not error: it certifies a fork.
        //
        // The first real run of this sweep reported PASS on a store that had NOT rebased.
        // MariaDB returns CREATE_TIME as a zone-less DATETIME in the session zone; the
        // driver then built a JS Date from those digits in the CLIENT's local zone, and on
        // a host at UTC-7 a table created at 23:26:38 UTC came back as 06:26:38 the NEXT
        // DAY, seven hours in the future, so a survivor compared as fresh. Asking the
        // server for epoch seconds under a pinned UTC session removes every zone from the
        // path. If either half of that is dropped, the sweep starts lying in the passing
        // direction, so both are pinned by name.
        it('asks the SERVER for epoch seconds, never a zone-less DATETIME', function () {
            const sql = sweep.createTimeSql(1);
            assert.match(sql, /UNIX_TIMESTAMP\(\s*CREATE_TIME\s*\)/i,
                'a raw CREATE_TIME is reinterpreted in the client zone and passes survivors');
            assert.doesNotMatch(sql, /CREATE_TIME\s+AS\s+create_time/i,
                'selecting CREATE_TIME directly is the shape that certified a fork');
        });

        it('exports the UTC session pin the read depends on', function () {
            assert.match(sweep.SESSION_UTC_SQL, /SET\s+SESSION\s+time_zone\s*=\s*'\+00:00'/i,
                'UNIX_TIMESTAMP interprets the value in the session zone, so it must be UTC');
        });
    });
});
