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
const { mintClosedReason } = require('../../src/services/validator_stake_service/mint_rules')
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
            const mintClosed = mintClosedReason({ locked: true }, 200001, 'XCHAIN')
            const p = planMints('testnet', 0, 25000, 10000, 50000, null, { mintClosed })
            expect(p.mints).to.deep.equal([])
            expect(p.reason).to.match(/no open mint/)
        })

        it('reads MAX_MINT 0 as no per-transaction cap and plans one MINT of the shortfall', function () {
            expect(planMints('testnet', 0, 25000, 0, 0)).to.deep.equal({ short: 25000, mints: [25000], reason: null })
            expect(planMints('testnet', 0, 25000, 0, 50000).mints).to.deep.equal([25000])
        })

        it('counts what the address already minted against the per-address cap', function () {
            expect(planMints('testnet', 0, 25000, 10000, 50000, null, { mintedSoFar: 30000 }).reason)
                .to.match(/plus the 30000 this address already minted exceeds the per-address mint cap/)
            expect(planMints('testnet', 0, 25000, 10000, 50000, null, { mintedSoFar: 25000 }).reason).to.equal(null)
        })

        it('refuses when what the address already minted could not be read', function () {
            const p = planMints('testnet', 0, 25000, 10000, 50000, null, { mintedUnknown: 'could not read what X has already minted' })
            expect(p.mints).to.deep.equal([])
            expect(p.reason).to.match(/could not read what X has already minted/)
        })
    })
})

// A fractional XCHAIN balance is the normal state after an earlier run spent from the address,
// and the indexer refuses a MINT AMOUNT past 8 decimal places as malformed.
describe('ValidatorStakeService exact mint amounts', function () {
    describe('planMints() from a fractional balance', function () {
        const EIGHT_PLACES = /^\d+(\.\d{1,8})?$/

        it('plans the exact 8-place shortfall, not float noise', function () {
            const p = planMints('testnet', 24999.99877, 25000, 10000, 50000)
            expect(p).to.deep.equal({ short: 0.00123, mints: [0.00123], reason: null })
            for (const m of p.mints) expect(m.toFixed(8).replace(/\.?0+$/, '')).to.match(EIGHT_PLACES)
            expect(String(p.mints[0])).to.equal('0.00123')
        })

        it('splits a fractional shortfall into cap-sized mints that sum to it exactly', function () {
            const p = planMints('testnet', 12000.5, 25000, 10000, 50000)
            expect(p.mints).to.deep.equal([10000, 2999.5])
            expect(p.short).to.equal(12999.5)
            const p2 = planMints('testnet', 0.1 + 0.2, 25000, 10000, 50000)
            expect(p2.mints).to.deep.equal([10000, 10000, 4999.7])
        })

        it('names the exact shortfall on mainnet', function () {
            expect(planMints('mainnet', 24999.99877, 25000, 10000, 50000).reason).to.match(/acquire 0\.00123 more/)
        })

        it('needs no mint when the balance rounds to the stake at 8 places', function () {
            expect(planMints('testnet', 24999.999999999, 25000, 10000, 50000)).to.deep.equal({ short: 0, mints: [], reason: null })
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
