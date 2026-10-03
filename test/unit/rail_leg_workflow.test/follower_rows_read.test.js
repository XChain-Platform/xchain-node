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
const path = require('path')
const { spawnSync } = require('child_process')

const { followerHashSql } = require('../../../scripts/rail_follower_compare')
const { readFollowerRows } = require('../../../scripts/rail_follower_rows')

const CLI = path.join(__dirname, '../../../scripts/rail_follower_rows.js')
const REQUIRED = [
    '--host', '127.0.0.1',
    '--port', '3306',
    '--user', 'reader',
    '--password-env', 'FOLLOWER_ROWS_TEST_PASSWORD',
    '--database', 'follower',
    '--arm-height', '10',
    '--out', 'rows.json',
]

function runCli (args, env = process.env) {
    return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env })
}

describe('rail follower row reader', function () {
    it('queries once with the comparison SQL and three armed heights', async function () {
        const calls = []
        const query = async (...args) => {
            calls.push(args)
            return [{
                block_index: 10n,
                ledger_hash: 'ledger',
                actions_hash: null,
                contract_hash: 123,
                state_hash: undefined,
                ignored: 'value',
            }]
        }

        expect(await readFollowerRows(query, 10)).to.deep.equal([{
            block_index: 10,
            ledger_hash: 'ledger',
            actions_hash: null,
            contract_hash: '123',
            state_hash: null,
        }])
        expect(calls).to.deep.equal([[followerHashSql(), [9, 10, 15]]])
    })

    it('returns an empty list for an empty answer', async function () {
        expect(await readFollowerRows(async () => [], 10)).to.deep.equal([])
    })

    it('rejects a bad arm height before querying', async function () {
        let calls = 0
        const query = async () => { calls += 1 }
        let failure
        try {
            await readFollowerRows(query, 0)
        } catch (error) {
            failure = error
        }
        expect(failure).to.be.an('error').with.property('message').that.includes('integer at least 1')
        expect(calls).to.equal(0)
    })
})

describe('rail follower row reader CLI usage', function () {
    it('exits two for a missing flag', function () {
        const result = runCli(['--arm-height', '10'])
        expect(result.status).to.equal(2)
        expect(result.stderr).to.include('usage:')
    })

    it('exits two for a bad arm height', function () {
        const args = [...REQUIRED]
        args[args.indexOf('--arm-height') + 1] = 'not-a-height'
        const result = runCli(args)
        expect(result.status).to.equal(2)
        expect(result.stderr).to.include('arm height')
    })

    it('exits two for an unset password variable', function () {
        const env = { ...process.env }
        delete env.FOLLOWER_ROWS_TEST_PASSWORD
        const result = runCli(REQUIRED, env)
        expect(result.status).to.equal(2)
        expect(result.stderr).to.include('environment variable is unset')
    })
})
