'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Every caller of bindPeerServices() hands it a require expression, and the
// resolution answers exactly what that expression would resolve for the
// caller file itself. A caller under a subdirectory part must adjust that
// expression back up to the services directory the peer files live in, or
// every PEER_SERVICE_FILES entry resolves to the wrong place. This suite
// finds every caller under src/ and proves, with real filesystem resolution
// and no stub, that each one resolves every peer file from its own location.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { expect } = require('chai');

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');
const { PEER_SERVICE_FILES } = require('../../src/services/peer_services');

function findCallerFiles(dir) {
    let out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out = out.concat(findCallerFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            const text = fs.readFileSync(full, 'utf8');
            if (text.includes('bindPeerServices(')) out.push({ file: full, text });
        }
    }
    return out;
}

// A caller passes bindPeerServices() one of two shapes: the plain `require`
// identifier (correct only when the caller lives directly under
// src/services/), or a wrapper that walks back up to src/services/ first
// (required for any caller one or more directories below that). Detect which
// shape a given caller uses from its own source, then resolve every peer
// file the same way that shape would at runtime.
function resolvesFromCallerPerspective(caller) {
    const requireFromCaller = Module.createRequire(caller.file);
    const isWrapped = /bindPeerServices\(\s*\(?\s*file\s*\)?\s*=>\s*require\(\s*path\.join\(\s*['"]\.\.['"],/.test(caller.text);

    for (const relFile of Object.values(PEER_SERVICE_FILES)) {
        const target = isWrapped ? path.join('..', relFile) : relFile;
        requireFromCaller.resolve(target);
    }
}

describe('peer_services: every bindPeerServices() caller resolves for real', function () {
    const callers = findCallerFiles(SRC_ROOT);

    it('finds at least the known caller set under src/services/', function () {
        expect(callers.length).to.be.at.least(1);
    });

    for (const caller of callers) {
        const relPath = path.relative(path.join(__dirname, '..', '..'), caller.file);

        it(`resolves every PEER_SERVICE_FILES entry from ${relPath}`, function () {
            expect(() => resolvesFromCallerPerspective(caller)).to.not.throw();
        });
    }
});
