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

const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const yaml = require('js-yaml')

const ROOT = path.join(__dirname, '../../..')
const WORKFLOW = path.join(ROOT, '.github/workflows/rail-leg.yml')
const ENCODER_URL = 'http://xchain-node-dogecoin-regtest-xchain-encoder:3003'
const SIGNER_MODULE = '/XChainHub/operator-signer/signer.js'

function parseAssignments (file) {
    const values = {}
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^([^=]+)=(.*)$/.exec(line)
        if (match) values[match[1]] = match[2]
    }
    return values
}

function initializeStep () {
    const doc = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
    const step = doc.jobs.leg.steps.find((candidate) => candidate.name === 'Initialize the validator identity')
    if (!step) throw new Error('validator initialization step not found')
    return step.run
}

function runInitialize (values) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-hub-anchor-pipeline-'))
    const runnerTemp = path.join(dir, 'runner-temp')
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(runnerTemp)
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'node'), [
        '#!/usr/bin/env bash',
        'env > "$RUNNER_TEMP/validator-init.env"',
        'printf \'%s\\n\' "$@" > "$RUNNER_TEMP/validator-init.args"',
        '',
    ].join('\n'), { mode: 0o755 })

    const env = {
        PATH: bin + ':' + process.env.PATH,
        RUNNER_TEMP: runnerTemp,
        STACKS: 'btc,doge',
    }
    Object.assign(env, values)
    execFileSync('bash', ['-e', '-c', initializeStep()], { cwd: dir, env })
    return {
        initEnv: parseAssignments(path.join(runnerTemp, 'validator-init.env')),
        initArgs: fs.readFileSync(path.join(runnerTemp, 'validator-init.args'), 'utf8'),
        stackEnv: parseAssignments(path.join(runnerTemp, 'stack.env')),
    }
}

describe('rail leg standing hub anchor pipeline', function () {
    it('gives every anchor-armed regtest validator the container encoder before identity initialization', function () {
        for (const arm of [
            'XC_ANCHOR_FOLD_REGTEST_ACTIVATION',
            'XC_ANCHOR_STAKE_REGTEST_ACTIVATION',
            'XC_ANCHOR_SLASH_REGTEST_ACTIVATION',
        ]) {
            const result = runInitialize({ [arm]: '42' })
            expect(result.initArgs, arm).to.include('validator\ninit\n')
            expect(result.initEnv.DOGE_ENCODER_URL, arm).to.equal(ENCODER_URL)
            expect(result.stackEnv, arm).to.include({
                HUB_NETWORK: 'regtest',
                DOGE_ENCODER_URL: ENCODER_URL,
                HUB_SIGNER_MODULE: SIGNER_MODULE,
            })
        }
    })

    it('does not enable the standing hub anchor pipeline for a non-anchor arm', function () {
        const result = runInitialize({ XC_CONTRACTS_REGTEST_ACTIVATION: '42' })
        expect(result.initEnv).to.not.have.property('DOGE_ENCODER_URL')
        expect(result.stackEnv).to.not.have.property('DOGE_ENCODER_URL')
        expect(result.stackEnv).to.not.have.property('HUB_SIGNER_MODULE')
    })
})
