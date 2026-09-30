'use strict'

// Copyright © 2025–2026 Dankest, LLC
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

function parseAssignments (file) {
    const values = {}
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^([^=]+)=(.*)$/.exec(line)
        if (match) values[match[1]] = match[2]
    }
    return values
}

function loadStackSteps () {
    const doc = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
    const steps = doc.jobs.leg.steps
    const find = (prefix) => {
        const step = steps.find((candidate) => typeof candidate.name === 'string' && candidate.name.startsWith(prefix))
        if (!step) throw new Error('workflow step not found: ' + prefix)
        return step
    }
    return {
        validator: find('Initialize the validator identity'),
        ports: find('Publish the two-stack host ports'),
        boot: find('Boot the two regtest stacks'),
    }
}

function driveStackSteps (stacks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-leg-'))
    const runnerTemp = path.join(dir, 'runner-temp')
    const bin = path.join(dir, 'stub-bin')
    const log = path.join(dir, 'node-calls.log')
    fs.mkdirSync(runnerTemp)
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'node'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "' + log + '"\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    const env = {
        PATH: bin + ':' + process.env.PATH,
        RUNNER_TEMP: runnerTemp,
        STACK_REF: 'release/vX.Y.Z',
        XCHAIN_NODE_DATA_DIR: path.join(dir, 'data'),
        XCHAIN_NODE_EXTERNAL_DB_HOST: '172.17.0.1',
    }
    if (stacks !== undefined) env.STACKS = stacks
    const steps = loadStackSteps()
    for (const step of [steps.validator, steps.ports, steps.boot]) {
        execFileSync('bash', ['-e', '-c', step.run], { cwd: dir, env, encoding: 'utf8' })
    }
    return {
        calls: fs.readFileSync(log, 'utf8').trim().split('\n').filter((line) => line.includes(' install ')),
        dir,
        stackEnv: parseAssignments(path.join(runnerTemp, 'stack.env')),
    }
}

describe('rail-leg.yml optional litecoin stack', function () {
    it('keeps stacks optional while retaining the required leg fields', function () {
        const doc = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
        expect(doc.jobs.leg.env.STACKS).to.equal("${{ matrix.stacks || 'btc,doge' }}")
        const plan = doc.jobs.plan.steps.find((step) => step.id === 'legs')
        expect(plan.run).to.include('["row","drive","leg","e2e_ref"]')
    })

    it('installs dogecoin then bitcoin only when stacks is omitted', function () {
        const result = driveStackSteps()
        expect(result.calls).to.deep.equal([
            'src/index.js install release/vX.Y.Z all dogecoin regtest',
            'src/index.js install release/vX.Y.Z all bitcoin regtest',
        ])
        expect(fs.existsSync(path.join(result.dir, 'config/litecoin-regtest'))).to.equal(false)
        expect(result.stackEnv).to.not.have.property('LTC_INDEXER_URL')
    })

    it('installs litecoin and writes its expected rail configuration when selected', function () {
        const result = driveStackSteps('btc,doge,ltc')
        expect(result.calls).to.deep.equal([
            'src/index.js install release/vX.Y.Z all dogecoin regtest',
            'src/index.js install release/vX.Y.Z all bitcoin regtest',
            'src/index.js install release/vX.Y.Z all litecoin regtest',
        ])
        expect(parseAssignments(path.join(result.dir, 'config/litecoin-regtest'))).to.deep.equal({
            NODE_EXPOSED_PORT: '3220',
            UTXO_TRACKER_PORT: '3221',
            DECODER_PORT: '3222',
            ENCODER_PORT: '3223',
            INDEXER_PORT: '3224',
            REGTEST_MINER_PORT: '3225',
            BTC_SERVICE_HOST: '172.17.0.1',
            BTC_INDEXER_API_URL: 'http://xchain-node-bitcoin-regtest-xchain-indexer:3004',
        })
        expect(result.stackEnv.LTC_INDEXER_URL).to.equal('http://xchain-node-litecoin-regtest-xchain-indexer:3004')
    })

    it('ships the host environment writer and parseable workflow files', function () {
        expect(fs.existsSync(path.join(ROOT, 'scripts/rail_leg_env.js'))).to.equal(true)
        const workflows = path.join(ROOT, '.github/workflows')
        for (const file of fs.readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
            expect(() => yaml.load(fs.readFileSync(path.join(workflows, file), 'utf8')), file).to.not.throw()
        }
    })
})
