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
const naming = require('../../../../src/services/config_service/naming')
const config = require('../../../../src/config')
const { scopedNodePrefixSegment } = require('../../../../src/utils/module_database_name')

function configure(overrides = {}) {
    naming.configure({
        NODE_PREFIX: 'xchain-node',
        DEFAULT_NODE_PREFIX: 'xchain-node',
        SEP: '-',
        DB_SEP: '_',
        DB_MODULE_NAME: 'database',
        HUB_MODULE_NAME: 'xchain-hub',
        EXPLORER_MODULE_NAME: 'xchain-explorer',
        SYNC_MODULE_NAME: 'xchain-sync',
        CoinTickerSymbol: { bitcoin: 'BTC', dogecoin: 'DOGE' },
        Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' },
        XChainService: { XCHAIN_UTXO_TRACKER: 'xchain-utxo-tracker' },
        scopedNodePrefixSegment,
        ...overrides
    })
}

describe('config_service/naming', function () {
    after(function () {
        naming.configure({
            NODE_PREFIX: config.NODE_PREFIX,
            DEFAULT_NODE_PREFIX: config.DEFAULT_NODE_PREFIX,
            SEP: config.SEP,
            DB_SEP: config.DB_SEP,
            DB_MODULE_NAME: config.DB_MODULE_NAME,
            HUB_MODULE_NAME: config.HUB_MODULE_NAME,
            EXPLORER_MODULE_NAME: config.EXPLORER_MODULE_NAME,
            SYNC_MODULE_NAME: config.SYNC_MODULE_NAME,
            CoinTickerSymbol: config.CoinTickerSymbol,
            Network: config.Network,
            XChainService: config.XChainService,
            scopedNodePrefixSegment
        })
    })

    it('uses a shared prefix for shared images and a scoped prefix for coin images', function () {
        configure()

        expect(naming.getDockerContainerImageNamePrefix('database', 'bitcoin', 'mainnet'))
            .to.equal('xchain-node')
        expect(naming.getDockerContainerImageNamePrefix('xchain-decoder', 'bitcoin', 'mainnet'))
            .to.equal('xchain-node-bitcoin-mainnet')
        expect(naming.getDockerContainerImageName('xchain-decoder', 'bitcoin', 'mainnet'))
            .to.equal('xchain-node-bitcoin-mainnet-xchain-decoder')
    })

    it('keeps the default tracker volume name and scopes non-default stacks', function () {
        configure()
        expect(naming.getUtxoTrackerVolumeName('bitcoin', 'mainnet'))
            .to.equal('xchain-utxo-tracker-bitcoin-mainnet-data')

        configure({ NODE_PREFIX: 'xchain-blue' })
        expect(naming.getUtxoTrackerVolumeName('bitcoin', 'mainnet'))
            .to.equal('xchain-blue-xchain-utxo-tracker-bitcoin-mainnet-data')
    })

    it('builds Docker networks with optional coin and network segments', function () {
        configure()

        expect(naming.getDockerNetwork('', '')).to.equal('xchain-node')
        expect(naming.getDockerNetwork('bitcoin', '')).to.equal('xchain-node-bitcoin')
        expect(naming.getDockerNetwork('bitcoin', 'mainnet')).to.equal('xchain-node-bitcoin-mainnet')
    })

    it('builds database names and scopes them for non-default stacks', function () {
        configure()
        expect(naming.getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet'))
            .to.equal('XChain_BTC_Mainnet_Decoder')

        configure({ NODE_PREFIX: 'xchain-blue' })
        expect(naming.getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet'))
            .to.equal('XChain_' + scopedNodePrefixSegment('xchain-blue', 'xchain-node', '_') + 'BTC_Mainnet_Decoder')
    })

    it('rejects unknown coins and networks', function () {
        configure()

        expect(() => naming.getModuleDatabaseName('xchain-decoder', 'unknown', 'mainnet'))
            .to.throw("Unknown coin 'unknown'")
        expect(() => naming.getModuleDatabaseName('xchain-decoder', 'bitcoin', 'unknown'))
            .to.throw("Unknown network 'unknown'")
    })

    it('scopes module database users only for non-default stacks', function () {
        const defaults = { DECODER_DB_USER: 'decoder', INDEXER_DB_USER: 'indexer' }
        configure()
        naming.applyPrefixedModuleDbUsers(defaults, 'bitcoin', 'mainnet')
        expect(defaults).to.deep.equal({ DECODER_DB_USER: 'decoder', INDEXER_DB_USER: 'indexer' })

        configure({ NODE_PREFIX: 'xchain-blue' })
        naming.applyPrefixedModuleDbUsers(defaults, 'bitcoin', 'mainnet')
        const segment = scopedNodePrefixSegment('xchain-blue', 'xchain-node', '_')
        expect(defaults).to.deep.equal({
            DECODER_DB_USER: 'xchain_' + segment + 'decoder_bitcoin_mainnet',
            INDEXER_DB_USER: 'xchain_' + segment + 'indexer_bitcoin_mainnet'
        })
    })
})
