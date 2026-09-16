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
const { Coin, Network } = require('../../../src/config')
const { filterCommandParameters } = require('../../../src/services/config_service')

function describeBoundaryTests(title, defineTests) {
    describe('Boundary Tests', function () {
        afterEach(function () {
            sinon.restore()
        })

        describe(title, defineTests)
    })
}

// 3. filterCommandParameters boundaries
describeBoundaryTests('ConfigService: filterCommandParameters boundaries', function () {
    it('returns empty module list for regtest-only service on mainnet', function () {
        const result = filterCommandParameters(null, 'xchain-regtest-miner', 'bitcoin', 'mainnet')
        expect(result['bitcoin']['mainnet']).to.deep.equal([])
    })

    it('returns empty module list for regtest-only service on testnet', function () {
        const result = filterCommandParameters(null, 'xchain-regtest-miner', 'bitcoin', 'testnet')
        expect(result['bitcoin']['testnet']).to.deep.equal([])
    })

    it('includes regtest-miner on regtest', function () {
        const result = filterCommandParameters(null, 'xchain-regtest-miner', 'bitcoin', 'regtest')
        expect(result['bitcoin']['regtest']).to.deep.equal(['xchain-regtest-miner'])
    })

    it('treats unknown service as literal module name', function () {
        const result = filterCommandParameters(null, 'unknown-service', 'bitcoin', 'mainnet')
        expect(result['bitcoin']['mainnet']).to.deep.equal(['unknown-service'])
    })

    it('full expansion (all/all/all) produces correct structure', function () {
        const result = filterCommandParameters(null, 'all', 'all', 'all')
        const coins = Object.values(Coin)
        const networks = Object.values(Network)

        for (const coin of coins) {
            expect(result).to.have.property(coin)
            for (const network of networks) {
                expect(result[coin]).to.have.property(network)
                const modules = result[coin][network]
                expect(modules).to.include('xchain-encoder')
                expect(modules).to.include('node')
                if (network === 'regtest') {
                    expect(modules).to.include('xchain-regtest-miner')
                } else {
                    expect(modules).to.not.include('xchain-regtest-miner')
                }
                expect(modules).to.not.include('xchain-e2e-test')
            }
        }

        // Explorer in shared slot
        expect(result['']).to.exist
        expect(result['']['']).to.include('xchain-explorer')
    })

    it('explorer special case sets coins to empty', function () {
        const result = filterCommandParameters(null, 'explorer', 'bitcoin', 'mainnet')
        // Should only have the shared '' key with explorer
        expect(result['']).to.exist
        expect(result['']['']).to.deep.equal(['xchain-explorer'])
        // Should NOT have bitcoin key since coins array was emptied
        expect(result['bitcoin']).to.be.undefined
    })
})
