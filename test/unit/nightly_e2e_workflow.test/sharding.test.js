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
// The action suite runs as parallel shards (scripts/e2e_shard_plan.js) that a
// per-coin aggregate folds back into the e2e-logs-<coin> artifact the release
// cut kit grades (scripts/e2e_shard_merge.js). Pinned here: the shard patterns
// select, through mocha's own glob, exactly the files the unsharded glob did;
// the aggregate keeps the job and artifact names the cut kit reads; and a
// missing, red or empty shard fails its coin.

const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const yaml = require('js-yaml')
const lookupFiles = require('mocha/lib/cli/lookup-files')

const { buildPlan, listActionFiles } = require('../../../scripts/e2e_shard_plan')
const { merge, countSummary } = require('../../../scripts/e2e_shard_merge')

const WORKFLOW = path.join(__dirname, '../../../.github/workflows/nightly-e2e.yml')
const WEIGHTS = require('../../../scripts/e2e_shard_weights.json')

const FIXTURE_FILES = [
    'address.test.js', 'airdrop.test.js', 'airdrop.test/02_v0_balance_verification.test.js',
    'attestation.test.js', 'attestation.test/01_accepts.test.js', 'batch.test.js', 'coinpay.test.js',
    'controller_policy.test.js', 'dispenser.test.js', 'dispenser.test/08_v1_cancel.test.js',
    'order.test.js', 'order.test/02_v1_cancel.test.js', 'order.test/07_v2_edit.test.js',
    'send.test.js', 'sleep.test.js', 'brand_new_suite.test.js',
]

function fixtureTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-shard-plan-'))
    for (const file of FIXTURE_FILES) {
        const full = path.join(root, 'test/actions', file)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, '')
    }
    // A support module beside the part files is not a spec in either glob.
    fs.mkdirSync(path.join(root, 'test/actions/attestation.test/support'), { recursive: true })
    fs.writeFileSync(path.join(root, 'test/actions/attestation.test/support/shared.js'), '')
    return root
}

function mochaFiles(root, spec) {
    const cwd = process.cwd()
    process.chdir(root)
    try {
        return [].concat(lookupFiles(spec, ['js'], false))
    } finally {
        process.chdir(cwd)
    }
}

function registerPlanChecks() {
    describe('the plan', function () {
        let root, files, plan

        before(function () {
            root = fixtureTree()
            files = listActionFiles(path.join(root, 'test/actions'))
            plan = buildPlan({ files, shards: 3, suite: '', weights: WEIGHTS, version: '9.9.9' })
        })

        it('selects, through mocha lookupFiles, exactly the files the unsharded glob selects, each once', function () {
            const full = mochaFiles(root, 'test/actions/**/*.test.js')
            const union = plan.shards.flatMap(n => mochaFiles(root, `test/actions/${plan.plan[n].pattern}.test.js`))
            expect(union.slice().sort()).to.deep.equal(full.slice().sort())
            expect(new Set(union).size).to.equal(union.length)
        })

        it('keeps a suite and its <stem>.test/ part files on one shard', function () {
            const owner = g => plan.shards.find(n => plan.plan[n].groups.includes(g))
            for (const g of ['airdrop', 'attestation', 'dispenser', 'order']) {
                const shardFiles = mochaFiles(root, `test/actions/${plan.plan[owner(g)].pattern}.test.js`)
                const groupFiles = FIXTURE_FILES.filter(f => f === `${g}.test.js` || f.startsWith(`${g}.test/`))
                for (const f of groupFiles) expect(shardFiles, g).to.include(`test/actions/${f}`)
            }
        })

        it('schedules a suite with no measured weight instead of dropping it', function () {
            expect(plan.unweighted).to.deep.equal(['brand_new_suite'])
            expect(plan.shards.some(n => plan.plan[n].groups.includes('brand_new_suite'))).to.equal(true)
        })

        it('puts security and performance on shard 1 only', function () {
            expect(plan.plan[1].extras).to.deep.equal(['security', 'performance'])
            for (const n of plan.shards.slice(1)) expect(plan.plan[n].extras).to.deep.equal([])
        })

        it('keeps a single-suite dispatch as one shard running its argument verbatim, with no extra legs', function () {
            const single = buildPlan({ files, shards: 5, suite: 'order', weights: WEIGHTS, version: '9.9.9' })
            expect(single.shards).to.deep.equal([1])
            expect(single.plan[1]).to.include({ pattern: 'order' })
            expect(single.plan[1].extras).to.deep.equal([])
        })

        it('refuses more shards than groups rather than leaving one empty', function () {
            expect(() => buildPlan({ files, shards: 99, suite: '', weights: WEIGHTS, version: '9.9.9' })).to.throw(/empty/)
        })
    })
}

function registerWorkflowChecks() {
    describe('the workflow', function () {
        let doc

        before(function () { doc = yaml.load(fs.readFileSync(WORKFLOW, 'utf8')) })

        it('keeps the aggregate job id `e2e` with the coin as its only matrix key, so it renders as `e2e (<coin>)`', function () {
            expect(Object.keys(doc.jobs.e2e.strategy.matrix)).to.deep.equal(['coin'])
            expect(doc.jobs.e2e.name).to.equal(undefined)
            expect(doc.jobs['e2e-shard'].strategy.matrix).to.have.keys('coin', 'shard')
        })

        it('runs the aggregate after the shards even when one failed, and fails it per coin', function () {
            expect(doc.jobs.e2e.needs).to.include('e2e-shard')
            expect(doc.jobs.e2e.if).to.match(/!cancelled\(\)/)
            const upload = doc.jobs.e2e.steps.find(s => s.uses && s.uses.startsWith('actions/upload-artifact'))
            expect(upload.with.name).to.equal('e2e-logs-${{ env.COIN }}')
            const shardUpload = doc.jobs['e2e-shard'].steps.find(s => s.uses && s.uses.startsWith('actions/upload-artifact'))
            expect(shardUpload.with.name).to.equal('e2e-shard-${{ env.COIN }}-${{ matrix.shard }}')
        })

        it('expands the coin list the way the unsharded matrix did: schedule and all are three coins, a dispatch is one', function () {
            const expr = doc.jobs.plan.steps.find(s => s.id === 'coins').env.COINS
            const evaluate = (event, coin) => {
                const body = expr.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
                    .replace(/github\.event_name/g, JSON.stringify(event))
                    .replace(/github\.event\.inputs\.coin/g, JSON.stringify(coin))
                    .replace(/format\('\["\{0\}"\]', ([^)]*)\)/, (_, arg) => `('["' + (${arg}) + '"]')`)
                return JSON.parse(Function(`return (${body})`)())
            }
            const three = ['bitcoin', 'litecoin', 'dogecoin']
            expect(evaluate('schedule', '')).to.deep.equal(three)
            expect(evaluate('workflow_dispatch', 'all')).to.deep.equal(three)
            expect(evaluate('workflow_dispatch', 'dogecoin')).to.deep.equal(['dogecoin'])
            expect(evaluate('workflow_dispatch', '')).to.deep.equal(['bitcoin'])
        })

        it('runs security and performance on shard 1 of a full pass only', function () {
            for (const prefix of ['Run the e2e Security suite', 'Run the e2e Performance suite']) {
                const step = doc.jobs['e2e-shard'].steps.find(s => (s.name || '').startsWith(prefix))
                expect(step.if).to.equal("env.SUITE == '' && matrix.shard == 1")
            }
        })
    })
}

const MERGE_COIN = 'bitcoin'
const MERGE_PLAN = {
    version: '9.9.9', suite: '', shard_count: 2, shards: [1, 2],
    plan: {
        1: { groups: ['address'], pattern: '{address,address.test/**/*}', extras: ['security', 'performance'] },
        2: { groups: ['send'], pattern: '{send,send.test/**/*}', extras: [] },
    },
}

function writeShard(dir, n, { actionExit = '0', passing = 5, failing = 0 } = {}) {
    const shard = path.join(dir, `e2e-shard-${MERGE_COIN}-${n}`)
    fs.mkdirSync(path.join(shard, 'diagnostics'), { recursive: true })
    fs.writeFileSync(path.join(shard, 'diagnostics', 'docker-ps.txt'), 'ps\n')
    const summary = `\n  ${passing} passing (1m)\n` + (failing ? `  ${failing} failing\n` : '')
    fs.writeFileSync(path.join(shard, `a${n}.log`), `\u001b[0m  SUITE ${n}\n    ✔ works (10ms)\n${summary}`)
    const status = { coin: MERGE_COIN, shard: n, pattern: MERGE_PLAN.plan[n].pattern, action_exit: actionExit, action_log: `a${n}.log` }
    if (n === 1) {
        fs.writeFileSync(path.join(shard, 's.log'), '\n> xchain-e2e-test@9.9.9 test:security\n> mocha\n\n  13 passing (6m)\n')
        fs.writeFileSync(path.join(shard, 'p.log'), '\n> xchain-e2e-test@9.9.9 test:perf:budget\n> mocha\n\n  8 passing (20s)\n')
        Object.assign(status, { security_exit: '0', security_log: 's.log', performance_exit: '0', performance_log: 'p.log' })
    }
    fs.writeFileSync(path.join(shard, 'shard-status.json'), JSON.stringify(status))
}

function runMerge(setup) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-shard-merge-'))
    setup(dir)
    const out = path.join(dir, 'out')
    return { summary: merge({ coin: MERGE_COIN, plan: MERGE_PLAN, shardsDir: dir, out }), out }
}

function registerMergeChecks() {
    describe('the merge', function () {
        it('writes ONE bannered action log whose last summary is the sum, and no second leg log anywhere', function () {
            const { summary, out } = runMerge(dir => { writeShard(dir, 1, { passing: 3 }); writeShard(dir, 2, { passing: 4 }) })
            expect(summary.reasons).to.deep.equal([])
            const merged = fs.readFileSync(path.join(out, 'bitcoin-regtest-action-merged.log'), 'utf8')
            expect(merged).to.match(/^>\s+xchain-e2e-test@9\.9\.9\s+test\s*$/m)
            expect(countSummary(merged)).to.deep.equal({ passing: 7, pending: 0, failing: 0 })
            const logs = []
            const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.log') && logs.push(e.name)))
            walk(out)
            expect(logs.sort()).to.deep.equal(['bitcoin-regtest-action-merged.log', 'p.log', 's.log'])
            expect(fs.existsSync(path.join(out, 'shards', '2', 'a2.log.txt'))).to.equal(true)
        })

        it('fails the coin when a shard never uploaded', function () {
            const { summary } = runMerge(dir => writeShard(dir, 1))
            expect(summary.reasons.join('; ')).to.match(/shard 2: no e2e-shard-bitcoin-2 artifact/)
        })

        it('fails the coin on a red shard, and writes no merged action log', function () {
            const { summary, out } = runMerge(dir => { writeShard(dir, 1); writeShard(dir, 2, { actionExit: '1', failing: 2 }) })
            expect(summary.reasons.join('; ')).to.match(/shard 2: action suite exit code 1/).and.match(/2 failing/)
            expect(fs.existsSync(path.join(out, 'bitcoin-regtest-action-merged.log'))).to.equal(false)
        })

        it('fails the coin on a shard that ran no tests', function () {
            const { summary } = runMerge(dir => { writeShard(dir, 1); writeShard(dir, 2, { passing: 0 }) })
            expect(summary.reasons.join('; ')).to.match(/shard 2: action shard ran no tests/)
        })
    })
}

describe('nightly-e2e.yml action-suite sharding', function () {
    registerPlanChecks()
    registerWorkflowChecks()
    registerMergeChecks()
})
