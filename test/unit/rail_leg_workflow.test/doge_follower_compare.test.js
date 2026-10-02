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
const ARM_INPUTS = [
    'XC_ANCHOR_FOLD_REGTEST_ACTIVATION',
    'XC_ANCHOR_STAKE_REGTEST_ACTIVATION',
    'XC_ANCHOR_SLASH_REGTEST_ACTIVATION',
]

function loadWorkflow () {
    return yaml.load(fs.readFileSync(WORKFLOW, 'utf8'))
}

function findStep (doc, name) {
    const step = doc.jobs.leg.steps.find((candidate) => candidate.name === name)
    if (!step) throw new Error('workflow step not found: ' + name)
    return step
}

function assignments (file) {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => line.split('=')))
}

describe('rail-leg.yml DOGE follower comparison', function () {
    it('clones before the drive and compares after it only for an armed run', function () {
        const doc = loadWorkflow()
        const steps = doc.jobs.leg.steps
        const resolve = findStep(doc, 'Resolve the anchor arm height')
        const clone = findStep(doc, 'Clone forward DOGE follower')
        const drive = findStep(doc, 'Drive ${{ matrix.drive }} ${{ matrix.leg }}')
        const compare = findStep(doc, 'Compare DOGE follower state hashes')

        expect(resolve.id).to.equal('anchor-arms')
        expect(resolve.run).to.include('echo "height=$XC_ANCHOR_FOLD_REGTEST_ACTIVATION" >> "$GITHUB_OUTPUT"')
        expect(clone.if).to.equal("${{ steps.anchor-arms.outputs.height != '' }}")
        expect(compare.if).to.equal("${{ success() && steps.anchor-arms.outputs.height != '' }}")
        expect(compare.env.DOGE_FOLLOWER_ARM_HEIGHT).to.equal('${{ steps.anchor-arms.outputs.height }}')
        expect(compare.run).to.include('H="$DOGE_FOLLOWER_ARM_HEIGHT"')
        expect(compare.run).to.not.match(/H="\$XC_ANCHOR_(?:FOLD|STAKE|SLASH)_REGTEST_ACTIVATION"/)
        expect(steps.indexOf(clone)).to.be.lessThan(steps.indexOf(drive))
        expect(steps.indexOf(compare)).to.be.greaterThan(steps.indexOf(drive))
    })

    it('uses the canonical height for fold-only, stake-only and slash-only inputs', function () {
        const resolve = findStep(loadWorkflow(), 'Resolve the anchor arm height')

        for (const input of ARM_INPUTS) {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-follower-arm-'))
            const githubEnv = path.join(dir, 'github.env')
            const githubOutput = path.join(dir, 'github.output')
            const env = { ...process.env, RUNNER_TEMP: dir, GITHUB_ENV: githubEnv, GITHUB_OUTPUT: githubOutput }
            for (const name of ARM_INPUTS) delete env[name]
            env[input] = '0042'

            execFileSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', resolve.run], { cwd: ROOT, env })

            expect(assignments(githubOutput), input).to.deep.equal({ height: '42' })
            expect(assignments(githubEnv), input)
                .to.deep.equal(Object.fromEntries(ARM_INPUTS.map((name) => [name, '42'])))
        }
    })

    it('clones the stopped standing database and launches an unexposed follower', function () {
        const clone = findStep(loadWorkflow(), 'Clone forward DOGE follower')

        expect(clone.env.DOGE_SOURCE_CONTAINER).to.equal('xchain-node-dogecoin-regtest-xchain-indexer')
        expect(clone.env.DOGE_FOLLOWER_DB).to.equal('XChain_DOGE_DrillB_Indexer')
        expect(clone.run).to.include('followerEnvLines')
        expect(clone.run).to.include('followerCreateArgs')
        expect(clone.run).to.include('cloneStatements')
        expect(clone.run).to.match(/^set -euo pipefail\numask 077\n/)
        expect(clone.run.indexOf('docker stop "$DOGE_SOURCE_CONTAINER"'))
            .to.be.lessThan(clone.run.indexOf('const statements = cloneStatements'))
        expect(clone.run.indexOf('const statements = cloneStatements'))
            .to.be.lessThan(clone.run.lastIndexOf('docker start "$DOGE_SOURCE_CONTAINER"'))
        expect(clone.run).to.include("trap 'docker start \"$DOGE_SOURCE_CONTAINER\" >/dev/null || true' EXIT")
        expect(clone.run).to.not.match(/\bmariadb(?:-dump)?\b.*(?:-p|--password)/)
        expect(clone.run).to.not.include('--publish')
    })

    it('reads H-1, H and H+5 from both followers before proving equality', function () {
        const compare = findStep(loadWorkflow(), 'Compare DOGE follower state hashes')
        const reads = compare.run.match(/node scripts\/rail_follower_rows\.js/g) || []

        expect(reads).to.have.length(2)
        expect(compare.run).to.include('--database "$DOGE_FOLLOWER_SOURCE_DB"')
        expect(compare.run).to.include('--database "$DOGE_FOLLOWER_DB"')
        expect(compare.run).to.include('[h-1,h,h+5]')
        expect(compare.run).to.include('rail_follower_compare.js --a "$A" --b "$B" --arm-height "$H"')
        expect(compare.run).to.include('$JOURNAL_DIR/follower')
    })

    it('requires the injected-difference control to report a mismatch', function () {
        const compare = findStep(loadWorkflow(), 'Compare DOGE follower state hashes')
        const commands = compare.run.split('\n').filter((line) => line.includes('rail_follower_compare.js'))

        expect(commands).to.have.length(2)
        expect(commands[0]).to.not.include('--control')
        expect(commands[1]).to.include('--control')
        expect(commands[1]).to.include('control.log')
    })
})
