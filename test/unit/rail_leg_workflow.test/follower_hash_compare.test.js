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
const { spawnSync } = require('child_process')

const {
    followerHashSql,
    armCompareHeights,
    compareFollowerHashes,
    injectDifference,
} = require('../../../scripts/rail_follower_compare')

const CLI = path.join(__dirname, '../../../scripts/rail_follower_compare.js')
const FIELDS = ['ledger_hash', 'actions_hash', 'contract_hash', 'state_hash']

function row (height, prefix = 'hash') {
    return {
        block_index: height,
        ledger_hash: prefix + '-ledger-' + height,
        actions_hash: prefix + '-actions-' + height,
        contract_hash: prefix + '-contract-' + height,
        state_hash: prefix + '-state-' + height,
    }
}

function runCli (a, b, extra = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'follower-hash-compare-'))
    const aFile = path.join(dir, 'a.json')
    const bFile = path.join(dir, 'b.json')
    fs.writeFileSync(aFile, JSON.stringify(a))
    fs.writeFileSync(bFile, JSON.stringify(b))
    return spawnSync(process.execPath, [CLI, '--a', aFile, '--b', bFile, '--arm-height', '10', ...extra], {
        encoding: 'utf8',
    })
}

describe('rail follower hash comparison', function () {
    it('builds the four-join hash query', function () {
        const sql = followerHashSql()
        expect(sql).to.include('b.block_index AS block_index')
        for (const field of FIELDS) {
            expect(sql).to.include('b.' + field + '_id')
            expect(sql).to.include(' AS ' + field)
        }
        expect(sql).to.include('WHERE b.block_index IN (?, ?, ?)')
        expect((sql.match(/JOIN index_transactions/g) || [])).to.have.length(4)
    })

    it('matches hashes at all three armed heights', function () {
        const heights = armCompareHeights(10)
        const rows = heights.map((height) => row(height))
        expect(heights).to.deep.equal([9, 10, 15])
        expect(compareFollowerHashes(rows, rows, heights)).to.deep.equal({
            ok: true,
            heights: heights.map((height) => ({ height, verdict: 'MATCH', fields: [] })),
        })
    })

    it('names one differing hash field', function () {
        const a = [row(10)]
        const b = [{ ...row(10), actions_hash: 'different' }]
        expect(compareFollowerHashes(a, b, [10])).to.deep.equal({
            ok: false,
            heights: [{ height: 10, verdict: 'MISMATCH', fields: ['actions_hash'] }],
        })
    })

    it('marks an absent height missing', function () {
        expect(compareFollowerHashes([row(10)], [], [10]).heights[0]).to.deep.equal({
            height: 10,
            verdict: 'MISSING',
            fields: [],
        })
    })

    it('marks an all-null side missing', function () {
        const empty = { block_index: 10, ledger_hash: null, actions_hash: null, contract_hash: null, state_hash: null }
        expect(compareFollowerHashes([row(10)], [empty], [10]).heights[0].verdict).to.equal('MISSING')
    })

    it('compares string block indexes to numeric heights', function () {
        expect(compareFollowerHashes([{ ...row(10), block_index: '10' }], [row(10)], [10]).ok).to.equal(true)
    })

    it('injects a control difference without mutating its input', function () {
        const input = [row(10)]
        const copy = injectDifference(input, 10)
        expect(copy[0].state_hash).to.not.equal(input[0].state_hash)
        expect(input).to.deep.equal([row(10)])
        const result = runCli(input, input, ['--control'])
        expect(result.status).to.equal(0)
        expect(result.stdout).to.include('FOLLOWER 10 MISMATCH')
    })

    it('exits one when the control height is missing', function () {
        const rows = [row(9), row(15)]
        const result = runCli(rows, rows, ['--control'])
        expect(result.status).to.equal(1)
        expect(result.stdout).to.include('FOLLOWER 10 MISSING')
    })

    it('rejects a bad arm height', function () {
        expect(() => armCompareHeights(0)).to.throw('integer at least 1')
        expect(() => armCompareHeights(1.5)).to.throw('integer at least 1')
    })

    it('exits two for a missing flag', function () {
        const result = spawnSync(process.execPath, [CLI, '--arm-height', '10'], { encoding: 'utf8' })
        expect(result.status).to.equal(2)
        expect(result.stderr).to.include('usage:')
    })

    it('exits two for a malformed file', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'follower-hash-malformed-'))
        const bad = path.join(dir, 'bad.json')
        const good = path.join(dir, 'good.json')
        fs.writeFileSync(bad, '{')
        fs.writeFileSync(good, '[]')
        const result = spawnSync(process.execPath,
            [CLI, '--a', bad, '--b', good, '--arm-height', '10'], { encoding: 'utf8' })
        expect(result.status).to.equal(2)
        expect(result.stderr).to.include('rail_follower_compare:')
    })
})
