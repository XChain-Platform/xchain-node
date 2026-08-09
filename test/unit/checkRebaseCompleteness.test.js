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
 * : coverage for scripts/check-rebase-completeness.js.
 *
 * RebaseCompletenessSweep already proves the VERDICT logic. What was untested is the CLI
 * half that feeds it, and every fault available there produces a false PASS rather than a
 * crash: reading the wrong store, connecting to the wrong database, or skipping the UTC
 * session pin that a real run once lost a survivor to. The sweep runs before the baseline
 * anchors are published, which is the window's first irreversible act, so a false PASS
 * here is discovered after the abort stops being clean.
 *
 * Nothing here connects to a database. The connection factory is injected, which is the
 * point of the refactor: the wiring is asserted, not exercised.
 ********************************************************************/

'use strict';

const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const sweeper = require('../../src/services/RebaseCompletenessSweep');
const cli     = require('../../scripts/check-rebase-completeness');

const CONFIG = {
    window_open: '2026-08-01 00:00:00',
    batch_tag: '',
    stores: [
        { label: 'BTC mainnet indexer (node-host-a)', host: '10.0.0.5', port: '3307',
          user: 'xchain', database: 'XChain_BTC_Indexer', replayed: ['blocks', 'actions'] },
        { label: 'LTC', database: 'XChain_LTC_Indexer', replayed: ['blocks'] }
    ]
};

// Records every query and every option set it was handed, so the assertions can be about
// what the CLI asked for rather than about what a database answered.
function fakeConnect(behaviour) {
    const log = { opts: [], queries: [], ends: 0 };
    const b = behaviour || {};
    const connect = async (opts) => {
        log.opts.push(opts);
        if (b.failConnect) throw new Error('connect refused');
        return {
            query: async (sql, params) => {
                log.queries.push({ sql, params });
                if (b.failQuery) throw new Error('query refused');
                return b.rows === undefined ? [] : b.rows;
            },
            end: async () => {
                log.ends++;
                if (b.failEnd) throw new Error('close refused');
            }
        };
    };
    return { connect, log };
}

describe(' check-rebase-completeness CLI (deploy-informing script)', function () {

    describe('label slugs', function () {

        it('folds punctuation and spacing into single underscores', function () {
            assert.strictEqual(cli.slug('BTC mainnet indexer (node-host-a)'), 'BTC_MAINNET_INDEXER_NODES01');
        });

        it('strips leading and trailing underscores so the env var name is usable', function () {
            assert.strictEqual(cli.slug('  (btc)  '), 'BTC');
            assert.strictEqual(cli.slug('-a-'), 'A');
        });

        it('survives a missing label rather than throwing on undefined', function () {
            assert.strictEqual(cli.slug(undefined), '');
            assert.strictEqual(cli.slug(null), '');
        });
    });

    describe('credentials', function () {

        it('prefers the per-store password over the fleet-wide one', function () {
            const env = { XC637_DB_PASS: 'fleet-value', XC637_DB_PASS_LTC: 'store-value' };
            assert.strictEqual(cli.passwordFor({ label: 'LTC' }, env), 'store-value');
        });

        it('falls back to the fleet-wide password', function () {
            assert.strictEqual(cli.passwordFor({ label: 'LTC' }, { XC637_DB_PASS: 'fleet-value' }),
                               'fleet-value');
        });

        it('treats an empty per-store value as unset and keeps falling back', function () {
            // An exported-but-empty variable is a shell mistake, not an intent to connect
            // anonymously; silently using "" would connect under different grants.
            const env = { XC637_DB_PASS_LTC: '', XC637_DB_PASS: 'fleet-value' };
            assert.strictEqual(cli.passwordFor({ label: 'LTC' }, env), 'fleet-value');
        });

        it('throws, naming both variables, when neither is set', function () {
            assert.throws(() => cli.passwordFor({ label: 'BTC mainnet' }, {}), (e) => {
                assert.match(e.message, /no password in the environment for store "BTC mainnet"/);
                assert.match(e.message, /XC637_DB_PASS_BTC_MAINNET/);
                assert.match(e.message, /XC637_DB_PASS/);
                return true;
            });
        });

        it('never reads the password out of the config file', function () {
            const store = { label: 'LTC', password: 'from-config' };
            assert.throws(() => cli.passwordFor(store, {}), /no password in the environment/);
        });
    });

    describe('connection options', function () {

        it('carries the store host, port and user, coercing the port to a number', function () {
            const opts = cli.connectionOptionsFor(CONFIG.stores[0], 'information_schema',
                                                  { XC637_DB_PASS: 'v' });
            assert.strictEqual(opts.host, '10.0.0.5');
            assert.strictEqual(opts.port, 3307);
            assert.strictEqual(opts.user, 'xchain');
            assert.strictEqual(opts.database, 'information_schema');
            assert.strictEqual(opts.connectTimeout, 8000);
        });

        it('defaults a bare store to loopback, 3306 and root', function () {
            const opts = cli.connectionOptionsFor({ label: 'x' }, 'db', { XC637_DB_PASS: 'v' });
            assert.strictEqual(opts.host, '127.0.0.1');
            assert.strictEqual(opts.port, 3306);
            assert.strictEqual(opts.user, 'root');
        });

        it('falls back to 3306 on an unparseable port instead of connecting to NaN', function () {
            const opts = cli.connectionOptionsFor({ label: 'x', port: 'abc' }, 'db',
                                                  { XC637_DB_PASS: 'v' });
            assert.strictEqual(opts.port, 3306);
        });

        it('takes the target database from the caller, not from the store record', function () {
            // The two queries deliberately target different schemas from the same store.
            const opts = cli.connectionOptionsFor(CONFIG.stores[0], 'information_schema',
                                                  { XC637_DB_PASS: 'v' });
            assert.notStrictEqual(opts.database, CONFIG.stores[0].database);
        });
    });

    describe('store lookup', function () {

        it('finds a store by its database name', function () {
            assert.strictEqual(cli.findStore(CONFIG, 'XChain_LTC_Indexer').label, 'LTC');
        });

        it('returns null for an unknown database and for an empty config', function () {
            assert.strictEqual(cli.findStore(CONFIG, 'nope'), null);
            assert.strictEqual(cli.findStore({}, 'nope'), null);
            assert.strictEqual(cli.findStore(null, 'nope'), null);
        });
    });

    describe('the CREATE_TIME read', function () {

        it('pins the session to UTC BEFORE reading create times', async function () {
            // Order is the whole point. A real run reported PASS on an un-rebased store
            // because the zone-less DATETIME came back in the session zone and compared
            // as fresh; the pin only helps if it precedes the read.
            const { connect, log } = fakeConnect({ rows: [] });
            const q = cli.makeQueryCreateTimes(CONFIG, connect, { XC637_DB_PASS: 'v' });
            await q('XChain_BTC_Indexer', ['blocks', 'actions']);
            assert.strictEqual(log.queries.length, 2);
            assert.strictEqual(log.queries[0].sql, sweeper.SESSION_UTC_SQL);
            assert.strictEqual(log.queries[1].sql, sweeper.createTimeSql(2));
        });

        it('reads information_schema, not the store database', async function () {
            const { connect, log } = fakeConnect({ rows: [] });
            await cli.makeQueryCreateTimes(CONFIG, connect, { XC637_DB_PASS: 'v' })
                     ('XChain_BTC_Indexer', ['blocks']);
            assert.strictEqual(log.opts[0].database, 'information_schema');
            assert.strictEqual(log.opts[0].host, '10.0.0.5');
        });

        it('binds the database name ahead of the table list', async function () {
            const { connect, log } = fakeConnect({ rows: [] });
            await cli.makeQueryCreateTimes(CONFIG, connect, { XC637_DB_PASS: 'v' })
                     ('XChain_BTC_Indexer', ['blocks', 'actions']);
            assert.deepStrictEqual(log.queries[1].params,
                                   ['XChain_BTC_Indexer', 'blocks', 'actions']);
        });

        it('returns the driver rows unchanged', async function () {
            const rows = [{ TABLE_NAME: 'blocks', CREATE_TIME: '2026-08-01 02:30:00' }];
            const { connect } = fakeConnect({ rows });
            const out = await cli.makeQueryCreateTimes(CONFIG, connect, { XC637_DB_PASS: 'v' })
                                 ('XChain_BTC_Indexer', ['blocks']);
            assert.deepStrictEqual(out, rows);
        });

        it('throws for a database the config never inventoried', async function () {
            // A store present on the host but absent from the section 3.1 inventory must
            // abort the sweep; silently skipping it would certify an unexamined store.
            const { connect, log } = fakeConnect({ rows: [] });
            await assert.rejects(
                () => cli.makeQueryCreateTimes(CONFIG, connect, { XC637_DB_PASS: 'v' })('ghost_db', []),
                /no store config for database ghost_db/);
            assert.strictEqual(log.opts.length, 0, 'it must not open a connection first');
        });

        it('propagates a missing password rather than connecting anonymously', async function () {
            const { connect, log } = fakeConnect({ rows: [] });
            await assert.rejects(
                () => cli.makeQueryCreateTimes(CONFIG, connect, {})('XChain_BTC_Indexer', ['blocks']),
                /no password in the environment/);
            assert.strictEqual(log.opts.length, 0);
        });

        it('closes the connection even when the read throws', async function () {
            const { connect, log } = fakeConnect({ failQuery: true });
            await assert.rejects(
                () => cli.makeQueryCreateTimes(CONFIG, connect, { XC637_DB_PASS: 'v' })
                         ('XChain_BTC_Indexer', ['blocks']), /query refused/);
            assert.strictEqual(log.ends, 1);
        });

        it('does not let a failed close change the verdict', async function () {
            const rows = [{ TABLE_NAME: 'blocks' }];
            const { connect } = fakeConnect({ rows, failEnd: true });
            const out = await cli.makeQueryCreateTimes(CONFIG, connect, { XC637_DB_PASS: 'v' })
                                 ('XChain_BTC_Indexer', ['blocks']);
            assert.deepStrictEqual(out, rows);
        });
    });

    describe('the epoch-marker read', function () {

        it('reads the store database itself and returns the newest batch tag', async function () {
            const { connect, log } = fakeConnect({ rows: [{ batch_tag: '' }] });
            const out = await cli.makeQueryEpochMarker(CONFIG, connect, { XC637_DB_PASS: 'v' })
                                 ('XChain_BTC_Indexer');
            assert.strictEqual(out, '');
            assert.strictEqual(log.opts[0].database, 'XChain_BTC_Indexer');
            assert.strictEqual(log.queries[0].sql, cli.EPOCH_MARKER_SQL);
            assert.match(cli.EPOCH_MARKER_SQL, /ORDER BY id DESC LIMIT 1/);
        });

        it('degrades every fault to "no marker" instead of to a verdict', async function () {
            // Services that expose a replay cursor instead of a marker table are explicitly
            // allowed, so absence must never be reported as a failure.
            const env = { XC637_DB_PASS: 'v' };
            const noTable = fakeConnect({ failQuery: true });
            assert.strictEqual(
                await cli.makeQueryEpochMarker(CONFIG, noTable.connect, env)('XChain_BTC_Indexer'), null);
            assert.strictEqual(noTable.log.ends, 1, 'a failed query still closes the connection');

            const refused = fakeConnect({ failConnect: true });
            assert.strictEqual(
                await cli.makeQueryEpochMarker(CONFIG, refused.connect, env)('XChain_BTC_Indexer'), null);

            const empty = fakeConnect({ rows: [] });
            assert.strictEqual(
                await cli.makeQueryEpochMarker(CONFIG, empty.connect, env)('XChain_BTC_Indexer'), null);

            const blank = fakeConnect({ rows: [{ batch_tag: null }] });
            assert.strictEqual(
                await cli.makeQueryEpochMarker(CONFIG, blank.connect, env)('XChain_BTC_Indexer'), null);
        });

        it('returns null for an unknown database without opening a connection', async function () {
            const { connect, log } = fakeConnect({ rows: [{ batch_tag: '' }] });
            assert.strictEqual(
                await cli.makeQueryEpochMarker(CONFIG, connect, { XC637_DB_PASS: 'v' })('ghost'), null);
            assert.strictEqual(log.opts.length, 0);
        });

        it('swallows a missing password here, because a marker is only corroboration', async function () {
            const { connect } = fakeConnect({ rows: [{ batch_tag: '' }] });
            assert.strictEqual(
                await cli.makeQueryEpochMarker(CONFIG, connect, {})('XChain_BTC_Indexer'), null);
        });

        it('coerces a non-string tag rather than leaking a driver type', async function () {
            const { connect } = fakeConnect({ rows: [{ batch_tag: 637 }] });
            const out = await cli.makeQueryEpochMarker(CONFIG, connect, { XC637_DB_PASS: 'v' })
                                 ('XChain_BTC_Indexer');
            assert.strictEqual(out, '637');
        });
    });

    describe('the config file', function () {

        it('parses a config from disk and resolves a relative path', function () {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xc1252-cfg-'));
            const p = path.join(dir, 'sweep.json');
            fs.writeFileSync(p, JSON.stringify(CONFIG));
            assert.deepStrictEqual(cli.loadConfig(p), CONFIG);
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it('throws on malformed JSON so the run exits 2 rather than sweeping nothing', function () {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xc1252-cfg-'));
            const p = path.join(dir, 'bad.json');
            fs.writeFileSync(p, '{ "stores": [ ');
            assert.throws(() => cli.loadConfig(p));
            fs.rmSync(dir, { recursive: true, force: true });
        });
    });

    describe('the sweep wiring end to end', function () {

        it('feeds both readers into sweepFleet and fails a surviving store', async function () {
            // A store whose table predates the window is the one thing this tool exists to
            // catch, so prove it survives the CLI wiring and not just the sweeper's own tests.
            const config = {
                window_open: '2026-08-01 00:00:00',
                batch_tag: '',
                stores: [{ label: 'LTC', database: 'db1', replayed: ['blocks'] }]
            };
            const connect = async () => ({
                query: async (sql) => {
                    if (sql === sweeper.SESSION_UTC_SQL) return [];
                    if (sql === cli.EPOCH_MARKER_SQL) return [{ batch_tag: '' }];
                    return [{ TABLE_NAME: 'blocks', CREATE_TIME: '2026-07-20 09:00:00' }];
                },
                end: async () => {}
            });
            const env = { XC637_DB_PASS: 'v' };
            const result = await sweeper.sweepFleet(config, {
                queryCreateTimes: cli.makeQueryCreateTimes(config, connect, env),
                queryEpochMarker: cli.makeQueryEpochMarker(config, connect, env)
            });
            assert.strictEqual(result.pass, false,
                'a pre-window CREATE_TIME must fail even with a matching epoch marker');
        });

        it('passes a store whose tables were all rebuilt inside the window', async function () {
            const config = {
                window_open: '2026-08-01 00:00:00',
                batch_tag: '',
                stores: [{ label: 'LTC', database: 'db1', replayed: ['blocks'] }]
            };
            const connect = async () => ({
                query: async (sql) => {
                    if (sql === sweeper.SESSION_UTC_SQL) return [];
                    if (sql === cli.EPOCH_MARKER_SQL) return [{ batch_tag: '' }];
                    return [{ TABLE_NAME: 'blocks', CREATE_TIME: '2026-08-01 02:30:00' }];
                },
                end: async () => {}
            });
            const env = { XC637_DB_PASS: 'v' };
            const result = await sweeper.sweepFleet(config, {
                queryCreateTimes: cli.makeQueryCreateTimes(config, connect, env),
                queryEpochMarker: cli.makeQueryEpochMarker(config, connect, env)
            });
            assert.strictEqual(result.pass, true);
        });
    });

    describe('the entrypoint guard', function () {

        it('exports the helpers without running the sweep on require', function () {
            assert.strictEqual(typeof cli.main, 'function');
            assert.strictEqual(typeof cli.makeQueryCreateTimes, 'function');
        });
    });
});
