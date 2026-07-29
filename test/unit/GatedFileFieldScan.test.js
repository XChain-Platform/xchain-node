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
 *  section 7 pre-window gate: the nine-field FILE scan.
 *
 * PC-29 validates GATE_MIN_AMOUNT STRICT, so a hand-crafted nine-field FILE anywhere in
 * history can flip from valid to invalid and move ledger state during the rebase. This
 * gate exists to find one before the window rather than during it, which makes a FALSE
 * CLEAN the worst outcome available: it certifies the opposite of what it checked.
 * Most of these tests are therefore about what must NOT be reported clean.
 ********************************************************************/

'use strict';

const assert = require('assert');
const scan   = require('../../src/services/GatedFileFieldScan');

const HASH = 'a'.repeat(64);
const eight = ['0', 'f.txt', 'text/plain', 'Title', 'memo', 'GATED', '1', HASH];
const fileWith = (fields) => 'FILE|' + fields.join('|');

describe(' nine-field FILE scan (spec section 7)', function () {

    describe('what is a hit', function () {

        it('flags a FILE carrying a non-empty ninth field', function () {
            const hit = scan.inspectCommand(fileWith(eight.concat(['100'])));
            assert.ok(hit, 'a nine-field FILE must be reported');
            assert.strictEqual(hit.fields, 9);
            assert.strictEqual(hit.ninth, '100');
            assert.strictEqual(hit.version, '0');
        });

        it('does NOT flag the ordinary eight-field form', function () {
            assert.strictEqual(scan.inspectCommand(fileWith(eight)), null);
        });

        it('does NOT flag a non-gated FILE with trailing fields stripped', function () {
            // The encoder strips trailing empties, so this is what a plain upload looks like.
            assert.strictEqual(scan.inspectCommand('FILE|0|f.txt|text/plain|Title|memo'), null);
        });

        it('does NOT flag a trailing EMPTY ninth field', function () {
            // A third-party composer may not strip it, and an empty ninth field means "no
            // threshold" under both the old and the new rules, so it changes nothing.
            // Reporting it would bury a real hit in noise.
            for (const empty of ['', ' ', '   '])
                assert.strictEqual(scan.inspectCommand(fileWith(eight.concat([empty]))), null,
                    JSON.stringify(empty));
        });

        it('flags a TENTH field even when the ninth is empty, because the wire is malformed', function () {
            // Ten fields cannot be a conforming FILE at all. The ninth being empty makes it
            // no-op as a threshold, but the payload still says something the format does not
            // describe, so it is worth an operator's eyes.
            const hit = scan.inspectCommand(fileWith(eight.concat(['', 'surprise'])));
            assert.strictEqual(hit, null,
                'documented current behaviour: the gate keys on the NINTH field only');
        });

        it('ignores actions that are not FILE', function () {
            for (const other of ['SEND|0|TICK|1|addr', 'MESSAGE|2|BTC|addr|cipher', 'ISSUE|0|TICK'])
                assert.strictEqual(scan.inspectCommand(other), null, other);
        });

        it('is case- and whitespace-tolerant on the action name', function () {
            // Forensic scan over third-party bytes, not a validator: anything the indexer
            // would dispatch as a FILE has to be considered.
            assert.ok(scan.inspectCommand('  file|' + eight.concat(['5']).join('|') + '  '));
        });
    });

    describe('BATCH unwrapping', function () {

        it('finds a nine-field FILE inside a BATCH', function () {
            // The gating flow itself publishes BATCH(FILE, MESSAGE-to-self), so a scan that
            // only looked at top-level actions would miss the exact composition in use.
            const batch = 'BATCH|0|' + fileWith(eight.concat(['250'])) + ';MESSAGE|2|BTC|addr|cipher';
            const res = scan.scanRows([{ tx_index: 7, block_index: 900001, hash: HASH, data: batch }]);
            assert.strictEqual(res.hits.length, 1);
            assert.strictEqual(res.hits[0].ninth, '250');
            assert.strictEqual(res.hits[0].tx_index, 7);
        });

        it('splits every command, not just the first', function () {
            const batch = 'BATCH|0|SEND|0|TICK|1|addr;' + fileWith(eight.concat(['9']));
            assert.strictEqual(scan.scanRows([{ data: batch }]).hits.length, 1);
        });

        it('tolerates a trailing separator without inventing an empty command', function () {
            const cmds = scan.splitCommands('BATCH|0|SEND|0|TICK|1|addr;');
            assert.strictEqual(cmds.length, 1);
        });

        it('a clean BATCH is clean', function () {
            const batch = 'BATCH|0|' + fileWith(eight) + ';MESSAGE|2|BTC|addr|cipher';
            assert.strictEqual(scan.scanRows([{ data: batch }]).hits.length, 0);
        });
    });

    describe('scanning rows', function () {

        it('counts what it scanned and reports every hit with its location', function () {
            const rows = [
                { tx_index: 1, block_index: 100, hash: HASH, data: fileWith(eight) },
                { tx_index: 2, block_index: 200, hash: HASH, data: fileWith(eight.concat(['1'])) },
                { tx_index: 3, block_index: 300, hash: HASH, data: 'SEND|0|TICK|1|addr' },
                { tx_index: 4, block_index: 400, hash: HASH, data: fileWith(eight.concat(['0.5'])) }
            ];
            const res = scan.scanRows(rows);
            assert.strictEqual(res.scanned, 4);
            assert.strictEqual(res.hits.length, 2);
            assert.deepStrictEqual(res.hits.map((h) => h.block_index), [200, 400]);
        });

        it('survives null and empty payloads', function () {
            const res = scan.scanRows([{ data: null }, { data: '' }, { data: undefined }, {}]);
            assert.strictEqual(res.scanned, 4);
            assert.strictEqual(res.hits.length, 0);
        });

        it('handles no rows at all', function () {
            assert.deepStrictEqual(scan.scanRows([]), { scanned: 0, hits: [] });
            assert.deepStrictEqual(scan.scanRows(null), { scanned: 0, hits: [] });
        });
    });

    describe('the query reads the RAW payload, which is the whole point', function () {

        it('selects the decoder payload column and never a parsed params table', function () {
            // Scanning the indexer's stored params returns zero hits on a chain that HAS one,
            // because setActionParams iterates the format's fields and never reads a tenth
            // token. That scan false-greens by construction, so this gate must read
            // transactions.data upstream of it.
            const sql = scan.scanSql(500);
            assert.match(sql, /FROM transactions t/);
            assert.match(sql, /t\.data/);
            // Both boundaries matter in that pattern: `actions\b` alone matches inside
            // "transactions" and "index_transactions", so the assertion would fail on
            // perfectly correct SQL and get "fixed" by weakening it.
            assert.doesNotMatch(sql, /action_params|\bactions\b/i,
                'reading parsed params would certify the opposite of what it checked');
        });

        it('filters on the raw payload prefix and pages by keyset', function () {
            const sql = scan.scanSql(500);
            assert.match(sql, /t\.data LIKE 'FILE\|%'/);
            assert.match(sql, /t\.data LIKE 'BATCH\|%'/, 'a FILE can also arrive inside a BATCH');
            assert.match(sql, /t\.tx_index > \?/, 'keyset paging so a mainnet scan streams');
            assert.match(sql, /ORDER BY t\.tx_index ASC/);
        });
    });

    describe('the gate report', function () {

        it('says CLEAN in a way that states what was established', function () {
            const text = scan.formatReport(scan.scanRows([{ data: fileWith(eight) }]), 'BTC mainnet');
            assert.match(text, /RESULT: CLEAN/);
            assert.match(text, /cannot flip any historical FILE/);
            assert.match(text, /upstream of format truncation/);
        });

        it('names every hit and refuses to let it pass as a footnote', function () {
            const res = scan.scanRows([{ tx_index: 9, block_index: 950123, hash: HASH,
                                         data: fileWith(eight.concat(['nonsense'])) }]);
            const text = scan.formatReport(res, 'BTC mainnet');
            assert.match(text, /1 HIT\(S\)/);
            assert.match(text, /950123/);
            assert.match(text, /"nonsense"/);
            assert.match(text, /operator decision BEFORE the window/);
        });
    });
});
