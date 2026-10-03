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

// Pin that the regtest rail's LLM credential reaches only the step running the leg,
// only when the dispatch asks for it, and is masked and never printed.

const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const ROOT = path.join(__dirname, '../../..')
const WORKFLOW = path.join(ROOT, '.github/workflows/attest-mirror-leg.yml')
const SECRET = 'HUB_CLAUDE_CODE_OAUTH_TOKEN'
const SECRET_REF = 'secrets.' + SECRET
const CLI_PACKAGE = '@anthropic-ai/claude-code'

function load () {
    const text = fs.readFileSync(WORKFLOW, 'utf8')
    return { text, workflow: yaml.load(text) }
}

function legSteps (workflow) {
    return workflow.jobs.leg.steps
}

function runStep (workflow) {
    const step = legSteps(workflow).find((s) => /^Run /.test(s.name || ''))
    expect(step, 'the leg job has a Run step').to.exist
    return step
}

describe('attest-mirror-leg.yml hub llm credential gating', function () {
    it('declares hub_llm as a boolean dispatch input that is off by default', function () {
        const { workflow } = load()
        const input = workflow.on.workflow_dispatch.inputs.hub_llm
        expect(input).to.include({ type: 'boolean', default: false })
    })

    it('references the secret exactly once, in the Run step env, gated on hub_llm', function () {
        const { text, workflow } = load()
        expect(text.split(SECRET_REF).length - 1).to.equal(1)
        const env = runStep(workflow).env
        expect(env[SECRET]).to.equal("${{ inputs.hub_llm == true && secrets.HUB_CLAUDE_CODE_OAUTH_TOKEN || '' }}")
        expect(env.HUB_CLAUDE_CONFIG_DIR).to.match(/^\$\{\{ inputs\.hub_llm == true && .*\|\| '' \}\}$/)
    })

    it('never puts the secret in workflow-level, job-level or any other step env', function () {
        const { workflow } = load()
        expect(JSON.stringify(workflow.env || {})).to.not.include(SECRET)
        for (const [name, job] of Object.entries(workflow.jobs)) {
            expect(JSON.stringify(job.env || {}), 'job ' + name).to.not.include(SECRET)
            for (const step of job.steps || []) {
                if (name === 'leg' && step === runStep(workflow)) continue
                expect(JSON.stringify(step.env || {}), 'step ' + (step.name || step.uses)).to.not.include(SECRET)
                expect(JSON.stringify(step.with || {}), 'step ' + (step.name || step.uses)).to.not.include(SECRET)
            }
        }
    })

})

describe('attest-mirror-leg.yml hub llm credential masking and placement', function () {
    it('masks the token before any leg output and never echoes or writes it anywhere else', function () {
        const { workflow } = load()
        const script = String(runStep(workflow).run)
        const firstLine = script.split('\n')[0]
        expect(firstLine).to.equal('if [ -n "$HUB_CLAUDE_CODE_OAUTH_TOKEN" ]; then echo "::add-mask::$HUB_CLAUDE_CODE_OAUTH_TOKEN"; fi')
        for (const job of Object.values(workflow.jobs)) {
            for (const step of job.steps || []) {
                const lines = String(step.run || '').split('\n').filter((l) => l.includes(SECRET))
                for (const line of lines) {
                    expect(line, 'only the mask line may name the token in a script').to.equal(firstLine)
                }
            }
        }
        expect(script).to.not.match(/HUB_CLAUDE_CODE_OAUTH_TOKEN.*(GITHUB_ENV|GITHUB_OUTPUT)/)
    })

    it('installs the hub CLI and makes the hub config dir only when hub_llm is on', function () {
        const { workflow } = load()
        const steps = legSteps(workflow)
        const install = steps.find((s) => /hub llm CLI/.test(s.name || ''))
        expect(install, 'an install step for the hub llm CLI').to.exist
        expect(install.if).to.equal('inputs.hub_llm == true')
        expect(install.run).to.include(CLI_PACKAGE + '@2.1.266')
        expect(install.run).to.include('mkdir -m 700 -p "$RUNNER_TEMP/hub-claude"')
        expect(install.run).to.not.include(SECRET)
        expect(steps.indexOf(install)).to.be.below(steps.indexOf(runStep(workflow)))
    })

    it('keeps the hub config dir out of the uploaded leg logs', function () {
        const { workflow } = load()
        const upload = legSteps(workflow).find((s) => /upload-artifact/.test(s.uses || ''))
        expect(upload.with.path).to.equal('${{ runner.temp }}/am-logs/')
        expect(runStep(workflow).env.HUB_CLAUDE_CONFIG_DIR).to.include("format('{0}/hub-claude', runner.temp)")
    })

    it('pins the CLI to the version the hub image installs', function () {
        const dockerfile = path.join(ROOT, '..', 'xchain-hub', 'Dockerfile')
        if (!fs.existsSync(dockerfile)) this.skip()
        const pinned = fs.readFileSync(dockerfile, 'utf8').match(new RegExp(CLI_PACKAGE + '@([0-9.]+)'))
        expect(pinned, 'the hub Dockerfile pins the CLI').to.exist
        const install = legSteps(load().workflow).find((s) => /hub llm CLI/.test(s.name || ''))
        expect(install.run).to.include(CLI_PACKAGE + '@' + pinned[1])
    })
})
