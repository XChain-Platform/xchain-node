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
 * Deploy verification requires the deployed version of every service on every
 * host, read from the running artifact, never from git, because mainnet indexers
 * deliberately do not run master and that record is the abort target. The refs
 * cannot simply be read: the images carry no labels, no `.git` and no commit
 * stamp, and package.json gives a version that spans dozens of commits. So the
 * tree is IDENTIFIED instead.
 *
 * Method: compute each file's GIT BLOB id (sha1 of "blob <len>\0" + bytes) for
 * everything under src/, sort by path, hash the manifest. That is exactly what
 * `git ls-tree -r <commit> -- src` lists, so an exact match names the commit.
 *
 * The property that earns this tool its keep is the NEGATIVE one: no match means
 * the artifact is not any commit. That is how a prior uptime-based inference of
 * deploy freshness became a real measurement: production containers were found
 * running files whose content existed in no commit and in no worktree.
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
 * The pure helpers below are exported for test/unit/identifyDeployedRef.test.js.
 * Nothing may be required in from outside this file: the probe form is piped
 * into a container that holds only the service's own tree, so a second file
 * would be missing exactly where the tool is used.
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

// The identity itself. Both sides of the tool reduce to this call over the same
// "<blob> <path>" lines, so a probe hash and a commit hash are comparable only as
// long as the join and the digest stay identical for both.
function treeHashOf(lines) {
    return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

// The manifest as the RUNNING artifact yields it: git blob ids over src/, paths
// relative to the app root, sorted by path.
function manifestLines(root) {
    const files = walk(path.join(root, 'src'), []).map(p => path.relative(root, p)).sort();
    return files.map(f => blobId(fs.readFileSync(path.join(root, f))) + ' ' + f);
}

// The same manifest as the OBJECT STORE yields it, parsed out of `git ls-tree -r`.
// Non-blob entries (submodule gitlinks) are dropped rather than hashed: the probe
// walks real files and cannot see them, so keeping them would make every commit
// containing one unmatchable.
function parseTreeListing(text) {
    return String(text).split('\n').filter(Boolean)
        .map(l => { const [meta, file] = l.split('\t'); const p = meta.split(/\s+/);
                    return { file, blob: p[2], type: p[1] }; })
        .filter(e => e.type === 'blob')
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
        .map(e => e.blob + ' ' + e.file);
}

function readVersion(root) {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''; }
    catch (e) { return ''; }   // the tree hash is the identity; the version is only a hint
}

function formatProbeReport(root, version, fileCount, hash) {
    return ['ROOT=' + root, 'VERSION=' + version, 'FILES=' + fileCount, 'TREEHASH=' + hash].join('\n');
}

// probe: run this inside the container
function probe(root, wantManifest) {
    const lines = manifestLines(root);
    if (wantManifest) { console.log(lines.join('\n')); return 0; }
    console.log(formatProbeReport(root, readVersion(root), lines.length, treeHashOf(lines)));
    return 0;
}

// Walk newest-first and keep the FIRST commit carrying each wanted hash, so a tree
// shared by several commits reports the newest one (the note printed below says so).
// Stops as soon as every hash is placed, which is what keeps a 500-commit walk cheap
// when the artifacts are recent. treeHashFor is injected so the search is testable
// without a repository.
function matchHashes(commitLines, treeHashFor, wanted) {
    const found = new Map();
    for (const line of commitLines) {
        if (found.size === wanted.size) break;
        const t = treeHashFor(line.split('|')[0]);
        if (wanted.has(t.hash) && !found.has(t.hash)) found.set(t.hash, { line, count: t.count });
    }
    return found;
}

function formatMatchReport(found, wanted, walkLength) {
    const out = [];
    let unmatched = 0;
    for (const [hash, label] of wanted) {
        if (found.has(hash)) {
            const f = found.get(hash);
            const [, short, date, subj] = f.line.split('|');
            out.push(label.padEnd(18) + ' = ' + short + '  ' + date + '  ' +
                     f.count + ' src files  ' + subj.slice(0, 66));
        } else {
            unmatched++;
            out.push(label.padEnd(18) + ' = NO MATCH in the last ' + walkLength + ' commits');
        }
    }
    if (found.size) {
        out.push('');
        out.push('note: a match is the NEWEST commit carrying that src/ tree. Commits that touched');
        out.push('      only test/ or docs share it, so the deployed CODE is identical across them.');
    }
    if (unmatched) {
        out.push('');
        out.push('NO MATCH is a FINDING, not a missing version: the artifact is not any commit in');
        out.push('the walk. Either widen --depth, or the tree was hand-staged / built from a dirty');
        out.push('worktree. Diff it with --manifest against `git ls-tree -r <commit> -- src`, then');
        out.push('check a suspect file against EVERY version it ever had:');
        out.push('  for c in $(git log --format=%H -- <file>); do git rev-parse $c:<file>; done');
    }
    return { text: out.join('\n'), unmatched };
}

// match: run this on the monorepo host
function match(repo, depth, wanted) {
    const { execFileSync } = require('child_process');
    const git = (...a) => execFileSync('git', ['-C', repo, ...a],
                                       { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

    const treeHashFor = (commit) => {
        const lines = parseTreeListing(git('ls-tree', '-r', commit, '--', 'src'));
        return { hash: treeHashOf(lines), count: lines.length };
    };

    const commits = git('log', '--format=%H|%h|%ad|%s', '--date=short', '-n', String(depth))
                        .split('\n').filter(Boolean);
    const report = formatMatchReport(matchHashes(commits, treeHashFor, wanted), wanted, commits.length);
    console.log(report.text);
    return report.unmatched ? 1 : 0;
}

// Rejects anything that is not a full sha256 so a truncated paste cannot silently
// become a hash that matches nothing, which reads as the tool's NO MATCH finding.
function parseMatchArgs(argv) {
    const repo = argv[1];
    if (!repo) return { error: 'usage: identify-deployed-ref.js match <repo-path> [--depth N] <hash>[:label] ...' };
    let depth = 500;
    const wanted = new Map();
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--depth') { depth = Number(argv[++i]) || 500; continue; }
        const [h, label] = argv[i].split(':');
        if (!/^[0-9a-f]{64}$/.test(h)) return { error: 'not a sha256 tree hash: ' + h };
        wanted.set(h, label || h.slice(0, 8));
    }
    if (!wanted.size) return { error: 'no tree hashes given' };
    return { repo, depth, wanted };
}

function main() {
    const argv = process.argv.slice(2);
    if (argv[0] === 'match') {
        const parsed = parseMatchArgs(argv);
        if (parsed.error) { console.error(parsed.error); return 2; }
        return match(parsed.repo, parsed.depth, parsed.wanted);
    }
    // probe form: first arg is the app root (see the usage note about stdin)
    const root = argv.find(a => !a.startsWith('--')) || process.cwd();
    return probe(root, argv.includes('--manifest'));
}

// The probe form is PIPED IN on stdin (`node - <root> < this-file`), and under `node -`
// require.main is undefined, not this module. A bare `require.main === module` guard
// therefore turns the documented probe invocation into a silent no-op that exits 0 with
// no output, which a runbook reads as an empty tree. The undefined arm is what keeps
// stdin working; a test require()ing this file has a defined require.main and is excluded.
module.exports = {
    blobId, walk, treeHashOf, manifestLines, parseTreeListing, readVersion,
    formatProbeReport, probe, matchHashes, formatMatchReport, parseMatchArgs, main
};

if (require.main === module || require.main === undefined) process.exit(main());
