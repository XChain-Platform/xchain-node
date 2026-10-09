'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { expect } = require('chai')

const SCRIPT = path.join(__dirname, '../../scripts/publish-bootstraps.sh')

describe('publish-bootstraps.sh: source-health refusal reason', function () {
    this.timeout(10000)

    let workDir
    let binDir

    before(function () {
        if (spawnSync('bash', ['-c', 'mapfile -t x < /dev/null']).status !== 0) this.skip()
    })

    beforeEach(function () {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-publish-refusal-'))
        binDir = path.join(workDir, 'bin')
        fs.mkdirSync(binDir)
        fs.writeFileSync(path.join(binDir, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    })

    afterEach(function () {
        fs.rmSync(workDir, { recursive: true, force: true })
    })

    function runWithCreateOutput(lines) {
        const fakeNode = path.join(binDir, 'xchain-node')
        const body = lines.map(line => `printf '%s\\n' ${JSON.stringify(line)} >&2`).join('\n')
        fs.writeFileSync(fakeNode, [
            '#!/usr/bin/env bash',
            'if [ "$1" = bootstrap ] && [ "$2" = create ]; then',
            body,
            '  exit 1',
            'fi',
            'echo "unexpected: $*" >&2',
            'exit 3',
            ''
        ].join('\n'), { mode: 0o755 })

        return spawnSync(SCRIPT, [
            'xchain-utxo-tracker:dogecoin:testnet',
            '--with-trackers',
            '--no-publish',
            '--allow-unsigned',
            '--no-forced-due'
        ], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH}`,
                STAGE_DIR: path.join(workDir, 'stage'),
                TMP_DIR: path.join(workDir, 'tmp'),
                LOCK_FILE: path.join(workDir, 'publish.lock'),
                ROLL_HOLD_FILE: path.join(workDir, 'no-roll-hold')
            }
        })
    }

    it('keeps the health-gate reasons in the refusal and summary', function () {
        const result = runWithCreateOutput([
            'Refusing to create a bootstrap from dogecoin/testnet xchain-utxo-tracker: the source is not known-good.',
            '  - service status probe could not reach the tracker API',
            '  - container health is unhealthy'
        ])

        expect(result.status).to.equal(1)
        expect(result.stdout).to.include(
            'SOURCE-UNHEALTHY (service status probe could not reach the tracker API; container health is unhealthy)')
        expect(result.stdout).to.include(
            'source is not known-good (service status probe could not reach the tracker API; container health is unhealthy)')
    })

    it('uses an explicit fallback when an older CLI emits no bullet reason', function () {
        const result = runWithCreateOutput([
            'Refusing to create a bootstrap from dogecoin/testnet xchain-utxo-tracker'
        ])

        expect(result.status).to.equal(1)
        expect(result.stdout).to.include(
            'SOURCE-UNHEALTHY (reason unavailable; inspect create output above)')
    })
})
