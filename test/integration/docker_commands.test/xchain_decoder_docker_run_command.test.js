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

dockerSuite('xchain-decoder Docker run command', function (fixture) {

    it('includes database env vars and bootstrap volume', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.writeConfigFile('bitcoin-mainnet', '')
        env.createFakeModule('xchain-decoder')

        const { ModuleService } = makeBuildAndUp()
        await ModuleService.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet', null, true)

        const runEntry = capture.findCommands(/docker run/)[0]
        const runCmd = runEntry.command
        const runEnv = runEntry.options.env

        // DECODER_DB_PASS is a live secret; the other three are non-secret
        // config that now rides the same bare-`--env NAME` mechanism. All
        // four must be present by name and absent by value from argv.
        expect(runCmd).to.include('--env DECODER_DB_NAME')
        expect(runCmd).to.include('--env DECODER_DB_HOST')
        expect(runCmd).to.include('--env DECODER_DB_USER')
        expect(runCmd).to.include('--env DECODER_DB_PASS')
        expect(runCmd).to.not.include('DECODER_DB_NAME=XChain_BTC_Mainnet_Decoder')
        expect(runCmd).to.not.include('DECODER_DB_HOST=mariadb')
        expect(runCmd).to.not.include('DECODER_DB_USER=xchain_decoder_bitcoin_mainnet')
        expect(runCmd).to.not.include('DECODER_DB_PASS=xchain-password')
        expect(runEnv.DECODER_DB_NAME).to.equal('XChain_BTC_Mainnet_Decoder')
        expect(runEnv.DECODER_DB_HOST).to.equal('mariadb')
        expect(runEnv.DECODER_DB_USER).to.equal('xchain_decoder_bitcoin_mainnet')
        expect(runEnv.DECODER_DB_PASS).to.equal('xchain-password')
        expect(runCmd).to.include('-p 3002:3002')

        // Bootstrap volume mount
        expect(runCmd).to.include('-v ')
        expect(runCmd).to.include(':/bootstrap/xchain-decoder')
    })
})

dockerSuite('xchain-decoder Docker run command', function (fixture) {

    it('dogecoin/testnet gets correct DB names', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.writeConfigFile('dogecoin-testnet', '')
        env.createFakeModule('xchain-decoder')

        const { ModuleService } = makeBuildAndUp()
        await ModuleService.buildAndUp('xchain-decoder', 'dogecoin', 'testnet', null, true)

        const runEntry = capture.findCommands(/docker run/)[0]
        const runCmd = runEntry.command
        expect(runCmd).to.include('--env DECODER_DB_NAME')
        expect(runCmd).to.include('--env DECODER_DB_USER')
        expect(runCmd).to.not.include('DECODER_DB_NAME=XChain_DOGE_Testnet_Decoder')
        expect(runCmd).to.not.include('DECODER_DB_USER=xchain_decoder_dogecoin_testnet')
        expect(runEntry.options.env.DECODER_DB_NAME).to.equal('XChain_DOGE_Testnet_Decoder')
        expect(runEntry.options.env.DECODER_DB_USER).to.equal('xchain_decoder_dogecoin_testnet')
        expect(runCmd).to.include('--network xchain-node-dogecoin-testnet')
    })
})
