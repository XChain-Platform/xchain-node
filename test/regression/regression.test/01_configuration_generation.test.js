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

const sinon      = require('sinon')
const { expect } = require('chai')

const { DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, Coin, Network, CoinTickerSymbol } = require('../../../src/config')

const { filterCommandParameters } = require('../../../src/services/config_service')
const { makeServiceWithConfig } = require('./support/helpers')

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p0] Configuration Generation', function () {

        const expectedPorts = { mainnet: 8332, testnet: 18332, regtest: 18444 }

        it('R-CFG-001: getDefaultConfig returns correct ports for each coin/network combo', async function () {
            for (const coin of Object.values(Coin)) {
                for (const network of Object.values(Network)) {
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig('xchain-encoder', coin, network)
                    expect(config['NODE_PORT'], `${coin}/${network} NODE_PORT`).to.equal(expectedPorts[network])
                }
            }
        })

        it('R-CFG-002: config file overrides merge correctly over defaults', async function () {
            const cs = makeServiceWithConfig('UTXO_TRACKER_PORT=9999\nENCODER_API_PORT=4003\n')
            const config = await cs.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            // Overridden (string from config file)
            expect(config['UTXO_TRACKER_PORT']).to.equal('9999')
            expect(config['ENCODER_API_PORT']).to.equal('4003')
            // Non-overridden defaults preserved
            expect(config['DECODER_API_PORT']).to.equal(3002)
            expect(config['NODE_PORT']).to.equal(8332)
        })

        it('R-CFG-003: Docker image names follow prefix-coin-network-module pattern', function () {
            const { getDockerContainerImageName } = require('../../../src/services/config_service')
            for (const coin of Object.values(Coin)) {
                for (const network of Object.values(Network)) {
                    const name = getDockerContainerImageName('xchain-encoder', coin, network)
                    expect(name).to.equal(`xchain-node-${coin}-${network}-xchain-encoder`)
                }
            }
        })

        it('R-CFG-003b: shared modules omit coin/network from image name', function () {
            const { getDockerContainerImageName } = require('../../../src/services/config_service')
            expect(getDockerContainerImageName(HUB_MODULE_NAME, '', '')).to.equal('xchain-node-xchain-hub')
            expect(getDockerContainerImageName(DB_MODULE_NAME, 'bitcoin', 'mainnet')).to.equal('xchain-node-database')
            expect(getDockerContainerImageName(EXPLORER_MODULE_NAME, '', '')).to.equal('xchain-node-xchain-explorer')
        })

        it('R-CFG-004: Docker network names follow prefix-coin-network pattern', function () {
            const { getDockerNetwork } = require('../../../src/services/config_service')
            expect(getDockerNetwork('bitcoin', 'mainnet')).to.equal('xchain-node-bitcoin-mainnet')
            expect(getDockerNetwork('dogecoin', 'regtest')).to.equal('xchain-node-dogecoin-regtest')
            expect(getDockerNetwork('', '')).to.equal('xchain-node')
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p0] Configuration Generation', function () {

        it('R-CFG-005: database names follow XChain_TICKER_Network_Module pattern', function () {
            const { getModuleDatabaseName } = require('../../../src/services/config_service')
            expect(getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet')).to.equal('XChain_BTC_Mainnet_Decoder')
            expect(getModuleDatabaseName('xchain-indexer', 'dogecoin', 'testnet')).to.equal('XChain_DOGE_Testnet_Indexer')
            expect(getModuleDatabaseName('xchain-decoder', 'litecoin', 'regtest')).to.equal('XChain_LTC_Regtest_Decoder')
        })

        it('R-CFG-006: all 9 coin/network combos produce correct ticker and DB user', async function () {
            for (const coin of Object.values(Coin)) {
                for (const network of Object.values(Network)) {
                    const cs = makeServiceWithConfig('')
                    const config = await cs.getDefaultConfig('xchain-decoder', coin, network)
                    expect(config['INDEXER_COIN'], `${coin}/${network} ticker`).to.equal(CoinTickerSymbol[coin])
                    expect(config['DECODER_DB_USER'], `${coin}/${network} DB user`).to.equal(`xchain_decoder_${coin}_${network}`)
                    expect(config['DECODER_DB_HOST']).to.equal('mariadb')
                    expect(config['DECODER_DB_PORT']).to.equal(3306)
                }
            }
        })

        it('R-CFG-007: regtest config includes REGTEST_MINER_URL, mainnet/testnet do not', async function () {
            const csRegtest = makeServiceWithConfig('')
            const regConf = await csRegtest.getDefaultConfig('xchain-encoder', 'bitcoin', 'regtest')
            expect(regConf['REGTEST_MINER_URL']).to.exist
            expect(regConf['REGTEST_MINER_API_PORT']).to.equal(3005)

            const csMainnet = makeServiceWithConfig('')
            const mainConf = await csMainnet.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')
            expect(mainConf['REGTEST_MINER_URL']).to.be.undefined

            const csTestnet = makeServiceWithConfig('')
            const testConf = await csTestnet.getDefaultConfig('xchain-encoder', 'bitcoin', 'testnet')
            expect(testConf['REGTEST_MINER_URL']).to.be.undefined
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p0] Configuration Generation', function () {

        it('R-CFG-008: shared service config (null coin/network) has correct keys', async function () {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(HUB_MODULE_NAME, null, null)
            expect(config['HUB_PORT']).to.equal(10000)
            expect(config['NODE_PORT']).to.be.undefined
            expect(config['DECODER_DB_NAME']).to.be.undefined
        })

        it('R-CFG-009: filterCommandParameters all/all/all expands fully', function () {
            const result = filterCommandParameters(null, 'all', 'all', 'all')
            for (const coin of Object.values(Coin)) {
                expect(result).to.have.property(coin)
                for (const network of Object.values(Network)) {
                    expect(result[coin]).to.have.property(network)
                    expect(result[coin][network]).to.include('xchain-encoder')
                    expect(result[coin][network]).to.include('xchain-decoder')
                    expect(result[coin][network]).to.include('xchain-utxo-tracker')
                    expect(result[coin][network]).to.include('xchain-indexer')
                    expect(result[coin][network]).to.include('node')
                }
            }
            // Explorer as shared service
            expect(result['']).to.exist
            expect(result['']['']).to.include('xchain-explorer')
        })
    })
})
