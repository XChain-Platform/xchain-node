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

const {
    sinon, expect, HUB_MODULE_NAME, XChainService, makeServiceWithConfig
} = require('./helpers.test')
const stateModule = require('../../../src/state')

const INDEXER_ENV = ['HUB_NETWORK', 'LTC_INDEXER_URL', 'DOGE_INDEXER_URL']

describe('ConfigService colocated hub indexer URLs', function () {
    let savedEnv

    beforeEach(function () {
        savedEnv = Object.fromEntries(INDEXER_ENV.map(name => [name, process.env[name]]))
        process.env.HUB_NETWORK = 'mainnet'
        process.env.LTC_INDEXER_URL = 'http://127.0.1.1:3004'
        process.env.DOGE_INDEXER_URL = 'http://127.0.1.1:3004'
    })

    afterEach(function () {
        sinon.restore()
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    })

    it('uses Docker DNS for LTC and DOGE indexers registered on the hub box', async function () {
        sinon.stub(stateModule.db, 'getAllModuleContainers').resolves([
            { coin: 'litecoin', network: 'mainnet', module: XChainService.XCHAIN_INDEXER },
            { coin: 'dogecoin', network: 'mainnet', module: XChainService.XCHAIN_INDEXER }
        ])

        const config = await makeServiceWithConfig('').getDefaultConfig(HUB_MODULE_NAME, null, null)

        expect(config.LTC_INDEXER_URL)
            .to.equal('http://xchain-node-litecoin-mainnet-xchain-indexer:3004')
        expect(config.DOGE_INDEXER_URL)
            .to.equal('http://xchain-node-dogecoin-mainnet-xchain-indexer:3004')
    })

    it('preserves configured URLs for indexers not registered on the hub box', async function () {
        sinon.stub(stateModule.db, 'getAllModuleContainers').resolves([])

        const config = await makeServiceWithConfig('').getDefaultConfig(HUB_MODULE_NAME, null, null)

        expect(config.LTC_INDEXER_URL).to.equal('http://127.0.1.1:3004')
        expect(config.DOGE_INDEXER_URL).to.equal('http://127.0.1.1:3004')
    })
})
