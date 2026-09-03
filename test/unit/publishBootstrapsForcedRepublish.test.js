'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The node records a combo as due for republish when a reset rebuilds
// its store on a new lineage, but the marker only matters if the PUBLISHER acts
// on it: a due combo the schedule would have dropped has to enter the plan
// anyway, or the pre-reindex archive stays newest and every fresh install that
// takes it halts. These suites drive scripts/publish-bootstraps.sh in --dry-run
// against a fake xchain-node and pin the plan it builds.

const fs             = require('fs')
const os             = require('os')
const path           = require('path')
const { execFileSync, spawnSync } = require('child_process')
const { expect }     = require('chai')

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'publish-bootstraps.sh')

// The script uses mapfile, which is bash 4+. Production runs it under
// /usr/bin/env bash on Linux; a box whose PATH bash is 3.2 (stock macOS) cannot
// run it at all, so skip rather than report a red that says nothing about the
// change under test.
function bashSupportsMapfile() {
    const probe = spawnSync('bash', ['-c', 'mapfile -t x < /dev/null'], { encoding: 'utf8' })
    return probe.status === 0
}

describe('publish-bootstraps.sh: forced republish after a reindex', function () {

    this.timeout(10000)

    let workDir
    let binDir

    before(function () {
        if (!bashSupportsMapfile()) this.skip()
    })

    beforeEach(function () {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-publish-'))
        binDir  = path.join(workDir, 'bin')
        fs.mkdirSync(binDir)
    })

    afterEach(function () {
        fs.rmSync(workDir, { recursive: true, force: true })
    })

    /**
     * Install a fake `xchain-node` that answers the two listing subcommands the
     * planner uses and nothing else. --dry-run exits before any create, so the
     * plan is the whole observable behaviour.
     */
    function fakeNode({ combos = [], due = [] } = {}) {
        // Each line is emitted by its own printf so no escape sequence in the
        // fixture is ever interpreted by the shell; the hostile-input case below
        // depends on the fake echoing its combos back verbatim.
        const emit = list => list.length === 0
            ? 'true'
            : list.map(c => `printf '%s\\n' ${JSON.stringify(c)}`).join('; ')
        const script = [
            '#!/usr/bin/env bash',
            'case "$1" in',
            `  bootstrap-combos)         ${emit(combos)} ;;`,
            `  bootstrap-republish-due)  ${emit(due)} ;;`,
            '  *) echo "unexpected: $*" >&2; exit 3 ;;',
            'esac',
            'exit 0',
            ''
        ].join('\n')
        const p = path.join(binDir, 'xchain-node')
        fs.writeFileSync(p, script, { mode: 0o755 })
        return p
    }

    function runPlan(args) {
        try {
            return execFileSync(SCRIPT, args, {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH:      `${binDir}:${process.env.PATH}`,
                    STAGE_DIR: path.join(workDir, 'stage'),
                    TMP_DIR:   path.join(workDir, 'tmp'),
                    LOCK_FILE: path.join(workDir, 'publish.lock')
                }
            })
        } catch (err) {
            // Surface the script's own output on a non-zero exit; a bare
            // "Command failed" says nothing about which precondition tripped.
            throw new Error(`${err.message}\n--- stdout ---\n${err.stdout}\n--- stderr ---\n${err.stderr}`)
        }
    }

    function planLine(out) {
        const line = out.split('\n').find(l => l.includes('publish plan ('))
        return line || ''
    }

    it('keeps the scheduled plan when nothing was reindexed', function () {
        fakeNode({
            combos: [
                'xchain-decoder:bitcoin:testnet',
                'xchain-indexer:bitcoin:testnet',
                'xchain-utxo-tracker:bitcoin:testnet'
            ],
            due: []
        })
        const out = runPlan(['--all', '--dry-run', '--allow-unsigned'])
        expect(out).to.include('skip (tracker, needs --with-trackers): xchain-utxo-tracker:bitcoin:testnet')
        expect(planLine(out)).to.include('publish plan (2)')
        expect(out).to.not.include('FORCED')
    })

    // The forcing itself: --trackers-only would have dropped the decoder, but
    // its published archive is from the pre-reset lineage, so it goes in anyway.
    it('pulls a due combo into a plan that would have skipped it', function () {
        fakeNode({
            combos: ['xchain-decoder:bitcoin:testnet', 'xchain-utxo-tracker:bitcoin:testnet'],
            due:    ['xchain-decoder:bitcoin:testnet']
        })
        const out = runPlan(['--all', '--trackers-only', '--dry-run', '--allow-unsigned'])
        expect(out).to.include('FORCED (reindexed since last publish; overrides --trackers-only): xchain-decoder:bitcoin:testnet')
        expect(planLine(out)).to.include('xchain-decoder:bitcoin:testnet')
    })

    // A due combo the registry no longer lists, or one an explicit invocation
    // never named, still has a wrong archive standing as newest.
    it('pulls in a due combo the resolved plan never contained', function () {
        fakeNode({
            combos: ['xchain-decoder:bitcoin:testnet'],
            due:    ['xchain-indexer:litecoin:testnet']
        })
        const out = runPlan(['xchain-decoder:bitcoin:testnet', '--dry-run', '--allow-unsigned'])
        expect(out).to.include('FORCED (reindexed since last publish; not in the resolved plan): xchain-indexer:litecoin:testnet')
        expect(planLine(out)).to.include('publish plan (2)')
    })

    // A tracker create stops the container, so a nightly cron must not take the
    // tracker down on its own initiative. It says so loudly instead, every run.
    it('defers a due tracker but reports it on every run', function () {
        fakeNode({
            combos: ['xchain-decoder:bitcoin:testnet', 'xchain-utxo-tracker:bitcoin:testnet'],
            due:    ['xchain-utxo-tracker:bitcoin:testnet']
        })
        const out = runPlan(['--all', '--dry-run', '--allow-unsigned'])
        expect(out).to.include('DUE but DEFERRED (tracker create means downtime): xchain-utxo-tracker:bitcoin:testnet')
        expect(out).to.include('serving a PRE-reindex archive')
        expect(planLine(out)).to.include('publish plan (1)')
        expect(planLine(out)).to.not.include('xchain-utxo-tracker')
    })

    it('republishes a due tracker when the operator accepts the downtime', function () {
        fakeNode({
            combos: ['xchain-decoder:bitcoin:testnet', 'xchain-utxo-tracker:bitcoin:testnet'],
            due:    ['xchain-utxo-tracker:bitcoin:testnet']
        })
        const out = runPlan(['--all', '--dry-run', '--allow-unsigned', '--force-due-trackers'])
        expect(out).to.include('FORCED (reindexed since last publish; overrides the tracker opt-in, DOWNTIME)')
        expect(planLine(out)).to.include('xchain-utxo-tracker:bitcoin:testnet')
    })

    it('--no-forced-due falls back to the schedule alone', function () {
        fakeNode({
            combos: ['xchain-decoder:bitcoin:testnet', 'xchain-utxo-tracker:bitcoin:testnet'],
            due:    ['xchain-utxo-tracker:bitcoin:testnet']
        })
        const out = runPlan(['--all', '--dry-run', '--allow-unsigned', '--no-forced-due'])
        expect(out).to.include('skip (tracker, needs --with-trackers)')
        expect(out).to.not.include('FORCED')
        expect(out).to.not.include('DEFERRED')
    })

    // The due list is read from a file on disk and interpolated into the plan,
    // so anything that is not a <service>:<coin>:<network> triple is dropped
    // before it can reach a command line.
    it('drops a due line that is not a plain combo triple', function () {
        fakeNode({
            combos: ['xchain-decoder:bitcoin:testnet'],
            due:    [
                'xchain-decoder:bitcoin:testnet; touch /tmp/xchain-pwned',
                'xchain-encoder:bitcoin:testnet',
                'not-a-combo'
            ]
        })
        const out = runPlan(['--all', '--dry-run', '--allow-unsigned'])
        expect(out).to.not.include('pwned')
        expect(out).to.not.include('xchain-encoder')
        expect(planLine(out)).to.include('publish plan (1)')
    })

    it('does not fail the run when the node cannot list due combos', function () {
        const p = path.join(binDir, 'xchain-node')
        fs.writeFileSync(p, [
            '#!/usr/bin/env bash',
            'case "$1" in',
            "  bootstrap-combos) printf '%s\\n' 'xchain-decoder:bitcoin:testnet' ;;",
            // An older pinned CLI on the fleet has no such subcommand.
            '  *) echo "error: unknown command" >&2; exit 1 ;;',
            'esac',
            ''
        ].join('\n'), { mode: 0o755 })

        const out = runPlan(['--all', '--dry-run', '--allow-unsigned'])
        expect(planLine(out)).to.include('publish plan (1)')
    })
})
