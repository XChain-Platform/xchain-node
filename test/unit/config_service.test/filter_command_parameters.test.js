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


const { expect, Coin, Network } = require('./helpers.test')

const { filterCommandParameters } = require('../../../src/services/config_service')

function filterCommandParameters1() {
    it('passes single module/coin/network through unchanged', function () {
        const result = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'mainnet')
        expect(result['bitcoin']['mainnet']).to.deep.equal(['xchain-encoder'])
    })

    it('expands "all" coins to bitcoin, dogecoin, litecoin', function () {
        const result = filterCommandParameters(null, 'xchain-encoder', 'all', 'mainnet')
        expect(result).to.have.property('bitcoin')
        expect(result).to.have.property('dogecoin')
        expect(result).to.have.property('litecoin')
    })

    it('expands "all" networks to mainnet, testnet, regtest', function () {
        const result = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', 'all')
        expect(result['bitcoin']).to.have.property('mainnet')
        expect(result['bitcoin']).to.have.property('testnet')
        expect(result['bitcoin']).to.have.property('regtest')
    })

    it('expands "all" modules to full service list plus node', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
        const modules = result['bitcoin']['mainnet']
        expect(modules).to.include('xchain-encoder')
        expect(modules).to.include('xchain-decoder')
        expect(modules).to.include('xchain-utxo-tracker')
        expect(modules).to.include('xchain-indexer')
        expect(modules).to.include('node')
    })

    it('lists the coin node before every service under "all", so install creates it first', function () {
        // Regression: with the node last, a mainnet install created the decoder
        // hours before the node existed and it logged ENOTFOUND the whole time.
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            const modules = filterCommandParameters(null, 'all', 'bitcoin', network)['bitcoin'][network]
            expect(modules[0]).to.equal('node')
            expect(modules.filter(m => m === 'node')).to.have.length(1)
        }
    })

    it('filters regtest-only modules from mainnet', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
        const modules = result['bitcoin']['mainnet']
        expect(modules).to.not.include('xchain-regtest-miner')
        expect(modules).to.not.include('xchain-e2e-test')
    })

    it('filters regtest-only modules from testnet', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'testnet')
        const modules = result['bitcoin']['testnet']
        expect(modules).to.not.include('xchain-regtest-miner')
        expect(modules).to.not.include('xchain-e2e-test')
    })
}

function filterCommandParameters2() {
    it('includes regtest-miner for regtest but excludes e2e-test from all', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'regtest')
        const modules = result['bitcoin']['regtest']
        expect(modules).to.include('xchain-regtest-miner')
        expect(modules).to.not.include('xchain-e2e-test')
    })

    it('adds explorer to servicesList[""][""] when modules is "all"', function () {
        const result = filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
        expect(result['']).to.exist
        expect(result[''][''][0]).to.equal('xchain-explorer')
    })

    it('handles "explorer" module name', function () {
        const result = filterCommandParameters(null, 'explorer', 'bitcoin', 'mainnet')
        expect(result['']).to.exist
        expect(result[''][''][0]).to.equal('xchain-explorer')
    })

    it('handles "node" module name', function () {
        const result = filterCommandParameters(null, 'node', 'bitcoin', 'mainnet')
        expect(result['bitcoin']['mainnet']).to.deep.equal(['node'])
    })

    it('returns correct structure for all coins + all networks + all modules', function () {
        const result = filterCommandParameters(null, 'all', 'all', 'all')
        for (const coin of Object.values(Coin)) {
            expect(result).to.have.property(coin)
            for (const network of Object.values(Network)) {
                expect(result[coin]).to.have.property(network)
                const modules = result[coin][network]
                expect(modules).to.include('xchain-encoder')
                if (network === 'regtest') {
                    expect(modules).to.include('xchain-regtest-miner')
                } else {
                    expect(modules).to.not.include('xchain-regtest-miner')
                }
            }
        }
    })

    it('handles null coins (expands to all)', function () {
        const result = filterCommandParameters(null, 'xchain-encoder', null, 'mainnet')
        expect(result).to.have.property('bitcoin')
        expect(result).to.have.property('dogecoin')
        expect(result).to.have.property('litecoin')
    })

    it('handles null networks (expands to all)', function () {
        const result = filterCommandParameters(null, 'xchain-encoder', 'bitcoin', null)
        expect(result['bitcoin']).to.have.property('mainnet')
        expect(result['bitcoin']).to.have.property('testnet')
        expect(result['bitcoin']).to.have.property('regtest')
    })
}

function filterCommandParameters3() {
    // recreate/start/stop/logs pass the operator's raw token straight here
    // without going through resolveArgs, so the alias has to apply in both.
    it('accepts the short shared-service names operators actually type', function () {
        expect(filterCommandParameters(null, 'hub',  null, null)['']).to.deep.equal({ '': ['xchain-hub'] })
        expect(filterCommandParameters(null, 'sync', null, null)['']).to.deep.equal({ '': ['xchain-sync'] })
        expect(filterCommandParameters(null, 'db',   null, null)['']).to.deep.equal({ '': ['database'] })
    })
}

describe('ConfigService', function () {
    describe('filterCommandParameters()', filterCommandParameters1)
})

describe('ConfigService', function () {
    describe('filterCommandParameters()', filterCommandParameters2)
})

describe('ConfigService', function () {
    describe('filterCommandParameters()', filterCommandParameters3)
})
