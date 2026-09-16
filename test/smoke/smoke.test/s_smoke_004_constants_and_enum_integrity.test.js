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
const constants = require(path.join(ROOT, 'src/config/index'))

describe('S-SMOKE-004 – Constants and Enum Integrity', function () {

    describe('XChainService enum', function () {
        const expectedServices = [
            'xchain-encoder', 'xchain-decoder', 'xchain-utxo-tracker',
            'xchain-regtest-miner', 'xchain-indexer', 'xchain-e2e-test'
        ]

        for (const svc of expectedServices) {
            it(`contains ${svc}`, function () {
                expect(Object.values(constants.XChainService)).to.include(svc)
            })
        }
    })

    describe('Coin enum', function () {
        for (const coin of ['bitcoin', 'litecoin', 'dogecoin']) {
            it(`contains ${coin}`, function () {
                expect(Object.values(constants.Coin)).to.include(coin)
            })
        }
    })

    describe('Network enum', function () {
        for (const net of ['mainnet', 'testnet', 'regtest']) {
            it(`contains ${net}`, function () {
                expect(Object.values(constants.Network)).to.include(net)
            })
        }
    })
})

describe('S-SMOKE-004 – Constants and Enum Integrity', function () {

    describe('CoinTickerSymbol', function () {
        it('maps bitcoin to BTC', function () {
            expect(constants.CoinTickerSymbol['bitcoin']).to.equal('BTC')
        })
        it('maps litecoin to LTC', function () {
            expect(constants.CoinTickerSymbol['litecoin']).to.equal('LTC')
        })
        it('maps dogecoin to DOGE', function () {
            expect(constants.CoinTickerSymbol['dogecoin']).to.equal('DOGE')
        })
    })

    describe('Directory path constants', function () {
        const pathConstants = ['moduleDir', 'tmpDir', 'srcDir', 'cryptoNodesDir', 'dataDir', 'configDir', 'containersFilesDir']

        for (const name of pathConstants) {
            it(`${name} is a non-empty string`, function () {
                expect(constants[name]).to.be.a('string').that.is.not.empty
            })
        }
    })

    describe('String constants', function () {
        it('NODE_PREFIX is defined', function () {
            expect(constants.NODE_PREFIX).to.be.a('string').that.is.not.empty
        })
        it('HUB_PORT is a number', function () {
            expect(constants.HUB_PORT).to.be.a('number')
        })
        it('SEP is defined', function () {
            expect(constants.SEP).to.be.a('string').that.is.not.empty
        })
        it('DB_SEP is defined', function () {
            expect(constants.DB_SEP).to.be.a('string').that.is.not.empty
        })
    })
})

describe('S-SMOKE-004 – Constants and Enum Integrity', function () {

    describe('modulesUrls mapping', function () {
        const allModules = [
            ...Object.values(constants.XChainService),
            constants.HUB_MODULE_NAME,
            constants.EXPLORER_MODULE_NAME,
            constants.SYNC_MODULE_NAME
        ]

        for (const mod of allModules) {
            it(`has git URL for ${mod}`, function () {
                expect(constants.modulesUrls[mod]).to.be.a('string').that.includes('git')
            })
        }
    })

    describe('projectFolders mapping', function () {
        const allModules = [
            ...Object.values(constants.XChainService),
            constants.HUB_MODULE_NAME,
            constants.EXPLORER_MODULE_NAME,
            constants.SYNC_MODULE_NAME
        ]

        for (const mod of allModules) {
            it(`has project folder for ${mod}`, function () {
                expect(constants.projectFolders[mod]).to.be.a('string').that.is.not.empty
            })
        }
    })

    describe('REGTEST_MODULES', function () {
        it('includes xchain-regtest-miner', function () {
            expect(constants.REGTEST_MODULES).to.include('xchain-regtest-miner')
        })
        it('includes xchain-e2e-test', function () {
            expect(constants.REGTEST_MODULES).to.include('xchain-e2e-test')
        })
        it('does not include non-regtest services', function () {
            expect(constants.REGTEST_MODULES).to.not.include('xchain-encoder')
            expect(constants.REGTEST_MODULES).to.not.include('xchain-decoder')
        })
    })
})
