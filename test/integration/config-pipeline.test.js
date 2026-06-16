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
const proxyquire = require('proxyquire').noCallThru()
const path       = require('path')
const { Readable } = require('stream')

const {
    NODE_PREFIX, SEP, DB_SEP,
    Coin, Network, XChainService, CoinTickerSymbol, REGTEST_MODULES,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME
} = require('../../src/config/constants')

const TestEnv = require('./helpers/test-env')

describe('Integration: Config Pipeline', function () {
    this.timeout(15000)

    let env, ConfigService

    beforeEach(async function () {
        env = new TestEnv()
        await env.setup()

        // Proxyquire ConfigService with overridden constants so configDir/moduleDir
        // point to our temp directories. This is necessary because ConfigService
        // destructures constants at require-time.
        const patchedConstants = Object.assign({}, require('../../src/config/constants'), {
            configDir: env.configDir,
            moduleDir: env.moduleDir,
            dataDir: env.dataDir
        })

        ConfigService = proxyquire('../../src/services/ConfigService', {
            '../config/constants': patchedConstants
        })
    })

    afterEach(async function () {
        await env.teardown()
    })

    // ---------------------------------------------------------------
    // filterCommandParameters -> getDefaultConfig integration
    // ---------------------------------------------------------------

    describe('CLI params -> filterCommandParameters -> getDefaultConfig', function () {

        it('single encoder on bitcoin/mainnet produces correct full config', async function () {
            env.writeConfigFile('bitcoin-mainnet', '')

            const serviceList = ConfigService.filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'mainnet')
            expect(serviceList['bitcoin']['mainnet']).to.deep.equal(['xchain-encoder'])

            const config = await ConfigService.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            expect(config['NETWORK']).to.equal('mainnet')
            expect(config['NODE_PORT']).to.equal(8332)
            expect(config['NODE_URL']).to.equal('node')
            expect(config['ENCODER_API_PORT']).to.equal(3003)
            expect(config['DECODER_API_PORT']).to.equal(3002)
            expect(config['UTXO_TRACKER_API_PORT']).to.equal(3001)
            expect(config['HUB_PORT']).to.equal(10000)
            expect(config['INDEXER_COIN']).to.equal('BTC')
        })

        it('decoder on dogecoin/testnet gets correct DB names and ports', async function () {
            env.writeConfigFile('dogecoin-testnet', '')

            const serviceList = ConfigService.filterCommandParameters(null, 'xchain-decoder', 'dogecoin', 'testnet')
            const modules = serviceList['dogecoin']['testnet']
            expect(modules).to.deep.equal(['xchain-decoder'])

            const config = await ConfigService.getDefaultConfig('xchain-decoder', 'dogecoin', 'testnet')

            expect(config['NODE_PORT']).to.equal(18332)
            expect(config['DECODER_DB_NAME']).to.equal('XChain_DOGE_Testnet_Decoder')
            expect(config['DECODER_DB_USER']).to.equal('xchain_decoder_dogecoin_testnet')
            expect(config['DECODER_DB_HOST']).to.equal('mariadb')
            expect(config['DECODER_DB_PORT']).to.equal(3306)
            expect(config['INDEXER_COIN']).to.equal('DOGE')
        })

        it('indexer on litecoin/regtest gets regtest port and regtest miner config', async function () {
            env.writeConfigFile('litecoin-regtest', '')

            const config = await ConfigService.getDefaultConfig('xchain-indexer', 'litecoin', 'regtest')

            expect(config['NODE_PORT']).to.equal(18444)
            expect(config['INDEXER_DB_NAME']).to.equal('XChain_LTC_Regtest_Indexer')
            expect(config['INDEXER_DB_USER']).to.equal('xchain_indexer_litecoin_regtest')
            expect(config['REGTEST_MINER_URL']).to.exist
            expect(config['REGTEST_MINER_API_PORT']).to.equal(3005)
        })

        it('"all" expansion produces configs for every valid coin/network combo', function () {
            const serviceList = ConfigService.filterCommandParameters(null, 'all', 'all', 'all')

            for (const coin of Object.values(Coin)) {
                expect(serviceList).to.have.property(coin)
                for (const network of Object.values(Network)) {
                    expect(serviceList[coin]).to.have.property(network)
                    const modules = serviceList[coin][network]

                    // Core modules always present
                    expect(modules).to.include('xchain-encoder')
                    expect(modules).to.include('xchain-decoder')
                    expect(modules).to.include('xchain-utxo-tracker')
                    expect(modules).to.include('xchain-indexer')
                    expect(modules).to.include('node')

                    // Regtest-only filtering (e2e-test excluded from "all" expansion)
                    if (network === 'regtest') {
                        expect(modules).to.include('xchain-regtest-miner')
                    } else {
                        expect(modules).to.not.include('xchain-regtest-miner')
                    }
                    expect(modules).to.not.include('xchain-e2e-test')
                }
            }

            // Explorer is added as shared service
            expect(serviceList['']).to.exist
            expect(serviceList['']['']).to.include('xchain-explorer')
        })

        it('"all" on mainnet does not include regtest modules', function () {
            const serviceList = ConfigService.filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
            const modules = serviceList['bitcoin']['mainnet']
            expect(modules).to.not.include('xchain-regtest-miner')
            expect(modules).to.not.include('xchain-e2e-test')
        })

        it('"all" on regtest includes regtest-miner but not e2e-test', function () {
            const serviceList = ConfigService.filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
            const modules = serviceList['bitcoin']['regtest']
            expect(modules).to.include('xchain-regtest-miner')
            expect(modules).to.not.include('xchain-e2e-test')
        })
    })

    // ---------------------------------------------------------------
    // Config file overrides
    // ---------------------------------------------------------------

    describe('config file override propagation', function () {

        it('config file values override defaults', async function () {
            env.writeConfigFile('bitcoin-mainnet', 'ENCODER_API_PORT=4003\nUTXO_TRACKER_PORT=9001\n')

            const config = await ConfigService.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            // Overridden values (config file values are strings)
            expect(config['ENCODER_API_PORT']).to.equal('4003')
            expect(config['UTXO_TRACKER_PORT']).to.equal('9001')

            // Non-overridden defaults preserved
            expect(config['DECODER_API_PORT']).to.equal(3002)
            expect(config['NODE_PORT']).to.equal(8332)
        })

        it('missing config file falls back to defaults only (shared module)', async function () {
            const config = await ConfigService.getDefaultConfig(HUB_MODULE_NAME, null, null)

            expect(config['HUB_PORT']).to.equal(10000)
            expect(config['EXPLORER_PORT']).to.exist
            expect(config['NODE_PORT']).to.be.undefined
        })

        it('empty config file uses all defaults', async function () {
            env.writeConfigFile('bitcoin-mainnet', '')

            const config = await ConfigService.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            expect(config['NODE_PORT']).to.equal(8332)
            expect(config['ENCODER_API_PORT']).to.equal(3003)
            expect(config['DECODER_API_PORT']).to.equal(3002)
            expect(config['UTXO_TRACKER_API_PORT']).to.equal(3001)
            expect(config['INDEXER_API_PORT']).to.equal(3004)
        })

        it('multiple overrides in config file all take effect', async function () {
            env.writeConfigFile('bitcoin-mainnet',
                'NODE_EXPOSED_PORT=18333\nDUST_AMOUNT=600\nENCODER_PORT=4003\n')

            const config = await ConfigService.getDefaultConfig('xchain-encoder', 'bitcoin', 'mainnet')

            expect(config['NODE_EXPOSED_PORT']).to.equal('18333')
            expect(config['DUST_AMOUNT']).to.equal('600')
            expect(config['ENCODER_PORT']).to.equal('4003')
        })
    })

    // ---------------------------------------------------------------
    // Config values per coin/network combination
    // ---------------------------------------------------------------

    describe('config correctness across all coin/network combos', function () {

        const expectedPorts = {
            mainnet: 8332,
            testnet: 18332,
            regtest: 18444
        }

        for (const coin of Object.values(Coin)) {
            for (const network of Object.values(Network)) {
                it(`${coin}/${network}: NODE_PORT, INDEXER_COIN, DB names correct`, async function () {
                    env.writeConfigFile(`${coin}-${network}`, '')

                    const config = await ConfigService.getDefaultConfig('xchain-decoder', coin, network)

                    expect(config['NODE_PORT']).to.equal(expectedPorts[network])
                    expect(config['INDEXER_COIN']).to.equal(CoinTickerSymbol[coin])
                    expect(config['NETWORK']).to.equal(network)

                    // UTXO tracker URL includes coin/network
                    const expectedUtxoUrl = ConfigService.getDockerContainerImageName(XChainService.XCHAIN_UTXO_TRACKER, coin, network)
                    expect(config['UTXO_TRACKER_URL']).to.equal(expectedUtxoUrl)

                    // Decoder DB name follows pattern
                    const ticker = CoinTickerSymbol[coin]
                    const netCap = network.charAt(0).toUpperCase() + network.slice(1)
                    expect(config['DECODER_DB_NAME']).to.equal(`XChain_${ticker}_${netCap}_Decoder`)
                })
            }
        }
    })

    // ---------------------------------------------------------------
    // Docker image naming consistency
    // ---------------------------------------------------------------

    describe('Docker image naming', function () {

        it('coin-specific modules include coin and network in image name', function () {
            const name = ConfigService.getDockerContainerImageName('xchain-encoder', 'bitcoin', 'mainnet')
            expect(name).to.equal('xchain-node-bitcoin-mainnet-xchain-encoder')
        })

        it('shared modules (hub, database, explorer) omit coin/network', function () {
            expect(ConfigService.getDockerContainerImageName(HUB_MODULE_NAME, '', ''))
                .to.equal('xchain-node-xchain-hub')
            expect(ConfigService.getDockerContainerImageName(DB_MODULE_NAME, 'bitcoin', 'mainnet'))
                .to.equal('xchain-node-database')
            expect(ConfigService.getDockerContainerImageName(EXPLORER_MODULE_NAME, '', ''))
                .to.equal('xchain-node-xchain-explorer')
        })

        it('Docker network naming is consistent', function () {
            expect(ConfigService.getDockerNetwork('bitcoin', 'mainnet')).to.equal('xchain-node-bitcoin-mainnet')
            expect(ConfigService.getDockerNetwork('', '')).to.equal('xchain-node')
            expect(ConfigService.getDockerNetwork('dogecoin', 'regtest')).to.equal('xchain-node-dogecoin-regtest')
        })
    })
})
