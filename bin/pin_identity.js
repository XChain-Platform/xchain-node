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
 * The identity pin: the sha256 of every file this repo vendors in rather than
 * owns.
 *
 * WHY IT IS A SEPARATE PIN FROM THE SUITE MAP. The suite map proves what still
 * runs; this proves what was not touched. The coin registry is refreshed from
 * its canonical repo by a sync script, so any edit made here is drift that the
 * next refresh silently reverts, and every consumer's drift tier goes red in
 * the meantime. A restructure has no business changing one byte of it, and the
 * cheapest way to say so is a hash taken before a restructure and re-taken at the
 * end.
 *
 * USAGE
 *   node bin/pin_identity.js <out-file>
 *   node bin/pin_identity.js --compare <pin-file>     exit 1 on any difference
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');

// The vendored coin registry, refreshed by the platform's sync-coins.sh.
const VENDORED = [
    'src/coins/BTC.js',
    'src/coins/DOGE.js',
    'src/coins/LTC.js',
    'src/coins/consensus_pin.js',
    'src/coins/index.js'
];

function measure() {
    const files = {};
    for (const rel of VENDORED) {
        const buf = fs.readFileSync(path.join(REPO, rel));
        files[rel] = crypto.createHash('sha256').update(buf).digest('hex');
    }
    return { repo: 'xchain-node', vendored: 'src/coins (sync-coins.sh)', files };
}

function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--compare') {
        const pin  = JSON.parse(fs.readFileSync(args[1], 'utf8'));
        const now  = measure();
        const bad  = Object.keys(pin.files).filter(f => pin.files[f] !== now.files[f]);
        const gone = Object.keys(pin.files).filter(f => !(f in now.files));
        if (bad.length || gone.length) {
            console.error(`identity pin BROKEN: ${[...new Set([...bad, ...gone])].join(', ')}`);
            process.exit(1);
        }
        console.log(`identity pin holds: ${Object.keys(now.files).length} vendored files unchanged`);
        return;
    }
    const out = args[0];
    if (!out) {
        console.error('usage: node bin/pin_identity.js <out-file> | --compare <pin-file>');
        process.exit(2);
    }
    fs.writeFileSync(out, `${JSON.stringify(measure(), null, 2)}\n`);
    console.log(`wrote ${VENDORED.length} vendored hashes to ${out}`);
}

main();
