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
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildMap, compare, expand } = require('../suite-title-map.js');

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'bin', 'suite-title-map.js');
const SCRIPT = 'test:boundary';
const FILE = 'test/unit/example.test.js';

function mapOf(files, script = 'test') {
    const titleSets = {};
    const refs = {};
    let index = 0;
    for (const [file, titles] of Object.entries(files)) {
        const key = `set${index += 1}`;
        titleSets[key] = titles;
        refs[file] = key;
    }
    return { titleSets, scripts: { [script]: { files: refs } } };
}

function cloneFiles(files) {
    return Object.fromEntries(Object.entries(files).map(([file, titles]) => [file, titles.slice()]));
}

function runCli(dir, name, files, extraArgs = []) {
    const pin = path.join(dir, `${name}.json`);
    fs.writeFileSync(pin, JSON.stringify(mapOf(files, SCRIPT)));
    return spawnSync(process.execPath, [CLI, '--compare', pin, '--script', SCRIPT, ...extraArgs], {
        cwd: ROOT,
        encoding: 'utf8',
    });
}

function writeSplit(dir, name, old, parts, pinBefore) {
    const split = path.join(dir, `${name}.json`);
    const record = { splits: { [old]: parts } };
    if (pinBefore) record.pin_before_sha256 = pinBefore;
    fs.writeFileSync(split, JSON.stringify(record));
    return split;
}

describe('suite title comparison classifies additive and subtractive changes', () => {
    it('reports an added file', () => {
        const diffs = compare(mapOf({}), mapOf({ [FILE]: ['one'] }), {}, undefined);
        assert.deepStrictEqual(diffs.map((diff) => diff.kind), ['file_added']);
    });

    it('reports an added title', () => {
        const diffs = compare(mapOf({ [FILE]: ['one'] }), mapOf({ [FILE]: ['one', 'two'] }), {}, undefined);
        assert.deepStrictEqual(diffs.map((diff) => diff.kind), ['title_added']);
    });

    it('reports a dropped file', () => {
        const diffs = compare(mapOf({ [FILE]: ['one'] }), mapOf({}), {}, undefined);
        assert.deepStrictEqual(diffs.map((diff) => diff.kind), ['file_dropped']);
    });

    it('reports a dropped title', () => {
        const diffs = compare(mapOf({ [FILE]: ['one', 'two'] }), mapOf({ [FILE]: ['one'] }), {}, undefined);
        assert.deepStrictEqual(diffs.map((diff) => diff.kind), ['title_dropped']);
    });
});

describe('suite title comparison CLI keeps structural changes blocking', () => {
    let dir;
    let current;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-title-blocking-'));
        current = expand(buildMap(SCRIPT), SCRIPT);
    });

    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('rejects script and split record differences', () => {
        const scriptPin = path.join(dir, 'script.json');
        fs.writeFileSync(scriptPin, JSON.stringify(mapOf(current)));
        const scriptResult = spawnSync(process.execPath, [CLI, '--compare', scriptPin, '--script', SCRIPT], {
            cwd: ROOT, encoding: 'utf8',
        });
        assert.strictEqual(scriptResult.status, 1, scriptResult.stderr);
        assert.match(scriptResult.stdout, /script added/);

        const split = path.join(dir, 'invalid-split.json');
        fs.writeFileSync(split, JSON.stringify({ splits: { [FILE]: ['one-part'] } }));
        const splitResult = runCli(dir, 'split-record', current, ['--split-map', split]);
        assert.strictEqual(splitResult.status, 1, splitResult.stderr);
        assert.match(splitResult.stdout, /split_record/);
    });

    it('rejects a pending split that collides with a pinned file', () => {
        const pin = cloneFiles(current);
        const [old, collision, newPart] = Object.keys(pin);
        delete pin[newPart];
        const split = writeSplit(dir, 'partial-split', old, [old, collision, newPart]);
        const result = runCli(dir, 'partial-split-pin', pin, ['--split-map', split]);
        assert.strictEqual(result.status, 1, result.stderr);
        assert.match(result.stdout, /split_part_collides/);
    });
});

describe('suite title comparison CLI grades split record applicability', () => {
    let dir;
    let current;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-title-splits-'));
        current = expand(buildMap(SCRIPT), SCRIPT);
    });

    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('rejects an absorbed split record', () => {
        const [old, part] = Object.keys(current);
        const split = writeSplit(dir, 'absorbed-split', old, [old, part]);
        const result = runCli(dir, 'absorbed-split-pin', current, ['--split-map', split]);
        assert.strictEqual(result.status, 1, result.stderr);
        assert.match(result.stdout, /split_part_collides/);
    });

    it('does not apply a split record tied to an earlier pin', () => {
        const [old, part] = Object.keys(current);
        const split = writeSplit(dir, 'earlier-split', old, [old, part], '0'.repeat(64));
        const result = runCli(dir, 'retaken-pin', current, ['--split-map', split]);
        assert.strictEqual(result.status, 0, result.stderr);
        assert.match(result.stdout, /suite identity holds/);
    });
});

describe('suite title comparison CLI exit status', () => {
    let dir;
    let current;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-title-additive-'));
        current = expand(buildMap(SCRIPT), SCRIPT);
    });

    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('accepts and tags added files and titles as growth', () => {
        const pin = cloneFiles(current);
        const [addedFile, addedTitleFile] = Object.keys(pin);
        delete pin[addedFile];
        pin[addedTitleFile] = pin[addedTitleFile].slice(0, -1);
        const result = runCli(dir, 'growth', pin);
        assert.strictEqual(result.status, 0, result.stderr);
        assert.match(result.stdout, /additive growth only/);
        assert.match(result.stdout, /\[growth\].*file_added/);
        assert.match(result.stdout, /\[growth\].*title_added/);
    });

    it('rejects dropped files and titles', () => {
        const pin = cloneFiles(current);
        const [titleFile] = Object.keys(pin);
        pin[titleFile].push('suite title that was dropped');
        pin['test/boundary/dropped.test.js'] = ['dropped file title'];
        const result = runCli(dir, 'drops', pin);
        assert.strictEqual(result.status, 1, result.stderr);
        assert.match(result.stdout, /file_dropped/);
        assert.match(result.stdout, /title_dropped/);
    });

    it('keeps drops blocking when the same run also has growth', () => {
        const pin = cloneFiles(current);
        const [addedFile, titleFile] = Object.keys(pin);
        delete pin[addedFile];
        pin[titleFile].push('suite title that was dropped');
        const result = runCli(dir, 'mixed', pin);
        assert.strictEqual(result.status, 1, result.stderr);
        assert.match(result.stdout, /\[growth\].*file_added/);
        assert.match(result.stdout, /title_dropped/);
        assert.doesNotMatch(result.stdout, /additive growth only/);
    });
});
