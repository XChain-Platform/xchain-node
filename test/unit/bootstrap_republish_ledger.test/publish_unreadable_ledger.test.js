'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When the republish ledger exists but cannot be read, `xchain-node
// bootstrap-republish-due` fails with a message naming the ledger. The
// publisher once ran it with stderr discarded and filtered whatever reached
// stdout, so the failure read as "nothing due" and the run went on to plan
// and publish without the forced republishes. These cases pin that the
// publisher stops instead, and that the node's message reaches its output.

const fs            = require('fs')
const os            = require('os')
const path          = require('path')
const { spawnSync } = require('child_process')
const { expect }    = require('chai')

const SCRIPT = path.join(__dirname, '../../../scripts/publish-bootstraps.sh')

const LEDGER_MESSAGE = 'the bootstrap republish ledger /var/lib/xchain-node/bootstrap-reindex.json exists but could not be read (unparseable JSON)'

let workDir, binDir

// mapfile needs bash 4+; stock macOS bash 3.2 cannot run the script at all.
function requireMapfile() {
    const probe = spawnSync('bash', ['-c', 'mapfile -t x < /dev/null'], { encoding: 'utf8' })
    if (probe.status !== 0) this.skip()
}

function createWorkDir() {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-publish-ledger-'))
    binDir  = path.join(workDir, 'bin')
    fs.mkdirSync(binDir)
    fs.writeFileSync(path.join(binDir, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
}

function removeWorkDir() {
    fs.rmSync(workDir, { recursive: true, force: true })
}

// A fake node that serves two combos, lists bootstrap-republish-due in its help
// as the real one does, and whose republish-due listing fails the way the real
// one does over a damaged ledger: message on stderr, exit 1.
function fakeNodeWithUnreadableLedger() {
    const script = [
        '#!/usr/bin/env bash',
        'case "$1" in',
        "  --help)                  printf '%s\\n' 'Commands:' '  bootstrap-combos            List served combos' '  bootstrap-republish-due [options]  List due combos' ;;",
        "  bootstrap-combos)        printf '%s\\n' xchain-decoder:bitcoin:testnet xchain-indexer:bitcoin:testnet ;;",
        `  bootstrap-republish-due) printf '%s\\n' ${JSON.stringify(`ERROR: ${LEDGER_MESSAGE}`)} >&2; exit 1 ;;`,
        '  *) echo "unexpected: $*" >&2; exit 3 ;;',
        'esac',
        'exit 0',
        ''
    ].join('\n')
    fs.writeFileSync(path.join(binDir, 'xchain-node'), script, { mode: 0o755 })
}

function runPlan(args) {
    const res = spawnSync(SCRIPT, args, {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH:      `${binDir}:${process.env.PATH}`,
            STAGE_DIR: path.join(workDir, 'stage'),
            TMP_DIR:   path.join(workDir, 'tmp'),
            LOCK_FILE: path.join(workDir, 'publish.lock')
        }
    })
    return { status: res.status, out: `${res.stdout || ''}`, err: `${res.stderr || ''}` }
}

describe('publish-bootstraps.sh: a republish ledger that cannot be read', function () {
    this.timeout(10000)
    before(requireMapfile)
    beforeEach(createWorkDir)
    afterEach(removeWorkDir)

    it('refuses to plan instead of reading the failed listing as nothing due', function () {
        fakeNodeWithUnreadableLedger()
        const { status, out, err } = runPlan(['--all', '--dry-run', '--allow-unsigned'])
        expect(status, `planner exited 0:\n${out}\n${err}`).to.not.equal(0)
        expect(out).to.not.include('publish plan (')
        expect(out).to.match(/FATAL: bootstrap-republish-due failed/)
        expect(err).to.include(LEDGER_MESSAGE)
    })

    it('still plans the schedule when the operator turns the forcing off', function () {
        fakeNodeWithUnreadableLedger()
        const { status, out, err } = runPlan(['--all', '--dry-run', '--allow-unsigned', '--no-forced-due'])
        expect(status, `planner failed:\n${out}\n${err}`).to.equal(0)
        expect(out).to.include('publish plan (2)')
    })
})
