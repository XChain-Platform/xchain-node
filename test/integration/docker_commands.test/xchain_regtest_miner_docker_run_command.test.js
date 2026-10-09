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

dockerSuite('xchain-regtest-miner Docker run command', function (fixture) {

    it('includes regtest miner port on regtest network', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.writeConfigFile('bitcoin-regtest', '')
        env.createFakeModule('xchain-regtest-miner')

        const { ModuleService } = makeBuildAndUp()
        await ModuleService.buildAndUp('xchain-regtest-miner', 'bitcoin', 'regtest', null, true)

        const runEntry = capture.findCommands(/docker run/)[0]
        const runCmd = runEntry.command

        expect(runCmd).to.include('--env NODE_PORT')
        expect(runCmd).to.include('--env NETWORK')
        expect(runCmd).to.not.include('NODE_PORT=18444')
        expect(runCmd).to.not.include('NETWORK=bitcoin-regtest')
        expect(runEntry.options.env.NODE_PORT).to.equal('18444')
        expect(runEntry.options.env.NETWORK).to.equal('bitcoin-regtest')
        expect(runCmd).to.include('-p 3005:3005')
        expect(runCmd).to.include('--network xchain-node-bitcoin-regtest')
    })

    // The miner takes its coin from the NETWORK prefix; a bare value runs LTC and DOGE with bitcoin fee and dust rules.
    for (const coin of ['litecoin', 'dogecoin']) {
        it('names the coin in NETWORK for a ' + coin + ' regtest miner', async function () {
            const { env, capture, makeBuildAndUp } = fixture()
            env.writeConfigFile(coin + '-regtest', '')
            env.createFakeModule('xchain-regtest-miner')

            const { ModuleService } = makeBuildAndUp()
            await ModuleService.buildAndUp('xchain-regtest-miner', coin, 'regtest', null, true)

            const runEntry = capture.findCommands(/docker run/)[0]
            expect(runEntry.options.env.NETWORK).to.equal(coin + '-regtest')
        })
    }
})
