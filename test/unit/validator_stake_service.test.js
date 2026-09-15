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

const { planMints, stakeTiming } = require('../../src/services/validator_stake_service')
// The authoritative source for both stake clocks. Read here too, so a test that
// asserts the CLI's numbers cannot itself become the place they are frozen.
const { getCoinConfig } = require('../../src/coins')

describe('ValidatorStakeService', function () {

    describe('planMints()', function () {

        it('needs no mint when the balance already covers the stake', function () {
            expect(planMints('testnet', 30000, 25000, 10000, 50000)).to.deep.equal({ short: 0, mints: [], reason: null })
        })

        it('splits the shortfall into per-transaction cap-sized mints', function () {
            const p = planMints('testnet', 0, 25000, 10000, 50000)
            expect(p.short).to.equal(25000)
            expect(p.mints).to.deep.equal([10000, 10000, 5000])
            expect(p.reason).to.be.null
        })

        it('mints only the difference when partly funded', function () {
            expect(planMints('testnet', 12000, 25000, 10000, 50000).mints).to.deep.equal([10000, 3000])
        })

        it('never mints on mainnet', function () {
            const p = planMints('mainnet', 0, 25000, 10000, 50000)
            expect(p.mints).to.deep.equal([])
            expect(p.reason).to.match(/not mintable on mainnet/)
        })

        it('flags a shortfall above the per-address cap', function () {
            const p = planMints('testnet', 0, 60000, 10000, 50000)
            expect(p.reason).to.match(/per-address mint cap/)
        })

        it('flags a token with no open mint', function () {
            expect(planMints('testnet', 0, 25000, 0, 0).reason).to.match(/no open mint/)
        })
    })
})

describe('ValidatorStakeService', function () {

    // Both clocks are per-chain (BTC 6/1000, LTC 24/4032, DOGE 60/10080). A CLI
    // that hardcodes BTC's pair is wrong by 4x on LTC and 10x on DOGE, which is
    // the drift these assertions exist to catch.
    describe('stakeTiming()', function () {

        it('reads both clocks from the coin registry, not from the CLI', function () {
            const btc = getCoinConfig('BTC', 'testnet').STAKING
            const t   = stakeTiming({ stake: 'bitcoin-testnet' }, 'testnet')
            expect(t.activationBlocks).to.equal(btc.ACTIVATION_DELAY_BLOCKS)
            expect(t.cooldownBlocks).to.equal(btc.COOLDOWN_BLOCKS)
            expect(t.cooldownBlocks).to.be.above(t.activationBlocks)
        })

        it('tracks the per-chain values for litecoin and dogecoin', function () {
            for (const [full, tick] of [['litecoin', 'LTC'], ['dogecoin', 'DOGE']]) {
                const staking = getCoinConfig(tick, 'mainnet').STAKING
                const t = stakeTiming({ stake: full + '-mainnet' }, 'mainnet')
                expect(t.activationBlocks, tick).to.equal(staking.ACTIVATION_DELAY_BLOCKS)
                expect(t.cooldownBlocks, tick).to.equal(staking.COOLDOWN_BLOCKS)
            }
        })

        // Every chain sizes the same two intervals to the same wall-clock targets;
        // only the block counts differ.
        it('glosses both counts as the same durations on every chain', function () {
            for (const full of ['bitcoin', 'litecoin', 'dogecoin']) {
                const t = stakeTiming({ stake: full + '-mainnet' }, 'mainnet')
                expect(t.activationFor, full).to.equal('roughly 60 minutes')
                expect(t.cooldownFor, full).to.equal('roughly 7 days')
            }
        })

        it('gives no duration on regtest, where blocks are mined on demand', function () {
            const t = stakeTiming({ stake: 'bitcoin-regtest' }, 'regtest')
            expect(t.activationFor).to.equal('')
            expect(t.cooldownFor).to.equal('')
            expect(t.cooldownBlocks).to.be.a('number')
        })
    })
})
