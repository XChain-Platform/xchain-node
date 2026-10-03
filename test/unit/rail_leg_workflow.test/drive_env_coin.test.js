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

function driveEnvStep () {
    const workflow = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
    return workflow.jobs.leg.steps.find((step) => step.name === 'Write the host .env for the drive')
}

function parseAssignments (file) {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
    }))
}

function writeDockerStub (bin) {
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
  xchain-node-dogecoin-regtest-node:18444/tcp) echo '0.0.0.0:3120' ;;
  xchain-node-dogecoin-regtest-xchain-utxo-tracker:3001/tcp) echo '0.0.0.0:3121' ;;
  xchain-node-dogecoin-regtest-xchain-decoder:3002/tcp) echo '0.0.0.0:3122' ;;
  xchain-node-dogecoin-regtest-xchain-encoder:3003/tcp) echo '0.0.0.0:3123' ;;
  xchain-node-dogecoin-regtest-xchain-indexer:3004/tcp) echo '0.0.0.0:3124' ;;
  xchain-node-dogecoin-regtest-xchain-regtest-miner:3005/tcp) echo '0.0.0.0:3125' ;;
  xchain-node-xchain-explorer:8080/tcp) echo '0.0.0.0:18080' ;;
  xchain-node-xchain-hub:10000/tcp) echo '0.0.0.0:10000' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
}

function runDriveEnvStep (helperCoin) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-leg-drive-coin-'))
    const bin = path.join(dir, 'bin')
    const e2e = path.join(dir, 'xchain-e2e-test')
    fs.mkdirSync(bin)
    fs.mkdirSync(e2e)
    writeDockerStub(bin)
    if (helperCoin) {
        const helpers = path.join(e2e, 'test/helpers')
        fs.mkdirSync(helpers, { recursive: true })
        fs.writeFileSync(path.join(helpers, 'rail_leg_coins.js'), `
if (process.argv[2] !== 'anchor_stake' || process.argv[3] !== 'gap-4') process.exit(2)
process.stdout.write(${JSON.stringify(helperCoin)})
`)
    }
    const env = Object.assign({}, process.env, {
        DRIVE: 'anchor_stake',
        LEG: 'gap-4',
        PATH: bin + ':' + process.env.PATH,
        RAIL_ROOT: dir,
    })
    try {
        execFileSync('bash', ['-e', '-c', driveEnvStep().run], { cwd: ROOT, env, encoding: 'utf8' })
        const btc = path.join(e2e, '.env.btc')
        return Object.assign(parseAssignments(path.join(e2e, '.env')), {
            btcEnv: fs.existsSync(btc) ? parseAssignments(btc) : null,
        })
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

describe('rail-leg.yml drive environment coin', function () {
    it('passes the matrix drive and leg into the setup step', function () {
        expect(driveEnvStep().env).to.deep.equal({
            DRIVE: '${{ matrix.drive }}',
            LEG: '${{ matrix.leg }}',
        })
    })

    it('uses the drive coin helper when it exists', function () {
        expect(runDriveEnvStep('dogecoin').COIN).to.equal('dogecoin')
    })

    it('defaults to bitcoin when the drive coin helper is absent', function () {
        expect(runDriveEnvStep().COIN).to.equal('bitcoin')
    })

    // The federation seed runs as COIN=bitcoin on every leg; on a dogecoin leg the e2e
    // loader (test/helpers/rail/coin_env.js) takes .env.btc for it (R-3 attempt 5).
    it('writes a bitcoin .env.btc beside a dogecoin leg env', function () {
        const written = runDriveEnvStep('dogecoin')
        expect(written.INDEXER_API_PORT).to.equal('3124')
        expect(written.btcEnv).to.include({ COIN: 'bitcoin', INDEXER_API_PORT: '3024' })
    })

    it('writes no .env.btc on a bitcoin leg', function () {
        expect(runDriveEnvStep().btcEnv).to.equal(null)
        expect(runDriveEnvStep('bitcoin').btcEnv).to.equal(null)
    })
})
