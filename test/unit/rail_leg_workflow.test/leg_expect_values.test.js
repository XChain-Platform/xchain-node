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
const path = require('path')
const yaml = require('js-yaml')
const { writeLegExpectEnv } = require('../../../scripts/rail_leg_env')

const ROOT = path.join(__dirname, '../../..')
const WORKFLOW = path.join(ROOT, '.github/workflows/rail-leg.yml')
const EXPECT_ENVS = [
    'XC_E2E_PRICE_FEE_BATCH_LANDED',
    'XC_VOTE_CALLBACK_BINDING_EXPECT',
    'XC_JSON_STRINGIFY_HOOK_EXPECT',
]

function resolveExpect (input) {
    const out = '/tmp/rail-leg-expect.env'
    const writeFileSync = fs.writeFileSync
    const log = console.log
    let written
    let error
    fs.writeFileSync = (file, contents, options) => { written = { file, contents, options } }
    console.log = () => {}
    try {
        writeLegExpectEnv(out, JSON.stringify(input))
    } catch (e) {
        error = e
    } finally {
        fs.writeFileSync = writeFileSync
        console.log = log
    }
    return { error, written }
}

function parseAssignments (contents) {
    const values = {}
    for (const line of contents.split(/\r?\n/)) {
        const match = /^([^=]+)=(.*)$/.exec(line)
        if (match) values[match[1]] = match[2]
    }
    return values
}

function loadWorkflow () {
    return yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
}

function findStep (doc, name) {
    const step = doc.jobs.leg.steps.find((candidate) => candidate.name === name)
    if (!step) throw new Error('workflow step not found: ' + name)
    return step
}

describe('rail leg expect resolver', function () {
    for (const input of [null, {}]) {
        it('writes an empty file for ' + JSON.stringify(input), function () {
            const { error, written } = resolveExpect(input)
            expect(error).to.equal(undefined)
            expect(written).to.deep.equal({
                file: '/tmp/rail-leg-expect.env',
                contents: '',
                options: { mode: 0o600 },
            })
        })
    }

    for (const [name, value] of [
        [EXPECT_ENVS[0], 'off'],
        [EXPECT_ENVS[1], 'inert'],
        [EXPECT_ENVS[2], 'armed'],
    ]) {
        it('writes ' + name + ' independently', function () {
            const { error, written } = resolveExpect({ [name]: value })
            expect(error).to.equal(undefined)
            expect(parseAssignments(written.contents)).to.deep.equal({ [name]: value })
        })
    }

    it('writes all three values in allowlist order', function () {
        const values = {
            XC_JSON_STRINGIFY_HOOK_EXPECT: 'inert',
            XC_E2E_PRICE_FEE_BATCH_LANDED: 'armed',
            XC_VOTE_CALLBACK_BINDING_EXPECT: 'armed',
        }
        const { error, written } = resolveExpect(values)
        expect(error).to.equal(undefined)
        expect(written.contents).to.equal([
            'XC_E2E_PRICE_FEE_BATCH_LANDED=armed',
            'XC_VOTE_CALLBACK_BINDING_EXPECT=armed',
            'XC_JSON_STRINGIFY_HOOK_EXPECT=inert',
            '',
        ].join('\n'))
    })

    it('rejects an unknown name and names it', function () {
        const { error } = resolveExpect({ XC_UNKNOWN_EXPECT: 'armed' })
        expect(error).to.be.an('error').with.property('message').that.includes('XC_UNKNOWN_EXPECT')
    })

    it('rejects a bad value and names its key', function () {
        const name = 'XC_E2E_PRICE_FEE_BATCH_LANDED'
        const { error } = resolveExpect({ [name]: 'inert' })
        expect(error).to.be.an('error').with.property('message').that.includes(name)
    })

    it('rejects a JSON array', function () {
        const { error } = resolveExpect([])
        expect(error).to.be.an('error').with.property('message').that.includes('must be a JSON object')
    })
})

describe('rail-leg.yml leg expect values', function () {
    it('keeps expect optional in the plan check', function () {
        const doc = loadWorkflow()
        const plan = doc.jobs.plan.steps.find((step) => step.id === 'legs')
        expect(plan.run).to.include('["row","drive","leg","e2e_ref"]')
        expect(plan.run).to.not.include('["row","drive","leg","e2e_ref","expect"]')
    })

    it('resolves matrix.expect into the job environment after the R2 arms', function () {
        const doc = loadWorkflow()
        const resolveStep = findStep(doc, 'Resolve the leg expect values')
        expect(resolveStep.env.LEG_EXPECT_JSON).to.equal('${{ toJSON(matrix.expect) }}')
        expect(resolveStep.run).to.include('rail_leg_env.js --resolve-leg-expect')
        expect(resolveStep.run).to.include('>> "$GITHUB_ENV"')
        const steps = doc.jobs.leg.steps
        expect(steps.indexOf(resolveStep)).to.equal(steps.indexOf(findStep(doc, 'Resolve the R2 arm values')) + 1)
    })
})
