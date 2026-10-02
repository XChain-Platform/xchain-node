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

const {
    followerEnvLines,
    followerCreateArgs,
    cloneStatements,
} = require('../../../scripts/rail_follower_clone')

describe('rail follower clone plan', function () {
    it('keeps source configuration order while dropping container defaults and redirecting the database', function () {
        const source = [
            'HOME=/root',
            'INDEXER_DB_USER=indexer',
            'HUB_API_URL=http://hub:10000',
            'HOSTNAME=source-indexer',
            'INDEXER_DB_PASS=secret=value',
            'INDEXER_DB_NAME=source_db',
            'COIN=bitcoin',
            'PATH=/usr/local/bin:/usr/bin',
        ]

        expect(followerEnvLines(source, 'follower_db')).to.deep.equal([
            'INDEXER_DB_USER=indexer',
            'HUB_API_URL=http://hub:10000',
            'INDEXER_DB_PASS=secret=value',
            'COIN=bitcoin',
            'INDEXER_DB_NAME=follower_db',
        ])
        expect(source).to.include('INDEXER_DB_NAME=source_db')
    })

    it('rejects source environments without a database', function () {
        expect(() => followerEnvLines(['COIN=bitcoin'], 'follower_db'))
            .to.throw('no INDEXER_DB_NAME')
    })

    it('rejects empty follower databases', function () {
        expect(() => followerEnvLines(['INDEXER_DB_NAME=source_db'], ''))
            .to.throw('follower database is required')
    })

    it('rejects invalid follower database identifiers', function () {
        expect(() => followerEnvLines(['INDEXER_DB_NAME=source_db'], 'follower-db'))
            .to.throw('invalid follower database identifier')
    })

    it('rejects a follower database equal to the source', function () {
        expect(() => followerEnvLines(['INDEXER_DB_NAME=source_db'], 'source_db'))
            .to.throw('must differ')
    })

    it('builds docker create arguments without publishing a port', function () {
        const args = followerCreateArgs({
            container: 'follower-indexer',
            network: 'node-network',
            envFile: '/tmp/follower.env',
            image: 'xchain-indexer:test',
        })
        expect(args).to.deep.equal([
            'create',
            '--name', 'follower-indexer',
            '--network', 'node-network',
            '--env-file', '/tmp/follower.env',
            'xchain-indexer:test',
        ])
        expect(args).to.not.include('-p')
        expect(args).to.not.include('--publish')
    })

    it('rejects every missing docker create field', function () {
        const complete = {
            container: 'follower-indexer',
            network: 'node-network',
            envFile: '/tmp/follower.env',
            image: 'xchain-indexer:test',
        }
        for (const field of Object.keys(complete)) {
            expect(() => followerCreateArgs({ ...complete, [field]: '' })).to.throw(field + ' is required')
        }
    })

    it('builds the database and two-table clone statements', function () {
        expect(cloneStatements('source_db', 'follower_db', ['blocks', 'transactions'])).to.deep.equal([
            'DROP DATABASE IF EXISTS `follower_db`;',
            'CREATE DATABASE `follower_db`;',
            'CREATE TABLE `follower_db`.`blocks` LIKE `source_db`.`blocks`;',
            'INSERT INTO `follower_db`.`blocks` SELECT * FROM `source_db`.`blocks`;',
            'CREATE TABLE `follower_db`.`transactions` LIKE `source_db`.`transactions`;',
            'INSERT INTO `follower_db`.`transactions` SELECT * FROM `source_db`.`transactions`;',
        ])
    })

    it('rejects bad SQL identifiers', function () {
        expect(() => cloneStatements('source-db', 'follower_db', ['blocks'])).to.throw('source database')
        expect(() => cloneStatements('source_db', 'follower-db', ['blocks'])).to.throw('follower database')
        expect(() => cloneStatements('source_db', 'follower_db', ['bad-table'])).to.throw('table')
    })

    it('rejects equal clone databases', function () {
        expect(() => cloneStatements('source_db', 'source_db', ['blocks'])).to.throw('must differ')
    })
})
