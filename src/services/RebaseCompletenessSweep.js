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
 * XChain Node - rebase-completeness sweep ( spec section 6.1)
 *
 * The one invariant that makes the  batch safe ungated is that the rebase is
 * universal: after it, NO service keeps pre-batch derived state. An ungated consensus
 * change applied from a long-running node's current tip diverges from the same change
 * applied by a node replaying from genesis, so a single survivor forks the fleet.
 *
 * A checklist cannot establish that. Nothing on it distinguishes a replayed store from
 * a silent survivor, and silent survivors are the whole risk. This sweep establishes it
 * from the stores themselves.
 *
 * WHAT IT ASSERTS, and why it is this rather than a marker row.
 *
 * The spec's first sketch was a `consensus_epoch` row stamped at replay start, with the
 * warning that the stamp must be bound to the WIPE and not to the CODE: new code booting
 * over a surviving old DB would happily write the marker, proving only that new code ran.
 * Binding a row to the wipe means teaching four services to recognise their own
 * freshness, and every one of those checks is a place to get it subtly wrong.
 *
 * The database already records the fact, unforgeably and uniformly:
 * `information_schema.TABLES.CREATE_TIME`. A table that was dropped and recreated (what
 * `verifyTables` does against a dropped-and-recreated store) carries a CREATE_TIME after
 * the window opened. A survivor carries an older one, and no amount of new code writing
 * rows into it can move that timestamp. So the assertion is:
 *
 *   for every REPLAYED table of every inventoried store: CREATE_TIME >= window_open
 *
 * ONE OPERATIONAL REQUIREMENT FALLS OUT OF THAT, and it was measured rather than assumed:
 * on MariaDB 11.4/InnoDB, `TRUNCATE TABLE` does NOT refresh CREATE_TIME. A store reset by
 * truncation therefore reads as a survivor and this sweep FAILS it. That is the
 * fail-closed direction (it blocks the window rather than blessing it), but it means the
 * reset must be DROP DATABASE + recreate, which is what the standing reindex procedure
 * does anyway. If a future runbook switches any store to truncation, this check has to
 * change with it or it will block a window that was actually fine.
 *
 * The epoch marker is still honoured when a store has one (`consensus_epoch` carrying
 * the batch tag), because a service that already exposes a replay cursor or a sync-state
 * row is explicitly allowed to satisfy the check that way. It is treated as CORROBORATION
 * and never as a substitute: a store whose marker is present but whose tables predate the
 * window is exactly the vacuous-marker case, and it FAILS.
 *
 * WHICH TABLES, and why the caller must say.
 *
 * Only REPLAYED tables can be asserted. A REGENERATED table (LLM-judged attestations,
 * price rounds from live feeds, hub-side governance) may legitimately sit empty and
 * untouched long after the window, and a KEPT table (configs, keys, peer registry) is
 * SUPPOSED to predate it. Asserting over those produces false failures that teach an
 * operator to ignore the tool. The bucket lists come from the section 3.1 inventory
 * (claude/reports/launch/2026-07-29_xc637-state-reset-inventory.md), which is why this
 * module takes them as input rather than discovering tables itself: discovering them
 * would silently re-classify whatever the inventory decided.
 *
 * FAIL-CLOSED. An unreadable store, a missing table, an absent CREATE_TIME and an
 * unparseable one are all failures, not skips. The question being answered is "did every
 * store really rebase", and "I could not tell" is not a yes.
 ********************************************************************/

'use strict';

const BATCH_TAG = '';

// Verdict codes, kept stable so the deploy report can cite them.
const OK                = 'ok';
const STALE_TABLE       = 'stale_table';        // survived the window: CREATE_TIME predates it
const MISSING_TABLE     = 'missing_table';      // inventoried but absent from the store
const NO_CREATE_TIME    = 'no_create_time';     // engine reported none; cannot establish freshness
const UNREADABLE        = 'unreadable';         // the store could not be queried at all
const NO_TABLES_CHECKED = 'no_tables_checked';  // an empty REPLAYED list proves nothing

/**
 * Normalize a timestamp from information_schema (Date, string or epoch seconds/ms) to
 * epoch milliseconds, or null when it cannot be established. A NULL CREATE_TIME is a
 * real answer from some engines and must not read as 0 (which would compare as ancient
 * and fail for the wrong reason) nor as now (which would pass for the wrong reason).
 */
function toEpochMs(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return null;
        // Seconds vs milliseconds: anything below ~1e11 is seconds (year 5138 in ms).
        return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
    }
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return toEpochMs(Number(s));
    // MariaDB DATETIME text ('2026-07-29 14:03:11') has no zone; treat it as UTC
    // deliberately, and require the caller's window_open to be UTC too. Guessing local
    // time here would shift the comparison by hours in exactly the direction that
    // silently passes a survivor.
    //
    // Only stamp the zone when the value does not already carry one: a driver that returns
    // a full ISO string ('...T02:30:00Z', or with a +HH:MM offset) would otherwise get a
    // SECOND designator appended and become unparseable, i.e. reported as "freshness cannot
    // be established" for a perfectly good timestamp. Caught by this module's own test.
    const dateShaped = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s);
    const hasZone    = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
    const iso = (dateShaped && !hasZone) ? s.replace(' ', 'T') + 'Z' : s;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
}

/**
 * Sweep one store.
 *
 * @param {object} store            { label, replayed: string[], skipped?: string[] }
 * @param {object} opts
 * @param {number} opts.windowOpenMs  UTC epoch ms when the maintenance window opened
 * @param {function} opts.queryCreateTimes  async (dbName, tables) => Array<{table_name, create_time}>
 * @param {function} [opts.queryEpochMarker] async (dbName) => string|null  (batch tag, if any)
 * @returns {Promise<object>} { label, pass, code, checked, failures[], markerTag }
 */
async function sweepStore(store, opts) {
    const label    = store.label || store.database || '(unnamed store)';
    const replayed = Array.isArray(store.replayed) ? store.replayed : [];
    const result   = { label, database: store.database, pass: false, code: OK, checked: 0,
                       failures: [], markerTag: null, skipped: (store.skipped || []).length };

    if (replayed.length === 0) {
        // An empty list is not a pass. It is the shape a mis-wired config takes, and it
        // would report green for a store nobody actually checked.
        result.code = NO_TABLES_CHECKED;
        result.failures.push({ table: null, code: NO_TABLES_CHECKED,
            detail: 'no REPLAYED tables configured for this store' });
        return result;
    }

    let rows;
    try {
        rows = await opts.queryCreateTimes(store.database, replayed);
    } catch (e) {
        result.code = UNREADABLE;
        result.failures.push({ table: null, code: UNREADABLE, detail: String((e && e.message) || e) });
        return result;
    }

    const byTable = new Map();
    for (const r of (rows || [])) {
        const name = String(r.table_name !== undefined ? r.table_name : r.TABLE_NAME || '').toLowerCase();
        if (name) byTable.set(name, r.create_time !== undefined ? r.create_time : r.CREATE_TIME);
    }

    for (const t of replayed) {
        const key = String(t).toLowerCase();
        if (!byTable.has(key)) {
            result.failures.push({ table: t, code: MISSING_TABLE,
                detail: 'inventoried as REPLAYED but not present in the store' });
            continue;
        }
        const ms = toEpochMs(byTable.get(key));
        if (ms === null) {
            result.failures.push({ table: t, code: NO_CREATE_TIME,
                detail: 'engine reported no CREATE_TIME, so freshness cannot be established' });
            continue;
        }
        result.checked++;
        if (ms < opts.windowOpenMs) {
            result.failures.push({ table: t, code: STALE_TABLE,
                detail: 'CREATE_TIME ' + new Date(ms).toISOString() + ' predates the window opening '
                        + new Date(opts.windowOpenMs).toISOString() + ': this table survived the rebase' });
        }
    }

    // Corroboration only. A marker cannot rescue a stale table, and its absence cannot
    // fail a store whose tables all postdate the window.
    if (typeof opts.queryEpochMarker === 'function') {
        try { result.markerTag = await opts.queryEpochMarker(store.database); }
        catch (_e) { result.markerTag = null; }
    }

    if (result.failures.length > 0) {
        result.code = result.failures[0].code;
        result.pass = false;
    } else {
        result.pass = true;
        result.code = OK;
    }
    return result;
}

/**
 * Sweep every inventoried store. Never throws on a store-level fault: an unreadable
 * store is a reported failure, because a sweep that dies on the first bad store hides
 * how many others are bad.
 *
 * @returns {Promise<object>} { pass, windowOpen, stores[], summary }
 */
async function sweepFleet(config, opts) {
    const stores = Array.isArray(config && config.stores) ? config.stores : [];
    const windowOpenMs = toEpochMs(config && config.window_open);
    if (windowOpenMs === null)
        throw new Error('config.window_open is required (UTC): without it every store trivially passes');
    if (stores.length === 0)
        throw new Error('config.stores is empty: the sweep must be driven from the section 3.1 inventory');

    const results = [];
    for (const s of stores)
        results.push(await sweepStore(s, Object.assign({}, opts, { windowOpenMs })));

    const failed = results.filter((r) => !r.pass);
    return {
        pass: failed.length === 0,
        batchTag: (config && config.batch_tag) || BATCH_TAG,
        windowOpen: new Date(windowOpenMs).toISOString(),
        stores: results,
        summary: {
            stores: results.length,
            passed: results.length - failed.length,
            failed: failed.length,
            tablesChecked: results.reduce((n, r) => n + r.checked, 0),
            survivors: results.reduce((n, r) => n + r.failures.filter((f) => f.code === STALE_TABLE).length, 0)
        }
    };
}

/**
 * The information_schema read, as its own function so the CLI and tests share one shape.
 *
 * CREATE_TIME is returned as UNIX_TIMESTAMP, computed BY THE SERVER, and the caller must
 * pin the session to `time_zone = '+00:00'` first. That is not fussiness; the naive form
 * of this query silently passes survivors, which a real run proved:
 *
 *   MariaDB returns CREATE_TIME as a zone-less DATETIME in the SESSION time zone. The
 *   driver then builds a JS Date by interpreting those digits in the CLIENT's LOCAL zone.
 *   On a host at UTC-7 a table created at 23:26:38 UTC came back as 06:26:38 the next day
 *   UTC, i.e. seven hours in the future, so a table that predated the window compared as
 *   fresh and the sweep reported PASS on a store that had not rebased at all.
 *
 * Asking the server for epoch seconds under a pinned UTC session removes every zone from
 * the path: no driver conversion, no client locale, and nothing left for this module to
 * guess. The failure direction is what makes it worth the ceremony - the naive version
 * does not error, it certifies a fork.
 */
function createTimeSql(tableCount) {
    return 'SELECT TABLE_NAME AS table_name, UNIX_TIMESTAMP(CREATE_TIME) AS create_time '
         + 'FROM information_schema.TABLES '
         + 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (' + new Array(tableCount).fill('?').join(', ') + ')';
}

/** The session pin the read above depends on. Run it on the same connection, first. */
const SESSION_UTC_SQL = "SET SESSION time_zone = '+00:00'";

/** Human-readable report body; the CLI prints this and the deploy report can paste it. */
function formatReport(sweep) {
    const lines = [];
    lines.push(' rebase-completeness sweep (' + sweep.batchTag + ')');
    lines.push('window opened: ' + sweep.windowOpen);
    lines.push('');
    for (const s of sweep.stores) {
        const head = (s.pass ? 'PASS  ' : 'FAIL  ') + s.label
                   + '  [' + s.checked + ' replayed table(s) checked'
                   + (s.skipped ? ', ' + s.skipped + ' skipped by bucket' : '') + ']'
                   + (s.markerTag ? '  marker=' + s.markerTag : '');
        lines.push(head);
        for (const f of s.failures)
            lines.push('        ' + f.code + (f.table ? ' ' + f.table : '') + ': ' + f.detail);
    }
    lines.push('');
    lines.push('stores ' + sweep.summary.passed + '/' + sweep.summary.stores + ' passed, '
             + sweep.summary.tablesChecked + ' tables checked, '
             + sweep.summary.survivors + ' survivor(s)');
    if (!sweep.pass)
        lines.push('RESULT: FAIL - the rebase is not universal, which is the one invariant the '
                 + 'ungated batch depends on. Do not proceed to anchor publication.');
    else
        lines.push('RESULT: PASS - no store carries pre-batch derived state.');
    return lines.join('\n');
}

module.exports = {
    BATCH_TAG, OK, STALE_TABLE, MISSING_TABLE, NO_CREATE_TIME, UNREADABLE, NO_TABLES_CHECKED,
    toEpochMs, sweepStore, sweepFleet, createTimeSql, SESSION_UTC_SQL, formatReport
};
