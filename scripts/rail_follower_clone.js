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

const IDENTIFIER = /^[A-Za-z0-9_]+$/
const OMITTED_ENV_KEYS = new Set(['HOME', 'HOSTNAME', 'PATH', 'INDEXER_DB_NAME'])

function envKey (line) {
    const separator = line.indexOf('=')
    return separator === -1 ? line : line.slice(0, separator)
}

function followerEnvLines (sourceEnv, followerDb) {
    if (!Array.isArray(sourceEnv)) throw new Error('source environment must be an array')
    const sourceDbLine = sourceEnv.find((line) => envKey(line) === 'INDEXER_DB_NAME')
    if (sourceDbLine === undefined) throw new Error('source environment has no INDEXER_DB_NAME')
    const sourceDb = sourceDbLine.slice(sourceDbLine.indexOf('=') + 1)
    if (!followerDb) throw new Error('follower database is required')
    if (!IDENTIFIER.test(followerDb)) throw new Error('invalid follower database identifier')
    if (followerDb === sourceDb) throw new Error('follower database must differ from source database')

    return sourceEnv
        .filter((line) => !OMITTED_ENV_KEYS.has(envKey(line)))
        .concat('INDEXER_DB_NAME=' + followerDb)
}

function followerCreateArgs (options = {}) {
    const fields = ['container', 'network', 'envFile', 'image']
    for (const field of fields) {
        if (typeof options[field] !== 'string' || options[field].length === 0) {
            throw new Error(field + ' is required')
        }
    }
    return [
        'create',
        '--name', options.container,
        '--network', options.network,
        '--env-file', options.envFile,
        options.image,
    ]
}

function checkedIdentifier (value, label) {
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
        throw new Error('invalid ' + label + ' identifier')
    }
    return '`' + value + '`'
}

function cloneStatements (sourceDb, followerDb, tables) {
    const source = checkedIdentifier(sourceDb, 'source database')
    const follower = checkedIdentifier(followerDb, 'follower database')
    if (sourceDb === followerDb) throw new Error('follower database must differ from source database')
    if (!Array.isArray(tables)) throw new Error('tables must be an array')

    const statements = [
        'DROP DATABASE IF EXISTS ' + follower + ';',
        'CREATE DATABASE ' + follower + ';',
    ]
    for (const table of tables) {
        const name = checkedIdentifier(table, 'table')
        statements.push('CREATE TABLE ' + follower + '.' + name + ' LIKE ' + source + '.' + name + ';')
        statements.push('INSERT INTO ' + follower + '.' + name + ' SELECT * FROM ' + source + '.' + name + ';')
    }
    return statements
}

module.exports = {
    followerEnvLines,
    followerCreateArgs,
    cloneStatements,
}
