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

const { Coin, Network, XChainService, CoinTickerSymbol } = require('../../../src/config')

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p2] Utility Functions', function () {

        it('R-HLP-001: stringToCoin maps all supported coins correctly', function () {
            const { stringToCoin } = require('../../../src/utils/helpers')
            expect(stringToCoin('bitcoin')).to.equal('BITCOIN')
            expect(stringToCoin('dogecoin')).to.equal('DOGECOIN')
            expect(stringToCoin('litecoin')).to.equal('LITECOIN')
            expect(stringToCoin('ethereum')).to.be.null
            expect(stringToCoin('')).to.be.null
            expect(stringToCoin(null)).to.be.null
        })

        it('R-HLP-002: stringToXChainService maps all services correctly', function () {
            const { stringToXChainService } = require('../../../src/utils/helpers')
            expect(stringToXChainService('xchain-encoder')).to.equal('XCHAIN_ENCODER')
            expect(stringToXChainService('xchain-decoder')).to.equal('XCHAIN_DECODER')
            expect(stringToXChainService('xchain-utxo-tracker')).to.equal('XCHAIN_UTXO_TRACKER')
            expect(stringToXChainService('xchain-indexer')).to.equal('XCHAIN_INDEXER')
            expect(stringToXChainService('xchain-regtest-miner')).to.equal('XCHAIN_REGTEST_MINER')
            expect(stringToXChainService('xchain-e2e-test')).to.equal('XCHAIN_E2E_TEST')
            expect(stringToXChainService('xchain-unknown')).to.be.null
        })
    })
})

describe('Regression Suite', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('[regression:p2] Utility Functions', function () {

        it('R-HLP-003: stringToNetwork parses coin-network pairs correctly', function () {
            const { stringToNetwork } = require('../../../src/utils/helpers')
            const btc = stringToNetwork('bitcoin-mainnet')
            expect(btc.coin).to.equal('BITCOIN')
            expect(btc.network).to.equal('MAINNET')

            const doge = stringToNetwork('dogecoin-testnet')
            expect(doge.coin).to.equal('DOGECOIN')
            expect(doge.network).to.equal('TESTNET')

            const ltc = stringToNetwork('litecoin-regtest')
            expect(ltc.coin).to.equal('LITECOIN')
            expect(ltc.network).to.equal('REGTEST')

            const unknown = stringToNetwork('ethereum-goerli')
            expect(unknown.coin).to.be.null
        })

        it('R-HLP-004: constants enums contain all expected values', function () {
            expect(Object.values(Coin)).to.include.members(['bitcoin', 'dogecoin', 'litecoin'])
            expect(Object.values(Network)).to.include.members(['mainnet', 'testnet', 'regtest'])
            expect(Object.values(XChainService)).to.include.members([
                'xchain-encoder', 'xchain-decoder', 'xchain-utxo-tracker',
                'xchain-indexer', 'xchain-regtest-miner', 'xchain-e2e-test'
            ])
            expect(CoinTickerSymbol['bitcoin']).to.equal('BTC')
            expect(CoinTickerSymbol['dogecoin']).to.equal('DOGE')
            expect(CoinTickerSymbol['litecoin']).to.equal('LTC')
        })
    })
})
