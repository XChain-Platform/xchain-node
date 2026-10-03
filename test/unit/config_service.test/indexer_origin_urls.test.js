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

const { expect, makeServiceWithConfig } = require('./helpers.test')

const ORIGIN_INDEXER_VARS = [
    'BTC_INDEXER_URL', 'LTC_INDEXER_URL', 'DOGE_INDEXER_URL',
    'BTC_INDEXER_API_KEY', 'LTC_INDEXER_API_KEY', 'DOGE_INDEXER_API_KEY'
]

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('indexer origin endpoints', function () {
            const saved = {}

            beforeEach(function () {
                for (const name of ORIGIN_INDEXER_VARS) {
                    saved[name] = process.env[name]
                    delete process.env[name]
                }
            })

            afterEach(function () {
                for (const name of ORIGIN_INDEXER_VARS) {
                    if (saved[name] === undefined) delete process.env[name]
                    else process.env[name] = saved[name]
                }
            })

            it('passes configured origin-chain URLs and API keys to every indexer', async function () {
                const expected = {
                    BTC_INDEXER_URL: 'http://bitcoin-indexer:3014',
                    LTC_INDEXER_URL: 'http://litecoin-indexer:3214',
                    DOGE_INDEXER_URL: 'http://dogecoin-indexer:3114',
                    BTC_INDEXER_API_KEY: 'btc-origin-key',
                    LTC_INDEXER_API_KEY: 'ltc-origin-key',
                    DOGE_INDEXER_API_KEY: 'doge-origin-key'
                }
                Object.assign(process.env, expected)

                const cs = makeServiceWithConfig('')
                for (const coin of ['bitcoin', 'litecoin', 'dogecoin']) {
                    const config = await cs.getDefaultConfig('xchain-indexer', coin, 'testnet')
                    for (const [name, value] of Object.entries(expected)) {
                        expect(config[name], coin + ' ' + name).to.equal(value)
                    }
                }
            })

            it('does not inject an unset origin-chain value', async function () {
                process.env.BTC_INDEXER_URL = 'http://bitcoin-indexer:3014'

                const cs = makeServiceWithConfig('')
                const config = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', 'testnet')

                expect(config.BTC_INDEXER_URL).to.equal('http://bitcoin-indexer:3014')
                expect(config).to.not.have.property('BTC_INDEXER_API_KEY')
                expect(config).to.not.have.property('LTC_INDEXER_URL')
            })
        })
    })
})
