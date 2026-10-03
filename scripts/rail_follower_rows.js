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
const { followerHashSql, armCompareHeights } = require('./rail_follower_compare')

const FLAGS = ['--host', '--port', '--user', '--password-env', '--database', '--arm-height', '--out']
const HASH_FIELDS = ['ledger_hash', 'actions_hash', 'contract_hash', 'state_hash']

class UsageError extends Error {}

async function readFollowerRows (query, armHeight) {
    const heights = armCompareHeights(armHeight)
    const rows = await query(followerHashSql(), heights)
    return rows.map((row) => {
        const result = { block_index: Number(row.block_index) }
        for (const field of HASH_FIELDS) {
            result[field] = row[field] === null || row[field] === undefined ? null : String(row[field])
        }
        return result
    })
}

function usage () {
    return 'usage: rail_follower_rows.js --host <h> --port <n> --user <u> ' +
        '--password-env <VAR> --database <db> --arm-height <H> --out <rows.json>'
}

function parseArgs (argv) {
    const args = {}
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i]
        if (!FLAGS.includes(flag)) throw new UsageError('unknown argument: ' + flag)
        if (args[flag] !== undefined) throw new UsageError('duplicate ' + flag + ' flag')
        const value = argv[++i]
        if (value === undefined || value.startsWith('--')) throw new UsageError('missing value for ' + flag)
        args[flag] = value
    }
    if (FLAGS.some((flag) => args[flag] === undefined)) throw new UsageError(usage())
    const port = Number(args['--port'])
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('port must be an integer from 1 to 65535')
    const armHeight = Number(args['--arm-height'])
    try {
        armCompareHeights(armHeight)
    } catch (error) {
        throw new UsageError(error.message)
    }
    return { ...args, port, armHeight }
}

async function run (argv, env) {
    let args
    try {
        args = parseArgs(argv)
    } catch (error) {
        if (!(error instanceof UsageError)) throw error
        console.error('rail_follower_rows: ' + error.message)
        return 2
    }

    const password = env[args['--password-env']]
    if (password === undefined) {
        console.error('rail_follower_rows: password environment variable is unset')
        return 2
    }

    let connection
    let rows
    let failure
    try {
        const mariadb = require('mariadb')
        connection = await mariadb.createConnection({
            host: args['--host'],
            port: args.port,
            user: args['--user'],
            password,
            database: args['--database'],
        })
        rows = await readFollowerRows(connection.query.bind(connection), args.armHeight)
        fs.writeFileSync(args['--out'], JSON.stringify(rows) + '\n', { mode: 0o600 })
        fs.chmodSync(args['--out'], 0o600)
    } catch (error) {
        failure = error
    } finally {
        if (connection) {
            try {
                await connection.end()
            } catch (error) {
                failure = failure || error
            }
        }
    }

    if (failure) {
        console.error('rail_follower_rows: database ' + args['--database'] + ' read failed')
        return 1
    }
    console.log('ROWS ' + args['--database'] + ' ' + rows.length)
    return 0
}

async function main (argv = process.argv.slice(2), env = process.env) {
    try {
        return await run(argv, env)
    } catch (error) {
        console.error('rail_follower_rows: unexpected failure')
        return 1
    }
}

if (require.main === module) {
    main().then((code) => { process.exitCode = code })
}

module.exports = { readFollowerRows, main }
