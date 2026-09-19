'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Drives the real bin/ci-full.sh (copied beside a scratch sibling layout,
// never the real ../xchain-indexer checkout) to prove a declared-but-missing
// sibling fails loud and by name at need_sib, before any tier runs. The
// coverage-job half is asserted structurally against the parsed workflow,
// the way test/unit/nightly_e2e_workflow.test/two_stack_legs.test.js does.

const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const yaml = require('js-yaml')

const REPO_ROOT = path.join(__dirname, '../../..')
const CI_FULL = path.join(REPO_ROOT, 'bin/ci-full.sh')
const WORKFLOW = path.join(REPO_ROOT, '.github/workflows/ci.yml')
const REAL_CI_SIBLINGS = fs.readFileSync(path.join(REPO_ROOT, '.ci-siblings'), 'utf8')

// A throwaway `xchain-node/` plus declared siblings, laid out the way
// bin/ci-full.sh expects, with a stub `npm` so the "ci" tier does not
// try to run the real suite.
function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-full-sib-'))
    const nodeDir = path.join(root, 'xchain-node', 'bin')
    fs.mkdirSync(nodeDir, { recursive: true })
    fs.copyFileSync(CI_FULL, path.join(nodeDir, 'ci-full.sh'))
    fs.chmodSync(path.join(nodeDir, 'ci-full.sh'), 0o755)
    fs.writeFileSync(path.join(root, 'xchain-node', '.ci-siblings'), REAL_CI_SIBLINGS)
    for (const sib of ['xchain-hub', 'xchain-indexer']) fs.mkdirSync(path.join(root, sib))

    const fakebin = path.join(root, 'fakebin')
    fs.mkdirSync(fakebin)
    const npmStub = '#!/usr/bin/env bash\n'
        + 'echo "FAKE-NPM args=[$*] XCHAIN_REQUIRE_SIBLINGS=[${XCHAIN_REQUIRE_SIBLINGS:-unset}]"\n'
        + 'exit 0\n'
    fs.writeFileSync(path.join(fakebin, 'npm'), npmStub)
    fs.chmodSync(path.join(fakebin, 'npm'), 0o755)

    return { root, fakebin, scriptPath: path.join(nodeDir, 'ci-full.sh') }
}

function runCiFull({ scriptPath, fakebin }) {
    try {
        const stdout = execFileSync('bash', [scriptPath], {
            env: { ...process.env, PATH: fakebin + ':' + process.env.PATH },
            encoding: 'utf8',
        })
        return { status: 0, stdout, stderr: '' }
    } catch (err) {
        return { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' }
    }
}

describe('bin/ci-full.sh sibling roster', () => {
    it('reads .ci-siblings instead of a second hard-coded list', () => {
        const src = fs.readFileSync(CI_FULL, 'utf8')
        expect(src).to.match(/\.ci-siblings/, 'ci-full.sh no longer cites the roster file')
        expect(src).to.not.match(/^need_sib xchain-hub\s*$/m,
            'ci-full.sh still hard-codes need_sib to a single sibling instead of the roster')
    })

    it('passes need_sib and arms XCHAIN_REQUIRE_SIBLINGS when every declared sibling is present', () => {
        const fx = makeFixture()
        const res = runCiFull(fx)
        fs.rmSync(fx.root, { recursive: true, force: true })

        expect(res.stdout).to.include('ci:full ===== ci =====', 'never reached the ci tier')
        expect(res.stdout).to.include('XCHAIN_REQUIRE_SIBLINGS=[1]',
            'ci tier ran without the flag ci-reusable.yml arms when siblings are checked out')
    })

    it('FALSIFIES: refuses at need_sib, naming the missing sibling, when xchain-indexer is absent', () => {
        const fx = makeFixture()
        fs.rmSync(path.join(fx.root, 'xchain-indexer'), { recursive: true, force: true })
        const res = runCiFull(fx)
        fs.rmSync(fx.root, { recursive: true, force: true })

        expect(res.status).to.equal(1, 'a missing declared sibling must fail the run')
        expect(res.stderr).to.include('MISSING SIBLING')
        expect(res.stderr).to.include('xchain-indexer', 'refusal did not name the missing sibling')
        expect(res.stdout).to.not.include('ci:full ===== ci =====',
            'this must fail at need_sib, before any tier runs')
    })
})

describe('.github/workflows/ci.yml coverage job', () => {
    const doc = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
    const steps = doc.jobs.coverage.steps

    it('checks declared siblings out before re-running the unit suite for coverage', () => {
        const siblingStep = steps.find((s) => s.id === 'siblings')
        expect(siblingStep, 'coverage job has no sibling-checkout step').to.exist
        expect(siblingStep.run).to.include('.ci-siblings')
        expect(siblingStep.run).to.include('GITHUB_OUTPUT')
    })

    it('arms XCHAIN_REQUIRE_SIBLINGS for coverage:check only when the checkout actually happened', () => {
        const coverageStep = steps.find((s) => s.name === 'Coverage thresholds (c8 --check-coverage)')
        expect(coverageStep.env.XCHAIN_REQUIRE_SIBLINGS).to.include('steps.siblings.outputs.checked-out')
    })
})
