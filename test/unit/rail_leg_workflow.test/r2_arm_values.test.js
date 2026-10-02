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
const { execFileSync, spawnSync } = require('child_process')
const yaml = require('js-yaml')

const ROOT = path.join(__dirname, '../../..')
const WORKFLOW = path.join(ROOT, '.github/workflows/rail-leg.yml')
const ENV_WRITER = path.join(ROOT, 'scripts/rail_leg_env.js')
const R2_ARM_ENVS = [
    'XC_AMOUNTS_PRICE_REGTEST_ACTIVATION',
    'XC_AMOUNTS_PRICE_REGTEST_TIME',
    'XC_CONTRACTS_REGTEST_ACTIVATION',
]

function parseAssignments (file) {
    const values = {}
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^([^=]+)=(.*)$/.exec(line)
        if (match) values[match[1]] = match[2]
    }
    return values
}

function resolveArms (values) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-leg-r2-arms-'))
    const out = path.join(dir, 'arms.env')
    const env = Object.assign({}, process.env)
    for (const name of R2_ARM_ENVS) delete env[name]
    Object.assign(env, values)
    const result = spawnSync(process.execPath, [ENV_WRITER, '--resolve-r2-arms', out], {
        env,
        encoding: 'utf8',
    })
    return { out, result }
}

function writeDriveEnv (values) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-leg-r2-drive-'))
    const bin = path.join(dir, 'stub-bin')
    const out = path.join(dir, '.env')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nif [ "$1" = port ]; then echo "127.0.0.1:3020"; else echo "[]"; fi\n', { mode: 0o755 })
    const env = Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH })
    for (const name of R2_ARM_ENVS) delete env[name]
    Object.assign(env, values)
    const output = execFileSync(process.execPath, [ENV_WRITER, out, 'bitcoin'], { env, encoding: 'utf8' })
    return { out, output }
}

function loadWorkflow () {
    return yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
}

function findStep (doc, name) {
    const step = doc.jobs.leg.steps.find((candidate) => candidate.name === name)
    if (!step) throw new Error('workflow step not found: ' + name)
    return step
}

describe('rail-leg.yml R2 arm values', function () {
    it('writes an empty file when no value is set', function () {
        const { out, result } = resolveArms({})
        expect(result.status, result.stderr).to.equal(0)
        expect(fs.readFileSync(out, 'utf8')).to.equal('')
    })

    for (const [name, value] of [
        [R2_ARM_ENVS[0], '21'],
        [R2_ARM_ENVS[1], '1700000000'],
        [R2_ARM_ENVS[2], '34'],
    ]) {
        it('writes ' + name + ' independently', function () {
            const { out, result } = resolveArms({ [name]: value })
            expect(result.status, result.stderr).to.equal(0)
            expect(parseAssignments(out)).to.deep.equal({ [name]: value })
            expect(result.stdout).to.not.include(value)
        })
    }

    it('keeps all configured values independent', function () {
        const values = {
            XC_AMOUNTS_PRICE_REGTEST_ACTIVATION: '55112233445511223344',
            XC_AMOUNTS_PRICE_REGTEST_TIME: '66223344556622334455',
            XC_CONTRACTS_REGTEST_ACTIVATION: '77334455667733445566',
        }
        const { out, result } = resolveArms(values)
        expect(result.status, result.stderr).to.equal(0)
        expect(parseAssignments(out)).to.deep.equal(values)
        for (const value of Object.values(values)) expect(result.stdout).to.not.include(value)
    })

    it('writes the same values into the drive environment without logging them', function () {
        const values = {
            XC_AMOUNTS_PRICE_REGTEST_ACTIVATION: '88445566778844556677',
            XC_AMOUNTS_PRICE_REGTEST_TIME: '99556677889955667788',
            XC_CONTRACTS_REGTEST_ACTIVATION: '11667788991166778899',
        }
        const { out, output } = writeDriveEnv(values)
        expect(parseAssignments(out)).to.include(values)
        for (const value of Object.values(values)) expect(output).to.not.include(value)
    })

    it('rejects a bad value by name without printing its value', function () {
        const badValue = 'invalid-r2-value'
        const name = R2_ARM_ENVS[1]
        const { result } = resolveArms({ [name]: badValue })
        expect(result.status).to.not.equal(0)
        expect(result.stderr).to.include(name)
        expect(result.stderr).to.include('must be a non-negative integer')
        expect(result.stdout + result.stderr).to.not.include(badValue)
    })

    it('declares ten inputs and resolves the three optional R2 values beside the anchor step', function () {
        const doc = loadWorkflow()
        const inputs = doc.on.workflow_dispatch.inputs
        expect(Object.keys(inputs)).to.have.length(10)
        const resolveStep = findStep(doc, 'Resolve the R2 arm values')
        for (const name of R2_ARM_ENVS) {
            expect(inputs[name].required, name).to.equal(false)
            expect(resolveStep.env[name], name).to.equal('${{ inputs.' + name + ' }}')
        }
        expect(resolveStep.run).to.include('rail_leg_env.js --resolve-r2-arms')
        expect(resolveStep.run).to.include('>> "$GITHUB_ENV"')
        const steps = doc.jobs.leg.steps
        expect(steps.indexOf(resolveStep)).to.equal(steps.indexOf(findStep(doc, 'Resolve the anchor arm height')) + 1)
    })

    it('names every R2 value in both standing stack configuration loops', function () {
        const doc = loadWorkflow()
        const runs = [
            findStep(doc, 'Initialize the validator identity').run,
            findStep(doc, 'Publish the two-stack host ports').run,
        ]
        for (const run of runs) {
            for (const name of R2_ARM_ENVS) expect(run, name).to.include(name)
        }
    })
})
