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

// Folds one coin's e2e-shard-<coin>-<n> artifacts back into e2e-logs-<coin>,
// refusing unless every shard in the plan ran clean.

// The release matrix judge walks every *.log, identifies a leg by npm banner
// `> xchain-e2e-test@<v> test|test:security|test:perf:budget`, rejects duplicates,
// and takes the LAST passing/pending/failing summary line.

// Artifact structure: <coin>-regtest-action-merged.log with merged summary, security
// and perf logs from shard 1, shards/<n>/* with .log renamed .log.txt, and shard-merge.json.

// Shards run via `e2etest <coin> <pattern>` (npx mocha, no npm banner), so this
// script writes the banner on the merged log after all shards are proven clean.

const fs = require('fs')
const path = require('path')

const LEG_BANNER = /^>\s+xchain-e2e-test@\S+\s+(test|test:security|test:perf:budget)\s*$/m
const LEG_SCRIPT = { security: 'test:security', performance: 'test:perf:budget' }

function stripAnsi(value) {
    return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}

// Same rule judge-matrix.js countSummary applies: last line of each kind wins.
function countSummary(text) {
    const counts = { passing: null, pending: 0, failing: 0 }
    for (const line of stripAnsi(text).split(/\r?\n/)) {
        const match = line.match(/^\s*([\d,]+)\s+(passing|pending|failing)\b/)
        if (match) counts[match[2]] = Number(match[1].replaceAll(',', ''))
    }
    return counts
}

function parseArgs(argv) {
    const args = {}
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i]
        if (!['--coin', '--plan', '--shards-dir', '--out'].includes(key)) throw new Error(`unknown argument ${key}`)
        args[key.slice(2)] = argv[i + 1]
    }
    for (const key of ['coin', 'plan', 'shards-dir', 'out']) if (!args[key]) throw new Error(`--${key} is required`)
    return args
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function copyTree(from, to, rename) {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name)
        if (entry.isDirectory()) copyTree(source, path.join(to, entry.name), rename)
        else if (entry.isFile()) fs.copyFileSync(source, path.join(to, rename(entry.name)))
    }
}

// One shard's verdict. Every reason names the shard, so a red aggregate says
// which runner to open.
function checkShard({ coin, n, entry, dir }) {
    const reasons = []
    const tag = `shard ${n}`
    if (!fs.existsSync(dir)) return { reasons: [`${tag}: no e2e-shard-${coin}-${n} artifact (the shard job did not reach its upload)`] }
    const statusFile = path.join(dir, 'shard-status.json')
    if (!fs.existsSync(statusFile)) return { reasons: [`${tag}: artifact has no shard-status.json`] }
    const status = readJson(statusFile)

    if (status.coin !== coin) reasons.push(`${tag}: status names coin ${status.coin}`)
    if (Number(status.shard) !== n) reasons.push(`${tag}: status names shard ${status.shard}`)
    if (status.pattern !== entry.pattern) reasons.push(`${tag}: ran pattern ${JSON.stringify(status.pattern)}, plan says ${JSON.stringify(entry.pattern)}`)
    if (String(status.action_exit) !== '0') reasons.push(`${tag}: action suite exit code ${status.action_exit || 'missing'}`)

    const legs = {}
    const actionPath = status.action_log ? path.join(dir, status.action_log) : null
    if (!actionPath || !fs.existsSync(actionPath)) {
        reasons.push(`${tag}: action log ${status.action_log || '(none recorded)'} is missing`)
    } else {
        const text = fs.readFileSync(actionPath, 'utf8')
        const counts = countSummary(text)
        if (counts.passing === null) reasons.push(`${tag}: action log has no Mocha passing summary`)
        else if (counts.passing + counts.failing === 0) reasons.push(`${tag}: action shard ran no tests`)
        if (counts.failing > 0) reasons.push(`${tag}: action shard has ${counts.failing} failing test(s)`)
        legs.action = { file: actionPath, text, counts }
    }

    for (const leg of entry.extras || []) {
        const exit = status[`${leg}_exit`]
        const file = status[`${leg}_log`]
        if (String(exit) !== '0') reasons.push(`${tag}: ${leg} suite exit code ${exit || 'missing'}`)
        const full = file ? path.join(dir, file) : null
        if (!full || !fs.existsSync(full)) {
            reasons.push(`${tag}: ${leg} log ${file || '(none recorded)'} is missing`)
            continue
        }
        const text = fs.readFileSync(full, 'utf8')
        const banner = text.match(LEG_BANNER)
        if (!banner || banner[1] !== LEG_SCRIPT[leg]) reasons.push(`${tag}: ${leg} log carries no ${LEG_SCRIPT[leg]} banner`)
        const counts = countSummary(text)
        if (counts.passing === null || counts.passing + counts.failing === 0) reasons.push(`${tag}: ${leg} suite ran no tests`)
        if (counts.failing > 0) reasons.push(`${tag}: ${leg} suite has ${counts.failing} failing test(s)`)
        legs[leg] = { file: full, counts }
    }
    return { reasons, legs }
}

function merge({ coin, plan, shardsDir, out }) {
    const reasons = []
    const shardDir = n => path.join(shardsDir, `e2e-shard-${coin}-${n}`)
    const results = []
    for (const n of plan.shards) {
        const entry = plan.plan[n]
        if (!entry) {
            reasons.push(`shard ${n}: absent from the plan`)
            continue
        }
        const result = checkShard({ coin, n, entry, dir: shardDir(n) })
        reasons.push(...result.reasons)
        results.push({ n, entry, legs: result.legs || {} })
    }

    fs.mkdirSync(out, { recursive: true })
    const summary = { coin, shard_count: plan.shard_count, suite: plan.suite, shards: [], reasons }
    for (const { n, entry, legs } of results) {
        summary.shards.push({ shard: n, groups: entry.groups, action: legs.action ? legs.action.counts : null })
        if (fs.existsSync(shardDir(n))) copyTree(shardDir(n), path.join(out, 'shards', String(n)), name => name.replace(/\.log$/, '.log.txt'))
    }

    if (reasons.length === 0) {
        const totals = { passing: 0, pending: 0, failing: 0 }
        const body = []
        for (const { n, entry, legs } of results) {
            for (const key of Object.keys(totals)) totals[key] += legs.action.counts[key]
            body.push(`=== shard ${n}/${plan.shard_count}: ${entry.groups.join(' ')} ===`, legs.action.text)
        }
        // A single-suite dispatch was never a full action pass, and the old job
        // gave it no npm banner at all, so the judge must not find one here.
        const banner = plan.suite
            ? `> xchain-e2e-test@${plan.version} test [${plan.suite} only]`
            : `> xchain-e2e-test@${plan.version} test`
        const lines = [
            '',
            banner,
            `> mocha --timeout 0 --exit --require ./test/initialCheck.test.js 'test/actions/**/*.test.js' (sharded ${plan.shard_count} ways by nightly-e2e.yml; per-shard output follows)`,
            '',
            ...body,
            `=== merged summary over ${plan.shard_count} shard(s) ===`,
            `  ${totals.passing} passing`,
            `  ${totals.pending} pending`,
            `  ${totals.failing} failing`,
            '',
        ]
        fs.writeFileSync(path.join(out, `${coin}-regtest-action-merged.log`), lines.join('\n'))
        summary.action = totals
        for (const { legs } of results) {
            for (const leg of Object.keys(LEG_SCRIPT)) {
                if (legs[leg]) fs.copyFileSync(legs[leg].file, path.join(out, path.basename(legs[leg].file)))
            }
        }
    }
    fs.writeFileSync(path.join(out, 'shard-merge.json'), JSON.stringify(summary, null, 2) + '\n')
    return summary
}

function main() {
    const args = parseArgs(process.argv.slice(2))
    const summary = merge({ coin: args.coin, plan: readJson(args.plan), shardsDir: args['shards-dir'], out: args.out })
    for (const s of summary.shards) {
        const c = s.action
        process.stdout.write(`${args.coin} shard ${s.shard}: ${c ? `${c.passing} passing, ${c.pending} pending, ${c.failing} failing` : 'no action result'} (${s.groups.length} groups)\n`)
    }
    if (summary.reasons.length > 0) {
        for (const reason of summary.reasons) process.stdout.write(`::error::${args.coin} ${reason}\n`)
        process.exit(1)
    }
    const t = summary.action
    process.stdout.write(`${args.coin} merged action: ${t.passing} passing, ${t.pending} pending, ${t.failing} failing over ${summary.shard_count} shard(s)\n`)
}

if (require.main === module) {
    try {
        main()
    } catch (error) {
        process.stdout.write(`::error::e2e_shard_merge: ${error.message}\n`)
        process.exit(1)
    }
}

module.exports = { merge, countSummary }
