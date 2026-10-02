'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const yaml = require('js-yaml')

const ROOT = path.join(__dirname, '../../..')
const WORKFLOW = path.join(ROOT, '.github/workflows/rail-leg.yml')
const ENV_WRITER = path.join(ROOT, 'scripts/rail_leg_env.js')

function parseAssignments (file) {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
    }))
}

function writeDriveEnv () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-leg-drive-urls-'))
    const bin = path.join(dir, 'bin')
    const out = path.join(dir, '.env')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
if [ "$1" = inspect ]; then
  echo '[]'
  exit 0
fi
if [ "$1" != port ]; then exit 1; fi
case "$2:$3" in
  xchain-node-bitcoin-regtest-node:18444/tcp) echo '0.0.0.0:3020' ;;
  xchain-node-bitcoin-regtest-xchain-utxo-tracker:3001/tcp) echo '0.0.0.0:3021' ;;
  xchain-node-bitcoin-regtest-xchain-decoder:3002/tcp) echo '0.0.0.0:3022' ;;
  xchain-node-bitcoin-regtest-xchain-encoder:3003/tcp) echo '0.0.0.0:3023' ;;
  xchain-node-bitcoin-regtest-xchain-indexer:3004/tcp) echo '0.0.0.0:3024' ;;
  xchain-node-bitcoin-regtest-xchain-regtest-miner:3005/tcp) echo '0.0.0.0:3025' ;;
  xchain-node-dogecoin-regtest-xchain-encoder:3003/tcp) echo '0.0.0.0:3123' ;;
  xchain-node-dogecoin-regtest-xchain-indexer:3004/tcp) echo '0.0.0.0:3124' ;;
  xchain-node-xchain-explorer:8080/tcp) echo '0.0.0.0:18080' ;;
  xchain-node-xchain-hub:10000/tcp) echo '0.0.0.0:10000' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
    const env = Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH })
    const output = execFileSync(process.execPath, [ENV_WRITER, out, 'bitcoin'], { env, encoding: 'utf8' })
    return { values: parseAssignments(out), output }
}

describe('rail-leg.yml drive environment service URLs', function () {
    it('writes host-reachable BTC and DOGE service URLs without changing generic bitcoin endpoints', function () {
        const result = writeDriveEnv()

        expect(result.values).to.include({
            BTC_INDEXER_API_URL: 'http://127.0.0.1:3024',
            DOGE_INDEXER_API_URL: 'http://127.0.0.1:3124',
            DOGE_ENCODER_URL: 'http://127.0.0.1:3123',
            ENCODER_URL: 'localhost',
            ENCODER_API_PORT: '3023',
            INDEXER_URL: 'localhost',
            INDEXER_API_PORT: '3024',
        })
        expect(result.output).to.include('BTC_INDEXER_API_URL DOGE_INDEXER_API_URL DOGE_ENCODER_URL')
        expect(result.output).to.not.include('http://127.0.0.1')
    })

    it('requires the three URLs in the unconditional setup step before every drive', function () {
        const workflow = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
        const steps = workflow.jobs.leg.steps
        const setup = steps.find((step) => step.name === 'Write the host .env for the drive')
        const drive = steps.find((step) => typeof step.name === 'string' && step.name.startsWith('Drive '))

        expect(setup).to.not.equal(undefined)
        expect(setup).to.not.have.property('if')
        expect(steps.indexOf(setup)).to.be.lessThan(steps.indexOf(drive))
        for (const name of ['BTC_INDEXER_API_URL', 'DOGE_INDEXER_API_URL', 'DOGE_ENCODER_URL']) {
            expect(setup.run).to.include(name)
        }
    })
})
