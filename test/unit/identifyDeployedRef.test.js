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
 * : coverage for scripts/identify-deployed-ref.js.
 *
 * This tool answers "which commit is the RUNNING artifact", and  section 8 step 1
 * takes that answer as the abort target for a mainnet batch. A wrong answer therefore
 * misdirects a release rather than merely failing, so the tests are built around the two
 * ways it can be wrong: naming a commit the artifact is not, and reporting NO MATCH for
 * a commit it is.
 *
 * The load-bearing assertion is the cross-check against real git: the probe walks files
 * and the match side reads the object store, and the whole method only works while those
 * two independent paths produce byte-identical manifests.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'identify-deployed-ref.js');
const idr    = require(SCRIPT);

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function hasGit() {
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; }
    catch (e) { return false; }
}

function git(repo, args) {
    return execFileSync('git', ['-C', repo].concat(args), { encoding: 'utf8' });
}

// A throwaway repository with a src/ tree, committed. Nothing here touches a chain or a
// network; it exists only so the object store has a tree to compare the file walk against.
function makeRepo() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'xc1252-'));
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', repo]);
    fs.mkdirSync(path.join(repo, 'src', 'services'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'index.js'), "'use strict';\nmodule.exports = 1;\n");
    fs.writeFileSync(path.join(repo, 'src', 'cli.js'), 'const x = 2;\n');
    fs.writeFileSync(path.join(repo, 'src', 'services', 'A.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(repo, 'src', 'empty.txt'), '');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    fs.writeFileSync(path.join(repo, 'README.md'), 'outside src, must not be hashed\n');
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
               '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed']);
    return repo;
}

describe(' identify-deployed-ref (deploy-informing script)', function () {

    describe('blob identity', function () {

        it('reproduces git hash-object exactly, including empty and binary content', function () {
            if (!hasGit()) return this.skip();
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xc1252-blob-'));
            const cases = {
                'empty':   Buffer.alloc(0),
                'ascii':   Buffer.from("'use strict';\nmodule.exports = 1;\n"),
                'nul':     Buffer.from([0x00, 0x01, 0xff, 0x00, 0x7f]),
                'unicode': Buffer.from('héllo wörld\n', 'utf8')
            };
            for (const [name, bytes] of Object.entries(cases)) {
                const p = path.join(dir, name);
                fs.writeFileSync(p, bytes);
                const fromGit = execFileSync('git', ['hash-object', p], { encoding: 'utf8' }).trim();
                assert.strictEqual(idr.blobId(bytes), fromGit,
                    'blobId must equal git hash-object for ' + name);
            }
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it('uses the byte length, not the character length, in the blob header', function () {
            // A multi-byte string measured with .length would produce a plausible-looking
            // sha1 that no git object store has, i.e. a silent NO MATCH.
            const bytes = Buffer.from('héllo', 'utf8');
            assert.strictEqual(bytes.length, 6);
            assert.notStrictEqual(idr.blobId(bytes), idr.blobId(Buffer.from('hello')));
        });
    });

    describe('tree hash', function () {

        it('depends on manifest order, so two trees of the same files differ', function () {
            const a = ['aa f1', 'bb f2'];
            const b = ['bb f2', 'aa f1'];
            assert.notStrictEqual(idr.treeHashOf(a), idr.treeHashOf(b));
        });

        it('is stable for the same manifest', function () {
            const m = ['aa f1', 'bb f2'];
            assert.strictEqual(idr.treeHashOf(m), idr.treeHashOf(m.slice()));
        });

        it('changes when any single blob changes', function () {
            assert.notStrictEqual(idr.treeHashOf(['aa f1']), idr.treeHashOf(['ab f1']));
        });
    });

    describe('git ls-tree parsing', function () {

        it('keeps blobs, drops gitlinks, and sorts by path', function () {
            // A gitlink has type "commit" and no file the probe can walk, so hashing it
            // would make every commit carrying a submodule permanently unmatchable.
            const listing = [
                '100644 blob ' + 'c'.repeat(40) + '\tsrc/zeta.js',
                '160000 commit ' + 'd'.repeat(40) + '\tsrc/vendored',
                '100644 blob ' + 'e'.repeat(40) + '\tsrc/alpha.js'
            ].join('\n') + '\n';
            assert.deepStrictEqual(idr.parseTreeListing(listing), [
                'e'.repeat(40) + ' src/alpha.js',
                'c'.repeat(40) + ' src/zeta.js'
            ]);
        });

        it('returns an empty manifest for empty output rather than a line of noise', function () {
            assert.deepStrictEqual(idr.parseTreeListing(''), []);
            assert.deepStrictEqual(idr.parseTreeListing('\n\n'), []);
        });
    });

    describe('probe and match agree on a real repository', function () {

        it('the file walk and the object store produce the identical manifest', function () {
            if (!hasGit()) return this.skip();
            this.timeout(20000);
            const repo = makeRepo();
            const fromWalk    = idr.manifestLines(repo);
            const fromObjects = idr.parseTreeListing(git(repo, ['ls-tree', '-r', 'HEAD', '--', 'src']));
            assert.deepStrictEqual(fromWalk, fromObjects);
            assert.strictEqual(idr.treeHashOf(fromWalk), idr.treeHashOf(fromObjects));
            fs.rmSync(repo, { recursive: true, force: true });
        });

        it('hashes only src/, so a change outside it does not rename the commit', function () {
            if (!hasGit()) return this.skip();
            this.timeout(20000);
            const repo = makeRepo();
            const before = idr.treeHashOf(idr.manifestLines(repo));
            fs.writeFileSync(path.join(repo, 'README.md'), 'edited outside src\n');
            fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '0.0.1' }));
            assert.strictEqual(idr.treeHashOf(idr.manifestLines(repo)), before);
            fs.writeFileSync(path.join(repo, 'src', 'cli.js'), 'const x = 3;\n');
            assert.notStrictEqual(idr.treeHashOf(idr.manifestLines(repo)), before);
            fs.rmSync(repo, { recursive: true, force: true });
        });

        it('reads the version as a hint and survives a missing or broken package.json', function () {
            if (!hasGit()) return this.skip();
            this.timeout(20000);
            const repo = makeRepo();
            assert.strictEqual(idr.readVersion(repo), '9.9.9');
            fs.writeFileSync(path.join(repo, 'package.json'), '{not json');
            assert.strictEqual(idr.readVersion(repo), '');
            fs.rmSync(path.join(repo, 'package.json'));
            assert.strictEqual(idr.readVersion(repo), '');
            fs.rmSync(repo, { recursive: true, force: true });
        });

        it('yields an empty manifest when src/ is absent instead of throwing', function () {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xc1252-nosrc-'));
            assert.deepStrictEqual(idr.manifestLines(dir), []);
            fs.rmSync(dir, { recursive: true, force: true });
        });
    });

    describe('matching a hash against the history walk', function () {

        const commit = (h, short, date, subj) => [h, short, date, subj].join('|');

        it('reports the NEWEST commit carrying a shared tree', function () {
            const commits = [commit('f1', 'f1f1f1f', '2026-08-01', 'docs only'),
                             commit('f2', 'f2f2f2f', '2026-07-30', 'the code change')];
            // Both commits carry the same src/ tree; newest-first order must win.
            const found = idr.matchHashes(commits, () => ({ hash: HASH_A, count: 4 }),
                                          new Map([[HASH_A, 'indexer']]));
            assert.strictEqual(found.size, 1);
            assert.ok(found.get(HASH_A).line.startsWith('f1|'));
        });

        it('stops walking once every wanted hash is placed', function () {
            let calls = 0;
            const commits = ['c1|c1|d|s', 'c2|c2|d|s', 'c3|c3|d|s', 'c4|c4|d|s'];
            idr.matchHashes(commits, () => { calls++; return { hash: HASH_A, count: 1 }; },
                            new Map([[HASH_A, 'only']]));
            assert.strictEqual(calls, 1, 'the walk must not continue after the last hash is found');
        });

        it('leaves a hash unfound when no commit carries it', function () {
            const found = idr.matchHashes(['c1|c1|d|s'], () => ({ hash: HASH_A, count: 1 }),
                                          new Map([[HASH_B, 'ghost']]));
            assert.strictEqual(found.size, 0);
        });
    });

    describe('the report', function () {

        it('prints the commit, date and src file count for a match', function () {
            const wanted = new Map([[HASH_A, 'indexer']]);
            const found  = new Map([[HASH_A, { line: 'full|abc1234|2026-07-30|fix the thing', count: 41 }]]);
            const r = idr.formatMatchReport(found, wanted, 500);
            assert.strictEqual(r.unmatched, 0);
            assert.match(r.text, /indexer\s+= abc1234\s+2026-07-30\s+41 src files\s+fix the thing/);
            assert.match(r.text, /NEWEST commit/, 'the shared-tree caveat must ship with every match');
        });

        it('calls an unmatched artifact a FINDING and names the walk depth', function () {
            const wanted = new Map([[HASH_A, 'decoder']]);
            const r = idr.formatMatchReport(new Map(), wanted, 120);
            assert.strictEqual(r.unmatched, 1);
            assert.match(r.text, /decoder\s+= NO MATCH in the last 120 commits/);
            assert.match(r.text, /NO MATCH is a FINDING/);
            assert.doesNotMatch(r.text, /NEWEST commit/,
                'the shared-tree note is meaningless with nothing found');
        });

        it('counts every unmatched hash when a run mixes both outcomes', function () {
            const wanted = new Map([[HASH_A, 'a'], [HASH_B, 'b']]);
            const found  = new Map([[HASH_A, { line: 'full|abc1234|2026-07-30|s', count: 1 }]]);
            const r = idr.formatMatchReport(found, wanted, 500);
            assert.strictEqual(r.unmatched, 1);
            assert.match(r.text, /NO MATCH is a FINDING/);
            assert.match(r.text, /NEWEST commit/);
        });

        it('formats the probe report as the four keys a runbook greps for', function () {
            const text = idr.formatProbeReport('/app', '1.2.3', 7, HASH_A);
            assert.strictEqual(text, 'ROOT=/app\nVERSION=1.2.3\nFILES=7\nTREEHASH=' + HASH_A);
        });
    });

    describe('argument parsing', function () {

        it('rejects a truncated hash instead of turning it into a NO MATCH finding', function () {
            const r = idr.parseMatchArgs(['match', '/repo', 'a'.repeat(40)]);
            assert.match(r.error, /not a sha256 tree hash/);
            assert.strictEqual(r.wanted, undefined);
        });

        it('rejects a hash with uppercase or non-hex characters', function () {
            assert.match(idr.parseMatchArgs(['match', '/repo', 'A'.repeat(64)]).error, /not a sha256/);
            assert.match(idr.parseMatchArgs(['match', '/repo', 'g'.repeat(64)]).error, /not a sha256/);
        });

        it('requires a repo path and at least one hash', function () {
            assert.match(idr.parseMatchArgs(['match']).error, /usage:/);
            assert.match(idr.parseMatchArgs(['match', '/repo']).error, /no tree hashes given/);
        });

        it('labels a hash with its short form when no label is given', function () {
            const r = idr.parseMatchArgs(['match', '/repo', HASH_A]);
            assert.strictEqual(r.wanted.get(HASH_A), HASH_A.slice(0, 8));
        });

        it('keeps an explicit label and the default depth', function () {
            const r = idr.parseMatchArgs(['match', '/repo', HASH_A + ':indexer']);
            assert.strictEqual(r.wanted.get(HASH_A), 'indexer');
            assert.strictEqual(r.depth, 500);
            assert.strictEqual(r.repo, '/repo');
        });

        it('honours --depth anywhere in the list and falls back on a junk value', function () {
            assert.strictEqual(idr.parseMatchArgs(['match', '/r', '--depth', '40', HASH_A]).depth, 40);
            assert.strictEqual(idr.parseMatchArgs(['match', '/r', HASH_A, '--depth', '40']).depth, 40);
            assert.strictEqual(idr.parseMatchArgs(['match', '/r', '--depth', 'abc', HASH_A]).depth, 500);
            assert.strictEqual(idr.parseMatchArgs(['match', '/r', '--depth', '0', HASH_A]).depth, 500);
        });

        it('accepts several labelled hashes in one walk', function () {
            const r = idr.parseMatchArgs(['match', '/r', HASH_A + ':a', HASH_B + ':b']);
            assert.strictEqual(r.wanted.size, 2);
            assert.strictEqual(r.wanted.get(HASH_B), 'b');
        });
    });

    describe('the entrypoint guard', function () {

        it('does not run the CLI when the module is required', function () {
            // Reaching this test at all proves it: a require that ran main() would have
            // called process.exit during the require at the top of this file.
            assert.strictEqual(typeof idr.main, 'function');
            assert.strictEqual(typeof idr.probe, 'function');
        });

        it('still probes when piped to `node -`, where require.main is undefined', function () {
            if (!hasGit()) return this.skip();
            this.timeout(20000);
            // The runbook invokes this tool as `docker exec -i <c> node - <root> < script`.
            // Under `node -` require.main is undefined rather than this module, so a bare
            // `require.main === module` guard would exit 0 printing nothing and a runbook
            // would read the silence as an empty tree. This is that regression.
            const repo = makeRepo();
            const out = execFileSync(process.execPath, ['-', repo],
                                     { input: fs.readFileSync(SCRIPT), encoding: 'utf8' });
            const expected = idr.treeHashOf(idr.manifestLines(repo));
            assert.match(out, /^ROOT=/m);
            assert.match(out, /^VERSION=9\.9\.9$/m);
            assert.match(out, /^FILES=4$/m);
            assert.ok(out.includes('TREEHASH=' + expected),
                'the piped probe must report the same tree hash the helpers compute');
            fs.rmSync(repo, { recursive: true, force: true });
        });

        it('still probes when invoked directly as a file', function () {
            if (!hasGit()) return this.skip();
            this.timeout(20000);
            const repo = makeRepo();
            const out = execFileSync(process.execPath, [SCRIPT, repo], { encoding: 'utf8' });
            assert.ok(out.includes('TREEHASH=' + idr.treeHashOf(idr.manifestLines(repo))));
            fs.rmSync(repo, { recursive: true, force: true });
        });

        it('emits the bare manifest under --manifest, for diffing against ls-tree', function () {
            if (!hasGit()) return this.skip();
            this.timeout(20000);
            const repo = makeRepo();
            const out = execFileSync(process.execPath, [SCRIPT, repo, '--manifest'], { encoding: 'utf8' });
            assert.strictEqual(out.trim(), idr.manifestLines(repo).join('\n'));
            assert.doesNotMatch(out, /TREEHASH=/);
            fs.rmSync(repo, { recursive: true, force: true });
        });

        it('exits 2 on a bad hash rather than reporting a clean NO MATCH', function () {
            let status = 0;
            try {
                execFileSync(process.execPath, [SCRIPT, 'match', '/tmp', 'short'],
                             { encoding: 'utf8', stdio: 'pipe' });
            } catch (e) { status = e.status; }
            assert.strictEqual(status, 2);
        });
    });
});
