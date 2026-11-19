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
//
// The explorer reports an unavailable tip as an explicit null under the coin key. Every
// tip read must treat it as unknown, never as block 0, and a failed tip read on the
// delegation check must come back as an unknown, not as a delegation to revoke.

const { expect } = require('chai')

const { readChainState } = require('../../../src/services/validator_stake_service')
const { readTip, readKeyHolders } = require('../../../src/services/validator_stake_service/free_key')
const { readAnsweredCapabilitySets } = require('../../../src/services/validator_service/capability_drift')
const { ADDRESS } = require('../../helpers/stake_harness')

const PUBKEY = 'ab'.repeat(32)
const COINS = { stake: 'bitcoin-testnet', stakeCoin: 'TBTC' }
const CTX = { network: 'testnet', coins: COINS, cooldownBlocks: 1000 }
const CLOSED_WINDOW = { max: '10000.00000000', address_max: '50000.00000000', start_block: 0, stop_block: 100 }

function sdkWith(status, { delegations = [] } = {}) {
    return { explorer: {
        getStatus: typeof status === 'function' ? status : async () => status,
        getValidators: async () => ({ data: [] }),
        getDelegations: async () => ({ total: delegations.length, data: delegations })
    } }
}

function delegation(deactivationBlock, extra = {}) {
    return { status: 'valid', signing_pubkey: PUBKEY, source: ADDRESS, action_index: 5, deactivation_block: deactivationBlock, ...extra }
}

describe('stake CLI readTip', function readTipCases() {
    for (const [label, status] of [
        ['a null tip', { last_block: { TBTC: null } }],
        ['an empty-string tip', { last_block: { TBTC: '' } }],
        ['a missing key', { last_block: {} }],
        ['a missing map', {}],
        ['a non-integer tip', { last_block: { TBTC: 'soon' } }],
        ['a negative tip', { last_block: { TBTC: -1 } }]
    ]) {
        it(`throws on ${label}`, async function () {
            let thrown = null
            try { await readTip(sdkWith(status), COINS) } catch (e) { thrown = e }
            expect(thrown && thrown.message).to.match(/no last block for TBTC/)
        })
    }

    it('still reads a real tip, block 0 and a numeric string included', async function () {
        expect(await readTip(sdkWith({ last_block: { TBTC: 0 } }), COINS)).to.equal(0)
        expect(await readTip(sdkWith({ last_block: { TBTC: '200000' } }), COINS)).to.equal(200000)
    })
})

describe('stake CLI mint window read', function closedMintWindow() {
    const token = { info: { tick: 'XCHAIN' }, mints: CLOSED_WINDOW,
        supply: { current: '0', max: '100000000' }, locks: { mint: false } }
    const sdkFor = tip => ({
        explorer: {
            getAddress: async () => ({ balances: { confirmed: '0.002', pending: '0' } }),
            getToken: async () => token,
            getValidators: async () => ({ data: [] }),
            getDelegations: async () => ({ total: 0, data: [] }),
            getStatus: async () => ({ last_block: { TBTC: tip } }),
            getSleeps: async () => ({ total: 0, data: [] }),
            getMints: async () => ({ total: 0, data: [] })
        },
        getBalances: async () => ({ data: [{ tick: 'XCHAIN', amount: '0' }] })
    })

    it('is reported closed at a real tip past the stop block', async function () {
        const s = await readChainState(sdkFor(500), ADDRESS, PUBKEY, CTX)
        expect(s.mintClosed).to.be.a('string').and.to.match(/MINT_STOP_BLOCK|closed|stop/i)
    })

    it('is reported unconfirmed, never open, when the tip is null', async function () {
        const s = await readChainState(sdkFor(null), ADDRESS, PUBKEY, CTX)
        expect(s.mintClosed).to.match(/could not confirm the XCHAIN mint window is open/)
    })
})

describe('stake CLI delegation check', function delegationWithoutTip() {
    const noTip = { last_block: { TBTC: null } }

    it('reports a revoked-only delegation as unknown when the tip is null', async function () {
        const out = await readKeyHolders(sdkWith(noTip, { delegations: [delegation(150)] }), PUBKEY, CTX)
        expect(out.delegated).to.equal(null)
        expect(out.delegationUnknown).to.match(/chain tip could not be read.*no last block for TBTC/)
    })

    it('reports a revoked-only delegation as unknown when the status call throws', async function () {
        const failing = async () => { throw new Error('explorer down') }
        const out = await readKeyHolders(sdkWith(failing, { delegations: [delegation(150)] }), PUBKEY, CTX)
        expect(out.delegated).to.equal(null)
        expect(out.delegationUnknown).to.match(/explorer down/)
    })

    it('still reports a live delegation as holding the key without a tip', async function () {
        const live = delegation(null, { action_index: 9 })
        const out = await readKeyHolders(sdkWith(noTip, { delegations: [delegation(150), live] }), PUBKEY, CTX)
        expect(out.delegationUnknown).to.equal(null)
        expect(out.delegated).to.deep.equal([live])
    })

    it('frees a key whose only delegation was revoked before a readable tip', async function () {
        const out = await readKeyHolders(sdkWith({ last_block: { TBTC: 200000 } }, { delegations: [delegation(150)] }), PUBKEY, CTX)
        expect(out.delegated).to.equal(null)
        expect(out.delegationUnknown).to.equal(null)
    })

    it('keeps a delegation revoked in the future holding the key at a readable tip', async function () {
        const out = await readKeyHolders(sdkWith({ last_block: { TBTC: 100 } }, { delegations: [delegation(150)] }), PUBKEY, CTX)
        expect(out.delegated).to.have.length(1)
    })
})

describe('capability drift tip read', function capabilityDriftTip() {
    const driftSdk = tip => ({
        explorer: {
            getCapabilityValidators: async () => ({ validators: [] }),
            getStatus: async () => ({ last_block: { TBTC: tip } })
        }
    })
    const read = tip => readAnsweredCapabilitySets(PUBKEY, 'testnet', ['price'], { sdk: {}, makeSdk: () => driftSdk(tip) })

    it('reads the capability sets as unavailable, not at block 0, when the tip is null', async function () {
        const r = await read(null)
        expect(r.unavailable).to.equal(true)
        expect(r.reason).to.match(/no last block for TBTC/)
    })

    it('still reads the sets at a real tip', async function () {
        const r = await read(200000)
        expect(r.unavailable).to.not.equal(true)
    })
})
