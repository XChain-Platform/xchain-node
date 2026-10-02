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

function loadWorkflow () {
    return yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
}

function bootStep (doc) {
    const step = doc.jobs.leg.steps.find((candidate) => (
        typeof candidate.name === 'string' && candidate.name.startsWith('Boot the two regtest stacks')
    ))
    if (!step) throw new Error('workflow boot step not found')
    return step
}

function initializeStep (doc) {
    const step = doc.jobs.leg.steps.find((candidate) => candidate.name === 'Initialize the validator identity')
    if (!step) throw new Error('workflow validator identity step not found')
    return step
}

function driveInitializeStep (activation) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-leg-mirror-admission-init-'))
    const runnerTemp = path.join(dir, 'runner-temp')
    const bin = path.join(dir, 'stub-bin')
    fs.mkdirSync(runnerTemp)
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'node'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    execFileSync('bash', ['-e', '-c', initializeStep(loadWorkflow()).run], {
        cwd: dir,
        env: {
            PATH: bin + ':' + process.env.PATH,
            RUNNER_TEMP: runnerTemp,
            STACKS: 'btc,doge',
            XC_MIRROR_ADMISSION_ACTIVATION: activation,
        },
        encoding: 'utf8',
    })
    return fs.readFileSync(path.join(runnerTemp, 'stack.env'), 'utf8').trim().split('\n')
}

function driveBootStep (activation) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-leg-mirror-admission-'))
    const runnerTemp = path.join(dir, 'runner-temp')
    const bin = path.join(dir, 'stub-bin')
    const log = path.join(dir, 'node-calls.log')
    fs.mkdirSync(runnerTemp)
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(runnerTemp, 'stack.env'), '')
    fs.writeFileSync(path.join(bin, 'node'), '#!/usr/bin/env bash\nprintf "%s|%s\\n" "${XC_MIRROR_ADMISSION_ACTIVATION:-}" "$*" >> "' + log + '"\n', { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    execFileSync('bash', ['-e', '-c', bootStep(loadWorkflow()).run], {
        cwd: dir,
        env: {
            PATH: bin + ':' + process.env.PATH,
            RUNNER_TEMP: runnerTemp,
            STACK_REF: 'release/vX.Y.Z',
            XCHAIN_NODE_DATA_DIR: path.join(dir, 'data'),
            XC_MIRROR_ADMISSION_ACTIVATION: activation,
        },
        encoding: 'utf8',
    })
    // Only the stack installs carry the arm; helper scripts between them are not graded here.
    return fs.readFileSync(log, 'utf8').trim().split('\n').filter((call) => / install /.test(call))
}

describe('rail-leg.yml mirror admission', function () {
    it('arms only the list_share drive and keeps the plan contract unchanged', function () {
        const doc = loadWorkflow()
        expect(doc.jobs.leg.env.XC_MIRROR_ADMISSION_ACTIVATION).to.equal("${{ matrix.drive == 'list_share' && 'armed' || '' }}")
        const plan = doc.jobs.plan.steps.find((step) => step.id === 'legs')
        const required = /for \(const k of (\[[^\]]+\])/.exec(plan.run)
        expect(required).to.not.equal(null)
        expect(JSON.parse(required[1])).to.deep.equal(['row', 'drive', 'leg', 'e2e_ref'])
    })

    it('passes armed mirror admission to every stack install', function () {
        expect(driveBootStep('armed')).to.deep.equal([
            'armed|src/index.js install release/vX.Y.Z all dogecoin regtest',
            'armed|src/index.js install release/vX.Y.Z all bitcoin regtest',
        ])
    })

    it('leaves every stack install unarmed when activation is empty', function () {
        expect(driveBootStep('')).to.deep.equal([
            '|src/index.js install release/vX.Y.Z all dogecoin regtest',
            '|src/index.js install release/vX.Y.Z all bitcoin regtest',
        ])
    })

    it('uses regtest-length round windows only when mirror admission is armed', function () {
        const pacing = [
            'ORACLE_ROUND_INTERVAL=60000',
            'ORACLE_SUBMISSION_WINDOW=20000',
            'ATTESTATION_ROUND_TIMEOUT_MS=30000',
            'ADMISSION_WATERMARK_SAMPLE_MS=5000',
        ]
        expect(driveInitializeStep('armed')).to.include.members(pacing)
        const unarmed = driveInitializeStep('')
        for (const line of pacing) expect(unarmed).to.not.include(line)
    })
})
