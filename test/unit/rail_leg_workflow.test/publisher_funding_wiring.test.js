'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The boot step must fund the standing hub's DOGE publisher after the DOGE stack
// (and its regtest miner) is up and before the BTC stack can produce checkpoints
// that call for an anchor. A stub `node` records each invocation in order.

const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const yaml = require('js-yaml')

const ROOT = path.join(__dirname, '../../..')
const WORKFLOW = path.join(ROOT, '.github/workflows/rail-leg.yml')

function bootStep () {
    const doc = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
    const step = doc.jobs.leg.steps.find((candidate) => /^Boot the two regtest stacks/.test(candidate.name))
    if (!step) throw new Error('boot step not found')
    return step.run
}

function runBoot (stacks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-publisher-wiring-'))
    const runnerTemp = path.join(dir, 'runner-temp')
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(runnerTemp)
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(runnerTemp, 'stack.env'), 'HUB_NETWORK=regtest\n')
    const stub = ['#!/usr/bin/env bash', 'echo "$*" >> "$RUNNER_TEMP/calls.log"', '']
    fs.writeFileSync(path.join(bin, 'node'), stub.join('\n'), { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\n', { mode: 0o755 })
    const env = {
        PATH: bin + ':' + process.env.PATH,
        RUNNER_TEMP: runnerTemp,
        STACK_REF: 'develop',
        STACKS: stacks,
        XCHAIN_NODE_DATA_DIR: path.join(dir, 'data'),
    }
    execFileSync('bash', ['-e', '-c', bootStep()], { cwd: dir, env })
    return fs.readFileSync(path.join(runnerTemp, 'calls.log'), 'utf8').trim().split('\n')
}

describe('rail leg publisher funding wiring', function () {
    it('funds the publisher after the DOGE stack and before the BTC stack', function () {
        const calls = runBoot('btc,doge')
        const doge = calls.indexOf('src/index.js install develop all dogecoin regtest')
        const fund = calls.indexOf('scripts/rail_fund_publisher.js')
        const btc = calls.indexOf('src/index.js install develop all bitcoin regtest')
        expect(doge, calls.join(' | ')).to.be.at.least(0)
        expect(fund).to.equal(doge + 1)
        expect(btc).to.equal(fund + 1)
    })

    it('calls the funding script exactly once with an LTC stack beside them', function () {
        const calls = runBoot('btc,doge,ltc')
        expect(calls.filter((call) => call === 'scripts/rail_fund_publisher.js')).to.have.length(1)
        expect(calls[calls.length - 1]).to.equal('src/index.js install develop all litecoin regtest')
    })

    it('names a script that exists and exits quietly with no anchor arm set', function () {
        const script = path.join(ROOT, 'scripts/rail_fund_publisher.js')
        expect(fs.existsSync(script)).to.equal(true)
        const env = { PATH: process.env.PATH }
        expect(execFileSync(process.execPath, [script], { env, encoding: 'utf8' })).to.equal('')
    })
})
