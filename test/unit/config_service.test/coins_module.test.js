'use strict'

// Copyright © 2025–2026 Dankest, LLC
// GENERATED
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')
const coinsModule = require('../../../src/services/config_service/coins')

const XChainService = {
    XCHAIN_ENCODER: 'xchain-encoder',
    XCHAIN_DECODER: 'xchain-decoder',
    XCHAIN_UTXO_TRACKER: 'xchain-utxo-tracker',
    XCHAIN_REGTEST_MINER: 'xchain-regtest-miner'
}

function configure(config = {}) {
    coinsModule.configure({
        config: {
            CORS_ORIGIN: undefined,
            ENCODER_TRUST_PROXY: undefined,
            ENCODER_RATE_LIMIT_RPM: undefined,
            FEE_DESTINATION_ENV: {},
            FEE_DESTINATION: undefined,
            LEVELDB_CACHE_BYTES: undefined,
            LEVELDB_WRITE_BUFFER_BYTES: undefined,
            ...config
        },
        CoinTickerSymbol: { bitcoin: 'BTC' },
        Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' },
        XChainService,
        getCoinConfigByFullName: () => ({ addresses: { FEE_DESTINATION: 'registry-fee-address' } }),
        getDockerContainerImageName: (module, coin, network) => `${module}-${coin}-${network}`
    })
}

describe('config_service/coins fee defaults', function () {
    it('adds regtest miner, rate-limit, CORS, and canonical fee defaults', function () {
        configure()
        const defaults = {}

        coinsModule.applyCoinDefaults(defaults, XChainService.XCHAIN_ENCODER, 'bitcoin', 'regtest')

        expect(defaults).to.include({
            REGTEST_MINER_URL: 'xchain-regtest-miner-bitcoin-regtest',
            REGTEST_MINER_API_PORT: 3005,
            ENCODER_RATE_LIMIT_RPM: 99999,
            CORS_ORIGIN: '*',
            FEE_DESTINATION: 'registry-fee-address',
            XCHAIN_FEE_DESTINATION_BTC_REGTEST: 'registry-fee-address',
            NETWORK: 'bitcoin-regtest'
        })
    })

    it('lets explicit encoder settings override the regtest defaults', function () {
        configure({ CORS_ORIGIN: 'https://wallet.test', ENCODER_RATE_LIMIT_RPM: '1200', ENCODER_TRUST_PROXY: '10.0.0.1' })
        const defaults = {}

        coinsModule.applyCoinDefaults(defaults, XChainService.XCHAIN_ENCODER, 'bitcoin', 'regtest')

        expect(defaults).to.include({
            CORS_ORIGIN: 'https://wallet.test',
            ENCODER_RATE_LIMIT_RPM: '1200',
            ENCODER_TRUST_PROXY: '10.0.0.1'
        })
    })

    it('uses the generic fee destination only on regtest without a per-coin override', function () {
        configure({ FEE_DESTINATION: 'generic-regtest-fee' })
        const defaults = {}

        coinsModule.applyCoinDefaults(defaults, XChainService.XCHAIN_DECODER, 'bitcoin', 'regtest')

        expect(defaults.FEE_DESTINATION).to.equal('generic-regtest-fee')
        expect(defaults.XCHAIN_FEE_DESTINATION_BTC_REGTEST).to.equal('generic-regtest-fee')
    })

    it('keeps the registry fee destination outside regtest', function () {
        configure({ FEE_DESTINATION: 'generic-fee' })
        const defaults = {}

        coinsModule.applyCoinDefaults(defaults, XChainService.XCHAIN_DECODER, 'bitcoin', 'mainnet')

        expect(defaults.FEE_DESTINATION).to.equal('registry-fee-address')
        expect(defaults.XCHAIN_FEE_DESTINATION_BTC_MAINNET).to.equal('registry-fee-address')
    })
})

describe('config_service/coins module tuning', function () {
    it('passes non-empty LevelDB tuning only to the UTXO tracker', function () {
        configure({ LEVELDB_CACHE_BYTES: '1024', LEVELDB_WRITE_BUFFER_BYTES: '' })
        const tracker = {}
        const encoder = {}

        coinsModule.applyCoinDefaults(tracker, XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
        coinsModule.applyCoinDefaults(encoder, XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')

        expect(tracker.LEVELDB_CACHE_BYTES).to.equal('1024')
        expect(tracker).not.to.have.property('LEVELDB_WRITE_BUFFER_BYTES')
        expect(encoder).not.to.have.property('LEVELDB_CACHE_BYTES')
    })
})

after(function () {
    delete require.cache[require.resolve('../../../src/services/config_service')]
    require('../../../src/services/config_service')
})
