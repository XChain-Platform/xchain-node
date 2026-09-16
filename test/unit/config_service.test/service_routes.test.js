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
    sinon, configStub, expect, proxyquire, path,
    NODE_PREFIX, SEP, DB_SEP, NODE_MODULE_NAME, DB_MODULE_NAME,
    HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, Coin, Network,
    XChainService, CoinTickerSymbol, REGTEST_MODULES, moduleDir, tmpDir,
    cryptoNodesDir, dataDir, configDir, NO_VALIDATOR, makeConfigService,
    streamFromString, makeServiceWithConfig, makeMemoryConfigService, CONTAINER_ID, coinSidecar,
    coinMain, hubSidecar
} = require('./helpers.test')

function serviceRoutes1() {
    it('returns correct INDEXER_COIN ticker', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
        expect(config['INDEXER_COIN']).to.equal('BTC')
    })

    it('returns correct INDEXER_COIN for dogecoin', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', 'mainnet')
        expect(config['INDEXER_COIN']).to.equal('DOGE')
    })

    it('returns HUB_PORT as 10000', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['HUB_PORT']).to.equal(10000)
    })

    // The indexer's hub client is enabled purely by HUB_API_URL
    // (hub_client.js `this.enabled = !!this.hubUrl`). HUB_API_HOST is set here
    // but read by nothing in xchain-indexer, so while HUB_API_URL was unset the
    // client stayed disabled on every installed stack and no push ever left the
    // indexer, including the PRICE v1 oracle_price pushes a FIAT dispenser later
    // prices against.
    it('sets HUB_API_URL so the indexer hub client is enabled', async function () {
        const cs = makeServiceWithConfig('')
        for (const network of ['regtest', 'testnet', 'mainnet']) {
            const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', network)
            expect(config['HUB_API_URL'], network).to.be.a('string')
            expect(config['HUB_API_URL'], network).to.match(/^http:\/\/.+:10000$/)
        }
    })

    it('points HUB_API_URL at the same hub container HUB_API_HOST names', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'bitcoin', 'regtest')
        expect(config['HUB_API_URL']).to.equal(
            'http://' + config['HUB_API_HOST'] + ':' + config['HUB_PORT'])
    })

    it('includes REGTEST_MINER_URL for regtest network', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'regtest')
        expect(config['REGTEST_MINER_URL']).to.exist
        expect(config['REGTEST_MINER_API_PORT']).to.equal(3005)
    })

    it('does not include REGTEST_MINER_URL for mainnet', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['REGTEST_MINER_URL']).to.be.undefined
    })
}

function serviceRoutes2() {
    it('does not include REGTEST_MINER_URL for testnet', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'testnet')
        expect(config['REGTEST_MINER_URL']).to.be.undefined
    })

    it('config file values override defaults', async function () {
        const cs = makeServiceWithConfig('UTXO_TRACKER_PORT=9999\n')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['UTXO_TRACKER_PORT']).to.equal('9999')
    })

    it('default values used when config file is empty', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
        expect(config['UTXO_TRACKER_API_PORT']).to.equal(3001)
        expect(config['DECODER_API_PORT']).to.equal(3002)
        expect(config['ENCODER_API_PORT']).to.equal(3003)
        expect(config['INDEXER_API_PORT']).to.equal(3004)
    })

    it('returns correct DECODER_DB_USER format', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        expect(config['DECODER_DB_USER']).to.equal('xchain_decoder_bitcoin_mainnet')
    })

    it('returns correct INDEXER_DB_USER format', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', 'testnet')
        expect(config['INDEXER_DB_USER']).to.equal('xchain_indexer_dogecoin_testnet')
    })

    it('returns DECODER_DB_HOST as mariadb', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        expect(config['DECODER_DB_HOST']).to.equal('mariadb')
    })

    it('returns DECODER_DB_PORT as 3306', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        expect(config['DECODER_DB_PORT']).to.equal(3306)
    })
}

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', serviceRoutes1)
    })
})

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('with coin and network (coin-specific config)', serviceRoutes2)
    })
})
