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

const {
    DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME,
    Coin, CoinTickerSymbol
} = require('../../../src/config')
const {
    getDockerContainerImageName,
    getDockerNetwork,
    getModuleDatabaseName
} = require('../../../src/services/config_service')

function describeBoundaryTests(title, defineTests) {
    describe('Boundary Tests', function () {
        afterEach(function () {
            sinon.restore()
        })

        describe(title, defineTests)
    })
}

// 7. Docker naming boundaries
describeBoundaryTests('ConfigService: naming helper boundaries', function () {
    it('getDockerNetwork with both empty strings returns just prefix', function () {
        expect(getDockerNetwork('', '')).to.equal('xchain-node')
    })

    it('getDockerNetwork with coin only returns prefix-coin', function () {
        expect(getDockerNetwork('bitcoin', '')).to.equal('xchain-node-bitcoin')
    })

    it('getDockerContainerImageName uses prefix for all shared modules', function () {
        const shared = [DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME]
        for (const mod of shared) {
            const name = getDockerContainerImageName(mod, 'bitcoin', 'mainnet')
            expect(name).to.equal('xchain-node-' + mod)
        }
    })

    it('getModuleDatabaseName capitalizes network correctly', function () {
        expect(getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet')).to.include('Mainnet')
        expect(getModuleDatabaseName('xchain-decoder', 'bitcoin', 'testnet')).to.include('Testnet')
        expect(getModuleDatabaseName('xchain-decoder', 'bitcoin', 'regtest')).to.include('Regtest')
    })

    it('getModuleDatabaseName uses correct ticker for all coins', function () {
        for (const coin of Object.values(Coin)) {
            const name = getModuleDatabaseName('xchain-decoder', coin, 'mainnet')
            expect(name).to.include(CoinTickerSymbol[coin])
        }
    })
})
