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
const { dockerSuite } = require('./support/fixture')

dockerSuite('xchain-indexer Docker run command', function (fixture) {

    it('includes indexer DB env vars and correct port', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.writeConfigFile('bitcoin-mainnet', '')
        env.createFakeModule('xchain-indexer')

        const { ModuleService } = makeBuildAndUp()
        await ModuleService.buildAndUp('xchain-indexer', 'bitcoin', 'mainnet', null, true)

        const runEntry = capture.findCommands(/docker run/)[0]
        const runCmd = runEntry.command
        const runEnv = runEntry.options.env

        expect(runCmd).to.include('--env INDEXER_DB_NAME')
        expect(runCmd).to.include('--env INDEXER_DB_USER')
        expect(runCmd).to.include('--env INDEXER_DB_HOST')
        expect(runCmd).to.include('--env INDEXER_COIN')
        expect(runCmd).to.include('--env INDEXER_NETWORK')
        expect(runCmd).to.not.include('INDEXER_DB_NAME=XChain_BTC_Mainnet_Indexer')
        expect(runCmd).to.not.include('INDEXER_DB_USER=xchain_indexer_bitcoin_mainnet')
        expect(runCmd).to.not.include('INDEXER_DB_HOST=mariadb')
        expect(runCmd).to.not.include('INDEXER_COIN=BTC')
        expect(runCmd).to.not.include('INDEXER_NETWORK=mainnet')
        expect(runEnv.INDEXER_DB_NAME).to.equal('XChain_BTC_Mainnet_Indexer')
        expect(runEnv.INDEXER_DB_USER).to.equal('xchain_indexer_bitcoin_mainnet')
        expect(runEnv.INDEXER_DB_HOST).to.equal('mariadb')
        expect(runEnv.INDEXER_COIN).to.equal('BTC')
        expect(runEnv.INDEXER_NETWORK).to.equal('mainnet')
        expect(runCmd).to.include('-p 3004:3004')
    })
})
