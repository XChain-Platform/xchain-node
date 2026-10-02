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
const ARM_ENVS = [
    'XC_ANCHOR_FOLD_REGTEST_ACTIVATION',
    'XC_ANCHOR_STAKE_REGTEST_ACTIVATION',
    'XC_ANCHOR_SLASH_REGTEST_ACTIVATION',
]

function parseAssignments (file) {
    const values = {}
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^([^=]+)=(.*)$/.exec(line)
        if (match) values[match[1]] = match[2]
    }
    return values
}

// Output may carry generated masked credentials, so assert structure, not a digit substring.
function expectNoActivationValues (output) {
    for (const line of output.split(/\r?\n/)) {
        for (const name of ARM_ENVS) expect(line, line).to.not.match(new RegExp(name + '\\s*[=:]'))
        expect(line, line).to.not.match(/::add-mask::\s*\d+\s*$/)
    }
}

function loadWorkflow () {
    return yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
}

function findStep (doc, name) {
    const step = doc.jobs.leg.steps.find((candidate) => candidate.name === name)
    if (!step) throw new Error('workflow step not found: ' + name)
    return step
}

function resolveArms (values) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-leg-anchor-arms-'))
    const out = path.join(dir, 'arms.env')
    const env = Object.assign({}, process.env)
    for (const name of ARM_ENVS) delete env[name]
    Object.assign(env, values)
    const result = spawnSync(process.execPath, [ENV_WRITER, '--resolve-anchor-arms', out], {
        env,
        encoding: 'utf8',
    })
    return { out, result }
}

function writeDriveEnv (values) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-leg-anchor-drive-'))
    const bin = path.join(dir, 'stub-bin')
    const out = path.join(dir, '.env')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nif [ "$1" = port ]; then echo "127.0.0.1:3020"; else echo "[]"; fi\n', { mode: 0o755 })
    const env = Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH })
    for (const name of ARM_ENVS) delete env[name]
    Object.assign(env, values)
    const output = execFileSync(process.execPath, [ENV_WRITER, out, 'bitcoin'], { env, encoding: 'utf8' })
    return { out, output }
}

function driveSetupSteps (height) {
    const doc = loadWorkflow()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-leg-anchor-setup-'))
    const runnerTemp = path.join(dir, 'runner-temp')
    const bin = path.join(dir, 'stub-bin')
    fs.mkdirSync(runnerTemp)
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'node'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    const env = {
        PATH: bin + ':' + process.env.PATH,
        RUNNER_TEMP: runnerTemp,
        STACKS: 'btc,doge',
        XCHAIN_NODE_EXTERNAL_DB_HOST: '172.17.0.1',
    }
    for (const name of ARM_ENVS) env[name] = height
    execFileSync('bash', ['-e', '-c', findStep(doc, 'Initialize the validator identity').run], {
        cwd: dir,
        env,
    })
    execFileSync('bash', ['-e', '-c', findStep(doc, 'Publish the two-stack host ports').run], {
        cwd: dir,
        env,
    })
    return { dir, runnerTemp }
}

function defineWorkflowInputTests () {
    it('declares three optional inputs and resolves them before any stack install', function () {
        const doc = loadWorkflow()
        const inputs = doc.on.workflow_dispatch.inputs
        for (const name of ARM_ENVS) {
            expect(inputs[name].required, name).to.equal(false)
            expect(findStep(doc, 'Resolve the anchor arm height').env[name], name)
                .to.equal('${{ inputs.' + name + ' }}')
        }
        const steps = doc.jobs.leg.steps
        expect(steps.indexOf(findStep(doc, 'Resolve the anchor arm height')))
            .to.be.lessThan(steps.indexOf(findStep(doc, 'Boot the two regtest stacks at ${{ inputs.stack_ref || \'develop\' }}')))
    })
}

function defineResolutionTests () {
    it('canonicalizes any populated input into one height for all three gates', function () {
        const { out, result } = resolveArms({ XC_ANCHOR_STAKE_REGTEST_ACTIVATION: '0042' })
        expect(result.status, result.stderr).to.equal(0)
        expect(parseAssignments(out)).to.deep.equal(Object.fromEntries(ARM_ENVS.map((name) => [name, '42'])))
        expectNoActivationValues(result.stdout)
        expect(ARM_ENVS.filter((name) => result.stdout.includes(name))).to.deep.equal(ARM_ENVS)
    })

    it('exports nothing when unset and rejects conflicting or invalid heights', function () {
        const unset = resolveArms({})
        expect(unset.result.status, unset.result.stderr).to.equal(0)
        expect(fs.readFileSync(unset.out, 'utf8')).to.equal('')

        const conflicting = resolveArms({
            XC_ANCHOR_FOLD_REGTEST_ACTIVATION: '40',
            XC_ANCHOR_SLASH_REGTEST_ACTIVATION: '41',
        })
        expect(conflicting.result.status).to.not.equal(0)
        expect(conflicting.result.stderr).to.include('must resolve to one height')

        const invalid = resolveArms({ XC_ANCHOR_FOLD_REGTEST_ACTIVATION: 'later' })
        expect(invalid.result.status).to.not.equal(0)
        expect(invalid.result.stderr).to.include('must be a non-negative integer')

        for (const zero of ['0', '000']) {
            const refused = resolveArms({ XC_ANCHOR_STAKE_REGTEST_ACTIVATION: zero })
            expect(refused.result.status, zero).to.not.equal(0)
            expect(refused.result.stderr).to.include('must be an integer at least 1')
        }
    })
}

function defineStackPropagationTests () {
    it('puts the same height in the standing stack and both indexer configs', function () {
        const setup = driveSetupSteps('42')
        const expected = Object.fromEntries(ARM_ENVS.map((name) => [name, '42']))
        expect(parseAssignments(path.join(setup.runnerTemp, 'stack.env'))).to.include(expected)
        expect(parseAssignments(path.join(setup.dir, 'config/bitcoin-regtest'))).to.include(expected)
        expect(parseAssignments(path.join(setup.dir, 'config/dogecoin-regtest'))).to.include(expected)
    })

    it('leaves the standing stack and both indexer configs unchanged when unset', function () {
        const setup = driveSetupSteps(undefined)
        for (const file of [
            path.join(setup.runnerTemp, 'stack.env'),
            path.join(setup.dir, 'config/bitcoin-regtest'),
            path.join(setup.dir, 'config/dogecoin-regtest'),
        ]) {
            expect(parseAssignments(file)).to.not.have.any.keys(ARM_ENVS)
        }
    })
}

function defineDrivePropagationTests () {
    it('writes the resolved heights into the drive environment without logging values', function () {
        const values = Object.fromEntries(ARM_ENVS.map((name) => [name, '42']))
        const { out, output } = writeDriveEnv(values)
        expect(parseAssignments(out)).to.include(Object.fromEntries(ARM_ENVS.map((name) => [name, '42'])))
        expectNoActivationValues(output)
        expect(ARM_ENVS.filter((name) => output.includes(name))).to.deep.equal(ARM_ENVS)
    })

    it('leaves the drive environment and missing-value diagnostics unchanged when unset', function () {
        const { out, output } = writeDriveEnv({})
        expect(parseAssignments(out)).to.not.have.any.keys(ARM_ENVS)
        for (const name of ARM_ENVS) expect(output).to.not.include(name)
    })
}

describe('rail-leg.yml anchor arm heights', function () {
    defineWorkflowInputTests()
    defineResolutionTests()
    defineStackPropagationTests()
    defineDrivePropagationTests()
})
