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
const filters = require('../../../src/services/config_service/filters')

const Coin = { BITCOIN: 'bitcoin', LITECOIN: 'litecoin' }
const Network = { MAINNET: 'mainnet', REGTEST: 'regtest' }
const XChainService = {
    XCHAIN_INDEXER: 'xchain-indexer',
    XCHAIN_ENCODER: 'xchain-encoder',
    XCHAIN_E2E_TEST: 'xchain-e2e-test'
}

describe('config_service/filters', function () {
    beforeEach(function () {
        filters.configure({
            Coin,
            Network,
            XChainService,
            REGTEST_MODULES: ['regtest-miner'],
            NODE_MODULE_NAME: 'node',
            DB_MODULE_NAME: 'database',
            HUB_MODULE_NAME: 'xchain-hub',
            EXPLORER_MODULE_NAME: 'xchain-explorer',
            SYNC_MODULE_NAME: 'xchain-sync'
        })
    })

    it('returns aliases for shared services', function () {
        expect(filters.serviceAliases()).to.deep.equal({
            hub: 'xchain-hub',
            sync: 'xchain-sync',
            db: 'database'
        })
    })

    it('resolves a shared-service alias under the empty coin and network key', function () {
        expect(filters.filterCommandParameters('unused', 'hub', 'bitcoin', 'mainnet')).to.deep.equal({
            '': { '': ['xchain-hub'] }
        })
    })

    it('expands all with the node first, omits e2e-test, and adds the explorer once', function () {
        const result = filters.filterCommandParameters('unused', 'all', 'bitcoin', 'mainnet')
        expect(result).to.deep.equal({
            '': { '': ['xchain-explorer'] },
            bitcoin: { mainnet: ['node', 'xchain-indexer', 'xchain-encoder'] }
        })
    })

    it('limits regtest-only modules to regtest while retaining every requested network', function () {
        const result = filters.filterCommandParameters('unused', 'regtest-miner', 'bitcoin', 'all')
        expect(result).to.deep.equal({
            bitcoin: { mainnet: [], regtest: ['regtest-miner'] }
        })
    })

    it('expands an unspecified module across every coin and network', function () {
        const result = filters.filterCommandParameters('unused', 'custom-service')
        expect(result).to.deep.equal({
            bitcoin: { mainnet: ['custom-service'], regtest: ['custom-service'] },
            litecoin: { mainnet: ['custom-service'], regtest: ['custom-service'] }
        })
    })
})
