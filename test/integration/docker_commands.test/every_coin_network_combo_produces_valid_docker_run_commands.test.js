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

const { Coin, Network, CoinTickerSymbol } = require('../../../src/config')
const { dockerSuite } = require('./support/fixture')

dockerSuite('every coin/network combo produces valid Docker run commands', function (fixture) {
    for (const coin of Object.values(Coin)) {
        for (const network of Object.values(Network)) {

            it(`xchain-encoder on ${coin}/${network}`, async function () {
                const { env, capture, makeBuildAndUp } = fixture()
                env.writeConfigFile(`${coin}-${network}`, '')
                env.createFakeModule('xchain-encoder')

                const { ModuleService } = makeBuildAndUp()
                await ModuleService.buildAndUp('xchain-encoder', coin, network, null, true)

                const runEntry = capture.findCommands(/docker run/)[0]
                const runCmd = runEntry.command
                const runEnv = runEntry.options.env

                expect(runCmd).to.include(`--hostname xchain-node-${coin}-${network}-xchain-encoder`)
                expect(runCmd).to.include(`--network xchain-node-${coin}-${network}`)
                expect(runCmd).to.include('--env NETWORK')
                expect(runCmd).to.include('--env INDEXER_COIN')
                // NETWORK is coin-prefixed for the encoder (d7a4a4f, predates
                // the argv fix); see the dedicated encoder test above.
                expect(runCmd).to.not.include(`NETWORK=${coin}-${network}`)
                expect(runCmd).to.not.include(`INDEXER_COIN=${CoinTickerSymbol[coin]}`)
                expect(runEnv.NETWORK).to.equal(`${coin}-${network}`)
                expect(runEnv.INDEXER_COIN).to.equal(CoinTickerSymbol[coin])

                if (network === 'regtest') {
                    expect(runCmd).to.include('--env REGTEST_MINER_API_PORT')
                    expect(runCmd).to.not.include('REGTEST_MINER_API_PORT=3005')
                    expect(runEnv.REGTEST_MINER_API_PORT).to.equal('3005')
                }
            })
        }
    }
})
