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
 * The audit gate: reads a version 2 `npm audit --omit=dev --json` report and
 * fails when a high or critical production advisory is not accepted in the
 * exceptions ledger.
 *
 * USAGE
 *   node bin/audit_gate.js                      run the audit live, as CI does
 *   npm audit --omit=dev --json | node bin/audit_gate.js --input -
 *   node bin/audit_gate.js --input <report.json> [--exceptions <ledger.md>]
 *
 *   --input <path>       the report to read; `-` is standard input. Without it
 *                        the gate runs `npm audit --omit=dev --json` in the repo
 *   --exceptions <path>  the ledger; replaces <repo root>/AUDIT-EXCEPTIONS.md
 *
 * Each flag may appear at most once, in either order.
 *
 * LEDGER. A markdown file. A level-two heading that contains a GHSA id
 * accepts that advisory. Nothing else in the file accepts anything.
 *
 * EXIT CODES
 *   0  every high or critical production record is accepted
 *   1  at least one is not (each is listed on standard error)
 *   2  usage error, unreadable input, a failed audit run, or a report that is
 *      not version 2
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_LEDGER = path.join(REPO, 'AUDIT-EXCEPTIONS.md');
const GATED = new Set(['high', 'critical']);
const GHSA = /GHSA(?:-[2-9cfghjmpqrvwx]{4}){3}/gi;

class UsageError extends Error {}

function parseArgs(argv) {
    const opts = { input: null, exceptions: null };
    const flags = { '--input': 'input', '--exceptions': 'exceptions' };
    for (let i = 0; i < argv.length; i++) {
        const key = flags[argv[i]];
        if (!key) throw new UsageError(`unknown argument: ${argv[i]}`);
        if (opts[key] !== null) throw new UsageError(`${argv[i]} given more than once`);
        const value = argv[++i];
        if (value === undefined || value.startsWith('--')) {
            throw new UsageError(`${argv[i - 1]} needs a path`);
        }
        opts[key] = value;
    }
    return opts;
}

function acceptedIds(markdown) {
    const ids = new Set();
    for (const line of markdown.split(/\r?\n/)) {
        if (!/^##(?!#)\s/.test(line)) continue;
        for (const id of line.match(GHSA) || []) ids.add(id.toLowerCase());
    }
    return ids;
}

function advisoryId(via) {
    const found = String(via.url || '').match(GHSA);
    return found ? found[0].toLowerCase() : null;
}

// One record per gated advisory, plus one per gated package that carries no
// advisory of its own and so cannot be matched by id.
function gatedRecords(report) {
    const records = [];
    const vulns = report.vulnerabilities || {};
    for (const name of Object.keys(vulns)) {
        const vuln = vulns[name];
        if (!vuln || !GATED.has(vuln.severity)) continue;
        const advisories = (Array.isArray(vuln.via) ? vuln.via : []).filter(
            (v) => v && typeof v === 'object' && GATED.has(v.severity)
        );
        if (advisories.length === 0) {
            // Reached only through another package: that package's own advisory
            // is the record that has to be accepted.
            if (Array.isArray(vuln.via) && vuln.via.length > 0 && vuln.via.every((v) => typeof v === 'string')) continue;
            records.push({ pkg: name, id: null, severity: vuln.severity, title: '' });
            continue;
        }
        for (const adv of advisories) {
            records.push({
                pkg: name,
                id: advisoryId(adv),
                severity: adv.severity,
                title: adv.title || '',
            });
        }
    }
    return records;
}

function readText(file) {
    try {
        return fs.readFileSync(file === '-' ? 0 : file, 'utf8');
    } catch (err) {
        throw new UsageError(`cannot read ${file === '-' ? 'standard input' : file}: ${err.message}`);
    }
}

// npm audit exits 1 whenever it finds any advisory at all, so 0 and 1 both
// carry a report; the gate, not npm's exit code, decides what fails.
function runAudit() {
    const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
        cwd: REPO,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw new UsageError(`cannot run npm audit: ${result.error.message}`);
    if (result.status !== 0 && result.status !== 1) {
        throw new UsageError(`npm audit exited ${result.status}${result.stderr ? ': ' + result.stderr.trim() : ''}`);
    }
    return result.stdout;
}

function run(argv) {
    const opts = parseArgs(argv);

    let report;
    try {
        report = JSON.parse(opts.input === null ? runAudit() : readText(opts.input));
    } catch (err) {
        if (err instanceof UsageError) throw err;
        throw new UsageError(`the report is not valid JSON: ${err.message}`);
    }
    if (!report || typeof report !== 'object' || report.auditReportVersion !== 2) {
        throw new UsageError('the report is not an auditReportVersion 2 report');
    }

    let ledger = '';
    if (opts.exceptions !== null) {
        ledger = readText(opts.exceptions);
    } else if (fs.existsSync(DEFAULT_LEDGER)) {
        ledger = readText(DEFAULT_LEDGER);
    }
    const accepted = acceptedIds(ledger);

    const open = gatedRecords(report).filter((r) => !r.id || !accepted.has(r.id));
    if (open.length === 0) {
        console.log('audit gate: every high or critical production record is accepted');
        return 0;
    }
    for (const r of open) {
        console.error(
            `audit gate: not accepted: ${r.pkg} ${r.severity} ${r.id ? r.id.replace(/^ghsa/, 'GHSA') : '(no advisory id)'}${r.title ? ' ' + r.title : ''}`
        );
    }
    console.error(`audit gate: ${open.length} unaccepted record(s)`);
    return 1;
}

if (require.main === module) {
    try {
        process.exitCode = run(process.argv.slice(2));
    } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        console.error(`audit gate: ${err.message}`);
        process.exitCode = 2;
    }
}

module.exports = { run, parseArgs, acceptedIds, gatedRecords };
