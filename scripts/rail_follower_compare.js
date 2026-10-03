#!/usr/bin/env node
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

const fs = require('fs')

const HASH_FIELDS = ['ledger_hash', 'actions_hash', 'contract_hash', 'state_hash']

function followerHashSql () {
    return 'SELECT b.block_index AS block_index, ' +
        'lh.hash AS ledger_hash, ah.hash AS actions_hash, ' +
        'ch.hash AS contract_hash, sh.hash AS state_hash ' +
        'FROM blocks b ' +
        'LEFT JOIN index_transactions lh ON (lh.id = b.ledger_hash_id) ' +
        'LEFT JOIN index_transactions ah ON (ah.id = b.actions_hash_id) ' +
        'LEFT JOIN index_transactions ch ON (ch.id = b.contract_hash_id) ' +
        'LEFT JOIN index_transactions sh ON (sh.id = b.state_hash_id) ' +
        'WHERE b.block_index IN (?, ?, ?) ' +
        'ORDER BY b.block_index ASC'
}

function armCompareHeights (height) {
    if (!Number.isInteger(height) || height < 1) {
        throw new Error('arm height must be an integer at least 1')
    }
    return [height - 1, height, height + 5]
}

function rowsByHeight (rows) {
    const result = new Map()
    for (const row of rows) {
        const height = Number(row.block_index)
        if (Number.isInteger(height)) result.set(height, row)
    }
    return result
}

function lacksHash (row) {
    return HASH_FIELDS.some((field) => row[field] === null || row[field] === undefined)
}

function compareFollowerHashes (a, b, heights) {
    const aByHeight = rowsByHeight(a)
    const bByHeight = rowsByHeight(b)
    const comparisons = heights.map((height) => {
        const aRow = aByHeight.get(Number(height))
        const bRow = bByHeight.get(Number(height))
        if (!aRow || !bRow || lacksHash(aRow) || lacksHash(bRow)) {
            return { height, verdict: 'MISSING', fields: [] }
        }
        const fields = HASH_FIELDS.filter((field) => aRow[field] !== bRow[field])
        return {
            height,
            verdict: fields.length === 0 ? 'MATCH' : 'MISMATCH',
            fields,
        }
    })
    return {
        ok: comparisons.every(({ verdict }) => verdict === 'MATCH'),
        heights: comparisons,
    }
}

function injectDifference (rows, height) {
    return rows.map((row) => {
        const copy = { ...row }
        if (Number(row.block_index) === Number(height)) {
            copy.state_hash = String(row.state_hash) + '-control-difference'
        }
        return copy
    })
}

function parseArgs (argv) {
    const args = {}
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === '--control') {
            if (args.control) throw new Error('duplicate --control flag')
            args.control = true
        } else if (arg === '--a' || arg === '--b' || arg === '--arm-height') {
            if (args[arg]) throw new Error('duplicate ' + arg + ' flag')
            const value = argv[++i]
            if (value === undefined || value.startsWith('--')) throw new Error('missing value for ' + arg)
            args[arg] = value
        } else {
            throw new Error('unknown argument: ' + arg)
        }
    }
    if (!args['--a'] || !args['--b'] || !args['--arm-height']) {
        throw new Error('usage: rail_follower_compare.js --a <rows.json> --b <rows.json> --arm-height <H> [--control]')
    }
    return args
}

function readRows (file) {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(rows)) throw new Error(file + ' must contain a JSON array')
    return rows
}

function main (argv = process.argv.slice(2)) {
    try {
        const args = parseArgs(argv)
        const armHeight = Number(args['--arm-height'])
        const heights = armCompareHeights(armHeight)
        const a = readRows(args['--a'])
        let b = readRows(args['--b'])
        if (args.control) b = injectDifference(b, armHeight)
        const result = compareFollowerHashes(a, b, heights)
        for (const comparison of result.heights) {
            console.log('FOLLOWER ' + comparison.height + ' ' + comparison.verdict)
        }
        if (args.control) {
            return result.heights.find(({ height }) => height === armHeight)?.verdict === 'MISMATCH' ? 0 : 1
        }
        return result.ok ? 0 : 1
    } catch (error) {
        console.error('rail_follower_compare: ' + error.message)
        return 2
    }
}

if (require.main === module) process.exitCode = main()

module.exports = {
    followerHashSql,
    armCompareHeights,
    compareFollowerHashes,
    injectDifference,
    main,
}
