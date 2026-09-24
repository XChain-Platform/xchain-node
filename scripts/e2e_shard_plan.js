#!/usr/bin/env node
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

// Splits xchain-e2e-test's action suite into N shards for the nightly-e2e
// workflow, so one coin's ~3h15m action pass runs as N parallel stacks instead of one.

// A shard's unit is a GROUP: one test/actions/<stem>.test.js plus every
// test/actions/<stem>.test/**/*.test.js beside it. Part files share state
// via modules like attestation.test/support/shared.js, so a group never splits.

// Each shard is expressed as the testName argument `e2etest` takes: runE2ETest
// builds `test/actions/${testName}.test.js` and hands it to mocha. The mocha
// glob and locale sort match the full `test/actions/**/*.test.js` run unchanged.

// No change needed to xchain-node's CLI or e2e repo code: both are installed at
// the ref under test, not at this workflow's.

// Assignment is longest-processing-time-first over weights (see e2e_shard_weights.json).
// The plan is computed ONCE per run by the plan job; every shard and aggregate reads
// that one plan, so a mid-run branch change cannot create shard disagreement.

const fs = require('fs')
const path = require('path')

const GROUP_NAME = /^[A-Za-z0-9_-]+$/

function parseArgs(argv) {
    const args = { e2eDir: null, shards: null, suite: '', weights: null }
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i]
        const value = argv[i + 1]
        if (flag === '--e2e-dir') args.e2eDir = value
        else if (flag === '--shards') args.shards = Number(value)
        else if (flag === '--suite') args.suite = value || ''
        else if (flag === '--weights') args.weights = value
        else throw new Error(`unknown argument ${flag}`)
        i += 1
    }
    if (!args.e2eDir) throw new Error('--e2e-dir is required')
    if (!args.weights) throw new Error('--weights is required')
    if (!Number.isInteger(args.shards) || args.shards < 1) throw new Error('--shards must be a positive integer')
    return args
}

function listActionFiles(actionsDir) {
    const files = []
    const pending = [actionsDir]
    while (pending.length > 0) {
        const current = pending.pop()
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) pending.push(full)
            else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(path.relative(actionsDir, full).split(path.sep).join('/'))
        }
    }
    return files.sort()
}

function groupOf(file) {
    return file.split('/')[0].replace(/\.test(\.js)?$/, '')
}

// Both halves of a group go in the brace set, so every shard pattern carries a
// `**` and mocha takes the glob path even for a shard of one plain file.
function shardPattern(groups) {
    return '{' + groups.flatMap(g => [g, `${g}.test/**/*`]).join(',') + '}'
}

function buildPlan({ files, shards, suite, weights, version }) {
    const groups = [...new Set(files.map(groupOf))].sort()
    if (groups.length === 0) throw new Error('no action suites found under test/actions')
    const bad = groups.filter(g => !GROUP_NAME.test(g))
    if (bad.length > 0) throw new Error(`group names outside ${GROUP_NAME}: ${bad.join(', ')}`)

    // A single-suite dispatch proves one fix; it keeps its old one-stack shape
    // and its old argument, verbatim, and earns no security or performance leg.
    if (suite) {
        return {
            version, suite, shard_count: 1, shards: [1], groups: [suite],
            plan: { 1: { groups: [suite], pattern: suite, weight_s: null, extras: [] } },
        }
    }

    if (shards > groups.length) throw new Error(`${shards} shards for ${groups.length} groups would leave a shard empty`)

    const table = weights.weights || {}
    const weightOf = g => (Number.isFinite(table[g]) ? table[g] : weights.default_weight_s)
    const unweighted = groups.filter(g => !Number.isFinite(table[g]))

    const bins = Array.from({ length: shards }, (_, i) => ({ shard: i + 1, groups: [], load: 0, extras: [] }))
    // Shard 1 also runs the security and performance suites after its action
    // subset, the same order the unsharded job ran them in, so it starts loaded.
    bins[0].load = weights.security_performance_weight_s
    bins[0].extras = ['security', 'performance']

    const ordered = [...groups].sort((a, b) => (weightOf(b) - weightOf(a)) || a.localeCompare(b, 'en'))
    for (const g of ordered) {
        const bin = bins.reduce((min, b) => (b.load < min.load ? b : min), bins[0])
        bin.groups.push(g)
        bin.load += weightOf(g)
    }

    const plan = {}
    for (const bin of bins) {
        bin.groups.sort((a, b) => a.localeCompare(b, 'en'))
        plan[bin.shard] = { groups: bin.groups, pattern: shardPattern(bin.groups), weight_s: bin.load, extras: bin.extras }
    }

    // Coverage is asserted here rather than trusted to the loop: every group in
    // exactly one shard, and no shard empty.
    const seen = bins.flatMap(b => b.groups)
    if (seen.length !== groups.length || new Set(seen).size !== groups.length) throw new Error('plan does not partition the groups')
    if (bins.some(b => b.groups.length === 0)) throw new Error('plan left a shard empty')

    return { version, suite: '', shard_count: shards, shards: bins.map(b => b.shard), groups, unweighted, plan }
}

function main() {
    const args = parseArgs(process.argv.slice(2))
    const weights = JSON.parse(fs.readFileSync(args.weights, 'utf8'))
    const actionsDir = path.join(args.e2eDir, 'test', 'actions')
    const files = listActionFiles(actionsDir)
    const pkg = JSON.parse(fs.readFileSync(path.join(args.e2eDir, 'package.json'), 'utf8'))
    const result = buildPlan({ files, shards: args.shards, suite: args.suite, weights, version: String(pkg.version || 'unknown') })
    process.stdout.write(JSON.stringify(result) + '\n')
}

if (require.main === module) {
    try {
        main()
    } catch (error) {
        process.stderr.write(`e2e_shard_plan: ${error.message}\n`)
        process.exit(1)
    }
}

module.exports = { buildPlan, listActionFiles, groupOf, shardPattern }
