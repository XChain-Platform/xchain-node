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

// The token rules the indexer judges a MINT by, read before the stake run spends a MINT fee:
// MAX_MINT 0 is no per-transaction cap, LOCK_MINT and the start/stop window refuse, and
// MINT_ADDRESS_MAX counts what the address already minted itself.

const { expect } = require('chai')

const { readChainState, planMints } = require('../../../src/services/validator_stake_service')
const { readTokenMintRules, mintClosedReason, readSelfMinted } =
    require('../../../src/services/validator_stake_service/mint_rules')
const { ADDRESS, run } = require('../../helpers/stake_harness')

const TIP = 200000
const COINS = { stake: 'bitcoin-testnet', stakeCoin: 'TBTC' }
const KEY_CTX = { network: 'testnet', coins: COINS, cooldownBlocks: 1000 }
const OPEN = { max: '10000.00000000', address_max: '50000.00000000', start_block: 0, stop_block: 0 }
const MINTED = (amount, extra = {}) =>
    ({ source: ADDRESS, tick: 'XCHAIN', amount, status: 'valid', action_index: 7, ...extra })

// An SDK whose token, tip and source-lane MINT reads answer with the given bodies.
function fakeSdk({ mints = OPEN, locks = { mint: false }, tip = TIP, getMints } = {}) {
    return {
        explorer: {
            getAddress:     async () => ({ balances: { confirmed: '0.002', pending: '0' } }),
            getToken:       async () => ({ info: { tick: 'XCHAIN' }, mints, locks }),
            getValidators:  async () => ({ data: [] }),
            getDelegations: async () => ({ total: 0, data: [] }),
            getStatus:      async () => (tip === null ? {} : { last_block: { TBTC: tip } }),
            getSleeps:      async () => ({ total: 0, data: [] }),
            getMints:       getMints || (async () => ({ total: 0, data: [] }))
        },
        getBalances: async () => ({ data: [{ tick: 'XCHAIN', amount: '0' }] })
    }
}

// Plan a 25000 stake from a zero balance against what readChainState read.
async function planFor(sdk) {
    const s = await readChainState(sdk, ADDRESS, 'ab'.repeat(32), KEY_CTX)
    return { state: s, plan: planMints('testnet', s.tokenBal, 25000, s.mintMax, s.mintAddressMax, s.mintUnreadable, s) }
}

describe('validator stake mint rules', function () {

    it('reads the explorer\'s MAX_MINT of "0.00000000" as no per-transaction cap', async function () {
        const { state, plan } = await planFor(fakeSdk({ mints: { ...OPEN, max: '0.00000000', address_max: '0.00000000' } }))
        expect(state.mintMax).to.equal(0)
        expect(state.mintUnreadable).to.equal(null)
        expect(plan).to.deep.equal({ short: 25000, mints: [25000], reason: null })
    })

    it('reads an unreported cap, window or lock as unknown, never as an unset 0', function () {
        const nullMax = readTokenMintRules({ mints: { ...OPEN, max: null }, locks: { mint: false } }, 'XCHAIN')
        expect(nullMax.unreadable).to.include('mints.max')
        const noWindow = readTokenMintRules({ mints: { max: '1', address_max: '1' }, locks: { mint: false } }, 'XCHAIN')
        expect(noWindow.unreadable).to.include('mints.start_block').and.to.include('mints.stop_block')
        expect(readTokenMintRules({ mints: OPEN }, 'XCHAIN').unreadable).to.include('locks.mint')
        expect(readTokenMintRules({ mints: OPEN, locks: { mint: false } }, 'XCHAIN').unreadable).to.equal(null)
    })

    it('refuses a locked mint before any MINT is planned', async function () {
        const { plan } = await planFor(fakeSdk({ locks: { mint: true } }))
        expect(plan.mints).to.deep.equal([])
        expect(plan.reason).to.match(/no open mint: its mint is locked \(LOCK_MINT\)/)
    })

    it('refuses a window that opens after the block a MINT sent now lands in', async function () {
        const { plan } = await planFor(fakeSdk({ mints: { ...OPEN, start_block: 999999999 } }))
        expect(plan.mints).to.deep.equal([])
        expect(plan.reason).to.match(/minting opens at block 999999999 \(MINT_START_BLOCK\)/)
    })

    it('refuses a window that closed before the block a MINT sent now lands in', async function () {
        const { plan } = await planFor(fakeSdk({ mints: { ...OPEN, stop_block: TIP } }))
        expect(plan.reason).to.match(/minting closed after block 200000 \(MINT_STOP_BLOCK\)/)
    })

    it('judges the window at tip + 1, the indexer\'s inclusive bounds', function () {
        expect(mintClosedReason({ startBlock: TIP + 1, stopBlock: 0 }, TIP + 1, 'XCHAIN')).to.equal(null)
        expect(mintClosedReason({ startBlock: TIP + 2, stopBlock: 0 }, TIP + 1, 'XCHAIN')).to.match(/opens at block/)
        expect(mintClosedReason({ startBlock: 0, stopBlock: TIP + 1 }, TIP + 1, 'XCHAIN')).to.equal(null)
    })

})

describe('validator stake mint rules', function () {

    it('refuses when the tip cannot be read, instead of reading the window as open', async function () {
        const { plan } = await planFor(fakeSdk({ tip: null, mints: { ...OPEN, stop_block: TIP + 5 } }))
        expect(plan.mints).to.deep.equal([])
        expect(plan.reason).to.match(/could not confirm the XCHAIN mint window is open/)
    })

    it('sums only valid XCHAIN mints this address authored', async function () {
        const rows = [MINTED('20000.00000000'), MINTED('10000'), MINTED('5000', { status: 'invalid: MINT_STOP_BLOCK' }),
            MINTED('5000', { tick: 'OTHER' }), MINTED('5000', { source: 'mSomeoneElse' })]
        const sdk = fakeSdk({ getMints: async () => ({ total: rows.length, data: rows }) })
        expect(await readSelfMinted(sdk, ADDRESS, 'XCHAIN')).to.equal(30000)
        const { plan } = await planFor(sdk)
        expect(plan.reason).to.match(/plus the 30000 this address already minted exceeds the per-address mint cap \(50000\)/)
    })

    it('pages the source lane to the end and refuses a short read', async function () {
        const pages = []
        const full = Array.from({ length: 100 }, () => MINTED('100'))
        const sdk = fakeSdk({ getMints: async (q, type, opts) => {
            pages.push([type, opts.page])
            return opts.page === 1 ? { total: 101, data: full } : { total: 101, data: opts.page === 2 ? [MINTED('1')] : [] }
        } })
        expect(await readSelfMinted(sdk, ADDRESS, 'XCHAIN')).to.equal(10001)
        expect(pages).to.deep.equal([['source', 1], ['source', 2]])
        const short = fakeSdk({ getMints: async (q, t, opts) => (opts.page === 1 ? { total: 101, data: full } : { total: 101, data: [] }) })
        const { plan } = await planFor(short)
        expect(plan.mints).to.deep.equal([])
        expect(plan.reason).to.match(/could not read what mStakeAddress has already minted \(mint read incomplete/)
    })

    it('skips the mint-history read when the token sets no per-address cap', async function () {
        let called = 0
        const sdk = fakeSdk({ mints: { ...OPEN, address_max: '0' }, getMints: async () => { called++; throw new Error('no') } })
        const { plan } = await planFor(sdk)
        expect(called).to.equal(0)
        expect(plan.reason).to.equal(null)
    })
})

describe('validator stake --broadcast against the mint rules', function () {

    it('sends no MINT and no STAKE when earlier mints leave too little of the per-address cap', async function () {
        const { result, calls } = await run({ broadcast: true }, { xchain: 0, priorMints: [MINTED('40000')] })
        expect(result.staked).to.be.false
        expect(result.blockers.join(' ')).to.match(/already minted exceeds the per-address mint cap/)
        expect(calls.mint).to.have.length(0)
        expect(calls.stake).to.have.length(0)
    })

    it('sends nothing when the mint is locked or its window is closed', async function () {
        for (const chain of [{ mintLocked: true }, { mintStart: 999999999 }, { mintStop: 100 }]) {
            const { result, calls } = await run({ broadcast: true }, { xchain: 0, ...chain })
            expect(result.blockers.join(' '), JSON.stringify(chain)).to.match(/no open mint/)
            expect(calls.mint.length + calls.stake.length, JSON.stringify(chain)).to.equal(0)
        }
    })

    it('mints the whole shortfall in one MINT when the token has no per-transaction cap', async function () {
        const { result, calls } = await run({ broadcast: true }, { xchain: 0, mintMax: '0.00000000', addressMax: '0' })
        expect(result.staked).to.equal(true)
        expect(calls.mint.map(c => Number(c.params.AMOUNT))).to.deep.equal([25000])
    })
})
