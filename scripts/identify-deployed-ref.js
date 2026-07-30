#!/usr/bin/env node
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
 *
 * Identify which commit a RUNNING service artifact is, by content.
 *
 *  §8 step 1 requires the deployed version of every service on every host,
 * "read from the running artifact, never from git", because mainnet indexers
 * deliberately do not run master  and that record is the §3.5 abort
 * target. The refs cannot simply be read: the images carry no labels, no `.git`
 * and no commit stamp, and package.json gives a version that spans dozens of
 * commits. So the tree is IDENTIFIED instead.
 *
 * Method: compute each file's GIT BLOB id (sha1 of "blob <len>\0" + bytes) for
 * everything under src/, sort by path, hash the manifest. That is exactly what
 * `git ls-tree -r <commit> -- src` lists, so an exact match names the commit.
 *
 * The property that earns this tool its keep is the NEGATIVE one: no match means
 * the artifact is not any commit. That is how  went from an uptime-based
 * inference to a measurement (two devhost containers run files whose content
 * exists in no commit and in no worktree).
 *
 * USAGE
 *   # inside the container (no deps, no network, reads nothing but files):
 *   docker exec -i <container> node - <app-root> < scripts/identify-deployed-ref.js
 *   docker exec -i <container> node - <app-root> --manifest < ...    # full per-file list
 *
 *   # on the monorepo host, resolve one or more hashes in ONE history walk:
 *   node scripts/identify-deployed-ref.js match <repo-path> [--depth N] <hash>[:label] ...
 *
 * The probe form takes the app root as its first argument because it is piped in
 * on stdin and has no path of its own. Get the root from the container itself:
 * `docker inspect --format '{{.Config.WorkingDir}}' <container>`.
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

function walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.isFile()) out.push(p);
    }
    return out;
}

function blobId(bytes) {
    const h = crypto.createHash('sha1');
    h.update('blob ' + bytes.length + '\0');
    h.update(bytes);
    return h.digest('hex');
}

// ── probe: run this inside the container ─────────────────────────────────────
function probe(root, wantManifest) {
    const files = walk(path.join(root, 'src'), []).map(p => path.relative(root, p)).sort();
    const lines = files.map(f => blobId(fs.readFileSync(path.join(root, f))) + ' ' + f);
    let version = '';
    try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''; }
    catch (e) { /* the tree hash is the identity; the version is only a hint */ }

    if (wantManifest) { console.log(lines.join('\n')); return 0; }
    console.log('ROOT=' + root);
    console.log('VERSION=' + version);
    console.log('FILES=' + files.length);
    console.log('TREEHASH=' + crypto.createHash('sha256').update(lines.join('\n')).digest('hex'));
    return 0;
}

// ── match: run this on the monorepo host ─────────────────────────────────────
function match(repo, depth, wanted) {
    const { execFileSync } = require('child_process');
    const git = (...a) => execFileSync('git', ['-C', repo, ...a],
                                       { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

    // Same manifest shape the probe builds, straight out of the object store.
    const treeHash = (commit) => {
        const lines = git('ls-tree', '-r', commit, '--', 'src').split('\n').filter(Boolean)
            .map(l => { const [meta, file] = l.split('\t'); const p = meta.split(/\s+/);
                        return { file, blob: p[2], type: p[1] }; })
            .filter(e => e.type === 'blob')
            .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
            .map(e => e.blob + ' ' + e.file);
        return { hash: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'),
                 count: lines.length };
    };

    const commits = git('log', '--format=%H|%h|%ad|%s', '--date=short', '-n', String(depth))
                        .split('\n').filter(Boolean);
    const found = new Map();
    for (const line of commits) {
        if (found.size === wanted.size) break;
        const t = treeHash(line.split('|')[0]);
        if (wanted.has(t.hash) && !found.has(t.hash)) found.set(t.hash, { line, count: t.count });
    }

    let unmatched = 0;
    for (const [hash, label] of wanted) {
        if (found.has(hash)) {
            const f = found.get(hash);
            const [, short, date, subj] = f.line.split('|');
            console.log(label.padEnd(18) + ' = ' + short + '  ' + date + '  ' +
                        f.count + ' src files  ' + subj.slice(0, 66));
        } else {
            unmatched++;
            console.log(label.padEnd(18) + ' = NO MATCH in the last ' + commits.length + ' commits');
        }
    }
    if (found.size) {
        console.log('');
        console.log('note: a match is the NEWEST commit carrying that src/ tree. Commits that touched');
        console.log('      only test/ or docs share it, so the deployed CODE is identical across them.');
    }
    if (unmatched) {
        console.log('');
        console.log('NO MATCH is a FINDING, not a missing version: the artifact is not any commit in');
        console.log('the walk. Either widen --depth, or the tree was hand-staged / built from a dirty');
        console.log('worktree. Diff it with --manifest against `git ls-tree -r <commit> -- src`, then');
        console.log('check a suspect file against EVERY version it ever had:');
        console.log('  for c in $(git log --format=%H -- <file>); do git rev-parse $c:<file>; done');
    }
    return unmatched ? 1 : 0;
}

function main() {
    const argv = process.argv.slice(2);
    if (argv[0] === 'match') {
        const repo = argv[1];
        if (!repo) { console.error('usage: identify-deployed-ref.js match <repo-path> [--depth N] <hash>[:label] ...'); return 2; }
        let depth = 500;
        const wanted = new Map();
        for (let i = 2; i < argv.length; i++) {
            if (argv[i] === '--depth') { depth = Number(argv[++i]) || 500; continue; }
            const [h, label] = argv[i].split(':');
            if (!/^[0-9a-f]{64}$/.test(h)) { console.error('not a sha256 tree hash: ' + h); return 2; }
            wanted.set(h, label || h.slice(0, 8));
        }
        if (!wanted.size) { console.error('no tree hashes given'); return 2; }
        return match(repo, depth, wanted);
    }
    // probe form: first arg is the app root (see the usage note about stdin)
    const root = argv.find(a => !a.startsWith('--')) || process.cwd();
    return probe(root, argv.includes('--manifest'));
}

process.exit(main());
