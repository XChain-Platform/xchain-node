#!/usr/bin/env node
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
 *
 * The CLI print contract: what this tool exists to prove.
 *
 * The four user-facing paths below print straight to the console on purpose,
 * because their console IS the product a human reads. A restructure that
 * moves those files, renames their methods or routes anything through a logger
 * must leave every one of those prints saying exactly what it said before. A
 * test cannot assert that, because the prints are not assertions; so the pin is
 * the TEXT ITSELF, captured before the first edit and re-captured at the end.
 *
 * WHY THE PIN CARRIES NO PATHS AND NO LINE NUMBERS. A restructure renames files and
 * moves code between them by design, so a pin keyed on `file:line` would go red
 * on a move that changed nothing a user sees, and would hide a changed word in
 * the noise. The invariant that matters is the SET of printed texts, so the
 * comparison file is the sorted set. A second, path-keyed file is written
 * beside it for diagnosis only; it is expected to move.
 *
 * WHY IT ALSO SPAWNS THE CLI. Static text is what the source says; the help
 * surfaces are what a user actually gets, and they come from commander's
 * description strings rather than from a console call, so nothing above would
 * catch a mangled one. Every command's --help is driven in a child process and
 * the bytes are pinned.
 *
 * USAGE
 *   node bin/capture_cli_prints.js <out-dir>
 *
 ********************************************************************/

'use strict';

const fs            = require('fs');
const path          = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

// The four user-facing paths whose prints go to the console, not the logger.
// A path that is a directory contributes every .js file under it.
const PRINT_PATHS = ['src/ui', 'src/cli.js', 'src/operations', 'src/precheck.js'];

const CONSOLE_METHOD = /console\s*\.\s*([A-Za-z]+)\s*\(/g;

/**
 * Every .js file under one declared print path, repo-relative and sorted.
 */
function expandPath(rel) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isFile()) return [rel];
    const out = [];
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = path.join(rel, entry.name);
        if (entry.isDirectory()) out.push(...expandPath(child));
        else if (entry.name.endsWith('.js')) out.push(child);
    }
    return out.sort();
}

/**
 * Walk forward from an open paren to its match, skipping over anything that is
 * not code. A naive bracket count trips on the first `)` inside a printed
 * string, and half these calls print sentences with parentheses in them, so the
 * scanner has to know it is inside a quote, a template literal or a comment.
 */
function spanToCloseParen(src, openIdx) {
    let depth = 0;
    let i = openIdx;
    while (i < src.length) {
        const c = src[i];
        const c2 = src[i + 1];
        if (c === '/' && c2 === '/') {                       // line comment
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && c2 === '*') {                       // block comment
            i = src.indexOf('*/', i + 2);
            if (i < 0) return -1;
            i += 2;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {           // string body
            const quote = c;
            i++;
            while (i < src.length) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === quote) { i++; break; }
                // A ${...} hole can hold its own parens and quotes; recurse
                // through it rather than counting characters blind.
                if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
                    const end = spanToCloseBrace(src, i + 1);
                    if (end < 0) return -1;
                    i = end + 1;
                    continue;
                }
                i++;
            }
            continue;
        }
        if (c === '(') depth++;
        if (c === ')') {
            depth--;
            if (depth === 0) return i;
        }
        i++;
    }
    return -1;
}

/**
 * The `${...}` twin of the paren walker above, for template holes.
 */
function spanToCloseBrace(src, openIdx) {
    let depth = 0;
    let i = openIdx;
    while (i < src.length) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i++;
            while (i < src.length) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === quote) { i++; break; }
                i++;
            }
            continue;
        }
        if (c === '{') depth++;
        if (c === '}') {
            depth--;
            if (depth === 0) return i;
        }
        i++;
    }
    return -1;
}

/**
 * Collapse the whitespace a call's source carries so that re-indenting a block
 * (which a move does, and which no user can see) is not read as a text change.
 */
function normalize(text) {
    return text.replace(/\s+/g, ' ').trim();
}

function collectPrints() {
    const byFile = [];
    const texts  = [];
    for (const rel of PRINT_PATHS.flatMap(expandPath)) {
        const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
        CONSOLE_METHOD.lastIndex = 0;
        let m;
        while ((m = CONSOLE_METHOD.exec(src)) !== null) {
            const open  = src.indexOf('(', m.index);
            const close = spanToCloseParen(src, open);
            if (close < 0) throw new Error(`unbalanced console call in ${rel} at offset ${m.index}`);
            const record = `console.${m[1]}(${normalize(src.slice(open + 1, close))})`;
            texts.push(record);
            byFile.push(`${rel}\t${record}`);
            CONSOLE_METHOD.lastIndex = close;
        }
    }
    return { texts, byFile };
}

/**
 * Commander prints every command's help from its own description strings, so
 * the help surfaces are output no console call in this repo produces. Drive
 * each in a child process and keep the bytes.
 */
function driveHelp() {
    const cliSrc = fs.readFileSync(path.join(REPO, 'src/cli.js'), 'utf8');
    const names  = [...cliSrc.matchAll(/\.command\(\s*'([a-z0-9:-]+)'/g)].map(x => x[1]);
    const targets = ['--help', ...[...new Set(names)].sort().map(n => `${n} --help`)];
    const chunks = [];
    for (const target of targets) {
        const args = ['src/index.js', ...target.split(' ')];
        let out;
        try {
            out = execFileSync(process.execPath, args, {
                cwd: REPO,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, XCHAIN_NODE_SKIP_PRECHECK: '1' }
            });
        } catch (err) {
            // A help path that exits non-zero still printed; keep what it said.
            out = `${err.stdout || ''}${err.stderr || ''}`;
        }
        chunks.push(`===== xchain-node ${target} =====\n${out}`);
    }
    return chunks.join('\n');
}

function main() {
    const outDir = process.argv[2];
    if (!outDir) {
        console.error('usage: node bin/capture_cli_prints.js <out-dir>');
        process.exit(2);
    }
    fs.mkdirSync(outDir, { recursive: true });

    const { texts, byFile } = collectPrints();
    fs.writeFileSync(path.join(outDir, 'print-texts.txt'), `${texts.slice().sort().join('\n')}\n`);
    fs.writeFileSync(path.join(outDir, 'print-texts-by-file.txt'), `${byFile.slice().sort().join('\n')}\n`);
    fs.writeFileSync(path.join(outDir, 'driven-help.txt'), driveHelp());
    console.log(`captured ${texts.length} print texts from ${PRINT_PATHS.join(' ')} into ${outDir}`);
}

main();
