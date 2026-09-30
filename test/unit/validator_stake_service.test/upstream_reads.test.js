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

// How the stake CLI reads the explorer's address and token answers: an unknown
// balance stays unknown, and the one-element array envelope is unwrapped.

const { expect } = require('chai')

const { readChainState, planMints } = require('../../../src/services/validator_stake_service')
const { stakeBlockers, logStakeBalances } = require('../../../src/services/validator_stake_service/stake_operations')

const PUBKEY  = 'ab'.repeat(32)
const ADDRESS = 'mStakeAddress'
const COINS   = { stake: 'bitcoin-testnet', stakeCoin: 'TBTC' }
const KEY_CTX = { network: 'testnet', coins: COINS, cooldownBlocks: 1000 }

// An SDK that answers the address and token reads with the given bodies, and an
// empty validator set and delegation list so no key holder is found.
function fakeSdk(addressBody, tokenBody) {
    return {
        explorer: {
            getAddress:    async () => addressBody,
            getToken:      async () => tokenBody,
            getValidators: async () => ({ data: [] }),
            getDelegations: async () => ({ total: 0, data: [] }),
            getStatus:     async () => ({ last_block: { 'bitcoin-testnet': 200000 } })
        },
        getBalances: async () => ({ data: [{ tick: 'XCHAIN', amount: '0' }] })
    }
}

const TOKEN = { info: { tick: 'XCHAIN' }, mints: { max: '10000', address_max: '50000' } }

describe('validator stake upstream reads', function () {

    it('reads a tracker outage as an unknown balance, not as zero', async function () {
        const outage = { balances: { confirmed: null, pending: null, received: null }, tracker_available: false }
        const state = await readChainState(fakeSdk(outage, TOKEN), ADDRESS, PUBKEY, KEY_CTX)
        expect(state.coinBal).to.equal(null)
        expect(state.coinPending).to.equal(null)
    })

    it('blocks on an unknown balance as an outage, never as an address to fund', function () {
        const plan = { short: 0, mints: [], reason: null }
        const why = stakeBlockers({ coinBal: null }, plan, COINS, ADDRESS).join(' ')
        expect(why).to.include('TBTC balance at ' + ADDRESS + ' is unavailable')
        expect(why).to.not.include('fund it first')
        expect(stakeBlockers({ coinBal: 0 }, plan, COINS, ADDRESS).join(' ')).to.include('fund it first')
    })

    it('prints an unknown balance as unavailable rather than "null confirmed"', function () {
        const logged = []
        const plan = { short: 0, mints: [], reason: null }
        logStakeBalances(m => logged.push(m), 'testnet', COINS, PUBKEY, ADDRESS, 25000,
            { coinBal: null, coinPending: null, tokenBal: 25000 }, plan, 'XCHAIN')
        expect(logged.join('\n')).to.include('unavailable (the explorer could not read it')
        expect(logged.join('\n')).to.not.include('null confirmed')
    })

    it('unwraps a one-element array envelope on the address and token reads', async function () {
        const addr = [{ balances: { confirmed: '0.002', pending: '0.001' }, tracker_available: true }]
        const state = await readChainState(fakeSdk(addr, [TOKEN]), ADDRESS, PUBKEY, KEY_CTX)
        expect(state.coinBal).to.equal(0.002)
        expect(state.coinPending).to.equal(0.001)
        expect(state.mintMax).to.equal(10000)
        expect(state.mintAddressMax).to.equal(50000)
        expect(state.mintUnreadable).to.equal(null)
    })

    it('names a token with no mints group instead of reporting MAX_MINT 0', async function () {
        const addr = { balances: { confirmed: '0.002', pending: '0' } }
        const state = await readChainState(fakeSdk(addr, { info: { tick: 'XCHAIN' } }), ADDRESS, PUBKEY, KEY_CTX)
        expect(state.mintUnreadable).to.include('unexpected shape (no mints group)')
        const plan = planMints('testnet', 0, 25000, state.mintMax, state.mintAddressMax, state.mintUnreadable)
        expect(plan.mints).to.have.length(0)
        expect(plan.reason).to.include('unexpected shape')
        expect(plan.reason).to.not.include('MAX_MINT is 0')
    })
})

// A /balances list paged 500 rows at a time by tick, with XCHAIN after `junk` earlier ticks.
function pagedBalances(junk, { total = junk + 1, dropPage = null } = {}) {
    const rows = []
    for (let i = 0; i < junk; i++) rows.push({ tick: 'AAA' + String(i).padStart(4, '0'), amount: '1' })
    rows.push({ tick: 'XCHAIN', amount: '25000' })
    const pages = []
    const getBalances = async (address, opts = {}) => {
        pages.push(opts.page)
        const start = ((opts.page || 1) - 1) * (opts.limit || 500)
        const data = opts.page === dropPage ? [] : rows.slice(start, start + (opts.limit || 500))
        return { total, data }
    }
    return { getBalances, pages }
}

describe('validator stake XCHAIN balance paging', function () {
    const addr = { balances: { confirmed: '0.002', pending: '0' } }

    it('finds an XCHAIN row that sits past the first page', async function () {
        const paged = pagedBalances(600)
        const sdk = Object.assign(fakeSdk(addr, TOKEN), { getBalances: paged.getBalances })
        const state = await readChainState(sdk, ADDRESS, PUBKEY, KEY_CTX)
        expect(state.tokenBal).to.equal(25000)
        expect(paged.pages).to.deep.equal([1, 2])
        expect(planMints('testnet', state.tokenBal, 25000, 10000, 50000, null).mints).to.have.length(0)
    })

    it('reads a truncated list as an unknown balance that blocks, never as zero', async function () {
        const paged = pagedBalances(600, { dropPage: 2 })
        const sdk = Object.assign(fakeSdk(addr, TOKEN), { getBalances: paged.getBalances })
        const state = await readChainState(sdk, ADDRESS, PUBKEY, KEY_CTX)
        expect(state.tokenBal).to.equal(null)
        for (const network of ['testnet', 'mainnet']) {
            const plan = planMints(network, state.tokenBal, 25000, 10000, 50000, null)
            expect(plan.mints).to.have.length(0)
            expect(stakeBlockers({ coinBal: 1 }, plan, COINS, ADDRESS).join(' ')).to.include('XCHAIN balance is unavailable')
            expect(plan.reason).to.not.include('acquire')
        }
    })

    it('prints an unknown XCHAIN balance as unavailable rather than "null held"', function () {
        const logged = []
        logStakeBalances(m => logged.push(m), 'testnet', COINS, PUBKEY, ADDRESS, 25000,
            { coinBal: 1, coinPending: 0, tokenBal: null }, { short: null, mints: [], reason: 'x' }, 'XCHAIN')
        expect(logged.join('\n')).to.include('XCHAIN').and.to.include('unavailable (balance list read incomplete)')
        expect(logged.join('\n')).to.not.include('null held')
    })
})
