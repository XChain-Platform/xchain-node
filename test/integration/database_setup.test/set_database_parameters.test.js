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

const { expect } = require('chai')

const { DB_MODULE_NAME } = require('../../../src/config')
const { databaseSuite } = require('./support/fixture')

databaseSuite('setDatabaseParameters', function (fixture) {

    it('creates users for all installed decoders and indexers', async function () {
        const { env, capture, fakeContainerId, makeDatabaseService } = fixture()
        const dbContainerId = fakeContainerId('d')
        const decoderId = fakeContainerId('e')
        const indexerId = fakeContainerId('i')

        await env.insertModule(DB_MODULE_NAME, '', '', dbContainerId)
        await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', decoderId)
        await env.insertModule('xchain-indexer', 'bitcoin', 'mainnet', indexerId)

        env.writeConfigFile('bitcoin-mainnet', '')

        // containerExists: setDatabaseParameters (DatabaseService.js
        // ~L664) resolves the database container up front via
        // getDatabaseContainerId() before provisioning any account.
        const { DatabaseService } = makeDatabaseService({
            dbContainerId,
            installedCoins: { bitcoin: ['mainnet'] },
            containerExists: true
        })

        await DatabaseService.setDatabaseParameters()

        const createUserCmds = capture.findCommands(/CREATE USER/)
        const userNames = createUserCmds.map(c => c.command)

        const hasDecoderUser = userNames.some(cmd => cmd.includes('xchain_decoder_bitcoin_mainnet'))
        expect(hasDecoderUser).to.be.true

        const hasIndexerUser = userNames.some(cmd => cmd.includes('xchain_indexer_bitcoin_mainnet'))
        expect(hasIndexerUser).to.be.true
    })
})
