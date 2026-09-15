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
const path       = require('path')

const ROOT = path.join(__dirname, '..', '..', '..')
const { filterCommandParameters } = require(path.join(ROOT, 'src/services/config_service'))

describe('S-SMOKE-008 – Parameter Expansion', function () {

    it('expands all/bitcoin/mainnet to all non-regtest services', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')

        expect(result).to.have.property('bitcoin')
        expect(result.bitcoin).to.have.property('mainnet').that.is.an('array')

        const services = result.bitcoin.mainnet
        expect(services).to.include('xchain-encoder')
        expect(services).to.include('xchain-decoder')
        expect(services).to.include('xchain-utxo-tracker')
        expect(services).to.include('xchain-indexer')
        expect(services).to.include('node')
        expect(services).to.not.include('xchain-regtest-miner')
        expect(services).to.not.include('xchain-e2e-test')
    })

    it('expands all/bitcoin/regtest to include regtest-only modules', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')

        expect(result.bitcoin.regtest).to.include('xchain-regtest-miner')
    })

    it('expands single service across all coins and networks', function () {
        const result = filterCommandParameters(null, 'xchain-encoder', 'all', 'all')

        for (const coin of ['bitcoin', 'litecoin', 'dogecoin']) {
            expect(result).to.have.property(coin)
            for (const network of ['mainnet', 'testnet', 'regtest']) {
                expect(result[coin]).to.have.property(network)
                expect(result[coin][network]).to.include('xchain-encoder')
                expect(result[coin][network]).to.have.lengthOf(1)
            }
        }
    })

    it('filters regtest-only modules from non-regtest networks', function () {
        const result = filterCommandParameters(null, 'all', 'all', 'all')

        for (const coin of ['bitcoin', 'litecoin', 'dogecoin']) {
            expect(result[coin].mainnet).to.not.include('xchain-regtest-miner')
            expect(result[coin].testnet).to.not.include('xchain-regtest-miner')
            expect(result[coin].mainnet).to.not.include('xchain-e2e-test')
            expect(result[coin].testnet).to.not.include('xchain-e2e-test')
            expect(result[coin].regtest).to.include('xchain-regtest-miner')
        }
    })

    it('adds explorer as shared service when using all', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')

        expect(result).to.have.property('')
        expect(result['']).to.have.property('')
        expect(result['']['']).to.include('xchain-explorer')
    })
})
