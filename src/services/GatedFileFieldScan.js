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
 * XChain Node - nine-field FILE scan (spec section 7, pre-window gate)
 *
 * PC-29 adds an optional ninth field to FILE format 0 (GATE_MIN_AMOUNT) and validates it
 * STRICT: a present-but-invalid threshold makes the FILE invalid rather than being
 * dropped. That is replay-safe only while no conforming emitter has ever produced a
 * nine-field FILE, which is true of the SDK/wallet path (the SDK drops unknown positional
 * fields, so it cannot have emitted one). A HAND-CRAFTED nine-field FILE somewhere in
 * history is a different matter: under the new rules it may flip from valid to invalid,
 * which moves ledger state during the rebase. The spec therefore gates the window on
 * scanning every network for one, and treats any hit as an operator decision.
 *
 * THE TRAP THIS TOOL EXISTS TO AVOID, stated first because it is the whole point.
 *
 * The obvious place to look is the indexer's stored action params. That scan CANNOT find
 * anything: `utility.setActionParams` iterates the FORMAT's field list, so a tenth token
 * on the wire is never read and never stored. Scanning stored params therefore returns
 * zero hits on a chain that has one, i.e. it false-greens by construction and the gate
 * would certify the opposite of what it checked.
 *
 * So the scan runs over the RAW decoded payload upstream of that truncation: the
 * decoder's `transactions.data` column, which holds the decoded action string exactly as
 * it appeared on chain, before any format-aware parsing.
 *
 * WHAT COUNTS AS A HIT
 *
 * FILE format 0 is VERSION|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH:
 * eight fields after the action name. A ninth field is a hit ONLY when it is non-empty.
 * The encoder strips trailing empty fields, but a third-party composer may not, and a
 * trailing empty ninth field means exactly "no threshold" under the new rules as well as
 * the old, so it changes nothing and must not be reported. Reporting it would bury a real
 * hit in noise, which is how a gate stops being read.
 *
 * BATCH is unwrapped (';' separates commands), because a FILE inside a BATCH is still a
 * FILE on chain, and a scan that only looked at top-level actions would miss exactly the
 * composition the gating flow itself uses (BATCH(FILE, MESSAGE-to-self)).
 ********************************************************************/

'use strict';

// Fields after the action name in FILE format 0, pre-PC-29.
const FILE_V0_FIELD_COUNT = 8;

/**
 * Split a decoded payload into its component action strings. A BATCH carries ';'
 * separated commands; anything else is a single command. Empty segments are dropped
 * (a trailing ';' is not a command).
 */
function splitCommands(payload) {
    const s = String(payload === null || payload === undefined ? '' : payload);
    if (!s) return [];
    if (/^BATCH\|/i.test(s)) {
        // BATCH|VERSION|COMMAND;COMMAND;... - the commands begin after the version field.
        const parts = s.split('|');
        const rest  = parts.slice(2).join('|');
        return rest.split(';').map((c) => c.trim()).filter((c) => c.length > 0);
    }
    return [s.trim()].filter((c) => c.length > 0);
}

/**
 * Inspect one decoded action string. Returns null when it is not a nine-field FILE, or
 * { fields, ninth, tokens } when it is.
 *
 * Deliberately case-insensitive on the action name and tolerant of surrounding
 * whitespace, because this is a forensic scan over third-party bytes rather than a
 * validator: anything that the indexer WOULD dispatch as a FILE has to be considered.
 */
function inspectCommand(command) {
    const s = String(command || '').trim();
    if (!/^FILE\|/i.test(s)) return null;
    const tokens = s.split('|');
    const fields = tokens.slice(1);                 // drop the action name
    if (fields.length <= FILE_V0_FIELD_COUNT) return null;
    // Only format 0 carries the gating fields; a future FILE version with its own layout
    // is not this gate's business and is reported separately by the caller if desired.
    const version = String(fields[0] || '').trim();
    const ninth   = String(fields[FILE_V0_FIELD_COUNT] || '');
    if (ninth.trim() === '') return null;           // trailing empty = "no threshold", a no-op
    return { version, fields: fields.length, ninth, tokens: tokens.length };
}

/**
 * Scan a batch of decoder rows.
 *
 * @param {Array<object>} rows  [{ tx_index, block_index, hash, data }]
 * @returns {object} { scanned, hits: [{ tx_index, block_index, hash, version, fields, ninth }] }
 */
function scanRows(rows) {
    const hits = [];
    let scanned = 0;
    for (const r of (rows || [])) {
        scanned++;
        for (const cmd of splitCommands(r.data)) {
            const hit = inspectCommand(cmd);
            if (hit) {
                hits.push({
                    tx_index:    r.tx_index !== undefined ? r.tx_index : null,
                    block_index: r.block_index !== undefined ? r.block_index : null,
                    hash:        r.hash || null,
                    version:     hit.version,
                    fields:      hit.fields,
                    ninth:       hit.ninth
                });
            }
        }
    }
    return { scanned, hits };
}

/**
 * The decoder read. Keyset-paged on tx_index so a full mainnet scan streams rather than
 * loading every FILE transaction at once, and ordered so a resumed scan is deterministic.
 *
 * `data LIKE 'FILE|%' OR data LIKE 'BATCH|%'` is the widest useful filter: a FILE can
 * only reach the chain as a top-level FILE or inside a BATCH, and anything else cannot
 * dispatch as one. It is a filter on the RAW payload, never on parsed params, which is
 * the distinction this whole tool turns on.
 */
function scanSql(limit) {
    return 'SELECT t.tx_index, t.block_index, it.hash AS hash, t.data '
         + 'FROM transactions t '
         + 'LEFT JOIN index_transactions it ON it.id = t.tx_hash_id '
         + 'WHERE t.tx_index > ? AND (t.data LIKE ' + "'FILE|%'" + ' OR t.data LIKE ' + "'BATCH|%'" + ') '
         + 'ORDER BY t.tx_index ASC LIMIT ' + Number(limit);
}

/**
 * The size of the corpus the filtered scan ran against. Reported alongside the
 * scan, because "0 hits" over 0 rows and "0 hits" over 40k rows are different
 * facts and only one of them is a scan.
 *
 * This was not theoretical. The first fleet-wide run (2026-07-29) printed the
 * confident CLEAN verdict for nine of ten stores whose `transactions` table is
 * EMPTY, and the report gave the reader nothing to tell that apart from a real
 * scan. The verdict was true in both cases; the evidence behind it was not
 * comparable, and a gate that reads identically either way trains people to
 * skim it.
 */
function corpusSql() {
    return 'SELECT COUNT(*) AS payload_rows FROM transactions '
         + 'WHERE data IS NOT NULL AND data <> ' + "''";
}

/**
 * Human-readable gate result for the deploy report.
 *
 * `corpus` is the payload-bearing row count from corpusSql(), or null when it
 * was not measured. A null corpus is reported as unmeasured rather than
 * silently omitted: the whole point is that the reader can see which kind of
 * clean this is.
 */
function formatReport(scan, label, corpus) {
    const lines = [];
    const known = (corpus !== undefined && corpus !== null && Number.isFinite(Number(corpus)));
    const n     = known ? Number(corpus) : null;
    lines.push('nine-field FILE scan: ' + (label || 'store'));
    lines.push('payload rows scanned: ' + scan.scanned +
               (known ? ' of ' + n + ' payload-bearing rows in the store' : '') +
               '  (raw decoder payloads, upstream of format truncation)');
    if (scan.hits.length === 0) {
        if (known && n === 0) {
            lines.push('RESULT: CLEAN BY EMPTINESS - this store holds NO payload rows at all, so');
            lines.push('        nothing here could carry a ninth field. That is a valid answer for');
            lines.push('        the gate, but it is NOT evidence that the scan works: read it as');
            lines.push('        "nothing to examine", not as "examined and found nothing".');
            return lines.join('\n');
        }
        if (!known) {
            lines.push('RESULT: CLEAN over the rows scanned, corpus size UNMEASURED - rerun with the');
            lines.push('        corpus query so a clean-by-emptiness store cannot read as a scan.');
            return lines.join('\n');
        }
        lines.push('RESULT: CLEAN - no FILE carries a non-empty ninth field, so STRICT');
        lines.push('        GATE_MIN_AMOUNT validation cannot flip any historical FILE.');
        return lines.join('\n');
    }
    lines.push('RESULT: ' + scan.hits.length + ' HIT(S) - each one is an operator decision BEFORE the window:');
    for (const h of scan.hits) {
        lines.push('  block ' + h.block_index + ' tx ' + h.tx_index + (h.hash ? ' (' + h.hash + ')' : ''));
        lines.push('        FILE v' + h.version + ' carries ' + h.fields + ' fields; ninth = ' + JSON.stringify(h.ninth));
    }
    lines.push('');
    lines.push('Under STRICT validation a ninth field that is not a valid GATE_MIN_AMOUNT makes');
    lines.push('the FILE invalid, which moves ledger state on replay. Adjudicate before the window,');
    lines.push('not in the middle of it.');
    return lines.join('\n');
}

module.exports = {
    FILE_V0_FIELD_COUNT, splitCommands, inspectCommand, scanRows, scanSql, corpusSql, formatReport
};
