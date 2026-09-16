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

dockerSuite('xchain-utxo-tracker Docker run command', function (fixture) {

    it('includes data volume, bootstrap volume, and ulimit', async function () {
        const { env, capture, makeBuildAndUp } = fixture()
        env.writeConfigFile('bitcoin-mainnet', '')
        env.createFakeModule('xchain-utxo-tracker')

        const { ModuleService } = makeBuildAndUp()
        await ModuleService.buildAndUp('xchain-utxo-tracker', 'bitcoin', 'mainnet', null, true)

        const runCmd = capture.findCommands(/docker run/)[0].command

        // Data volume
        expect(runCmd).to.include('-v xchain-utxo-tracker-bitcoin-mainnet-data:/data/xchain-utxo-tracker')
        // Bootstrap volume
        expect(runCmd).to.include(':/bootstrap/xchain-utxo-tracker')
        expect(runCmd).to.include('--ulimit nofile=2048:2048')
        // Port
        expect(runCmd).to.include('-p 3001:3001')
        expect(runCmd).to.include('--network xchain-node-bitcoin-mainnet')
    })
})
