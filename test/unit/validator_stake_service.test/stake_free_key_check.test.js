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

const { stakeValidator } = require('../../../src/services/validator_stake_service')
const { PUBKEY, ADDRESS, makeSdk, run } = require('../../helpers/stake_harness')

// The free-key check mirrors the indexer's validateFreeKey: withdrawn stake
// frees the key only once stake_key_reuse_activation is armed and the cooldown
// has passed, and a delegation holding the key refuses the STAKE outright.
describe('ValidatorStakeService free-key check', function () {

    const row = (over) => Object.assign({ status: 'valid', signing_pubkey: PUBKEY, amount: '25000',
        action_index: '33', activation_block: '150061', deactivation_block: null }, over)

    it('stakes again on testnet past the reuse gate once every row is withdrawn and cooled down', async function () {
        const stakeRows = [row({ deactivation_block: '150000' }), row({ action_index: '40', deactivation_block: '150100' })]
        const { result, logged } = await run({}, { xchain: 25000, coin: '0.001', stakeRows, tip: 199999 })
        expect(result.dryRun).to.be.true
        expect(logged.join('\n')).to.not.include('already carries')
    })

    it('refuses inside the cooldown and names the block the key is released at', async function () {
        const stakeRows = [row({ deactivation_block: '199500' })]
        const { result, calls, logged } = await run({ broadcast: true }, { xchain: 25000, coin: '0.001', stakeRows, tip: 200000 })
        expect(result.staked).to.be.false
        expect(result.existing).to.equal(stakeRows[0])
        expect(calls.stake).to.have.length(0)
        const out = logged.join('\n')
        expect(out).to.include('stake is withdrawn')
        expect(out).to.include('admitted from block 200500')
        expect(out).to.not.include('already carries a valid STAKE')
    })

    it('refuses a withdrawn key on testnet below the gate height, naming that height', async function () {
        const stakeRows = [row({ deactivation_block: '100000' })]
        const { result, logged } = await run({}, { xchain: 25000, coin: '0.001', stakeRows, tip: 150000 })
        expect(result.existing).to.equal(stakeRows[0])
        expect(logged.join('\n')).to.include('releases a withdrawn key only from block 156000')
    })

    it('refuses a withdrawn key on mainnet, where the gate is not armed', async function () {
        const stakeRows = [row({ deactivation_block: '100' })]
        const { result, logged } = await run({}, { xchain: 25000, coin: '0.01', stakeRows, tip: 900000 },
            { network: 'mainnet', P2P_PORT: 10001 })
        expect(result.existing).to.equal(stakeRows[0])
        expect(logged.join('\n')).to.include('does not yet release a signing key')
    })

    it('prints the exact sum of the undeactivated rows, not one row and not a float', async function () {
        const stakeRows = [
            row({ amount: '900000000.00000001' }),
            row({ action_index: '41', amount: '0.00000001' }),
            row({ action_index: '42', amount: '500', deactivation_block: '150000' })
        ]
        const { logged } = await run({}, { xchain: 25000, coin: '0.001', stakeRows })
        expect(logged.join('\n')).to.include('already carries a valid STAKE of 900000000.00000002 XCHAIN (newest action 42')
    })
})

describe('ValidatorStakeService free-key check, delegations', function () {

    const row = (over) => Object.assign({ status: 'valid', signing_pubkey: PUBKEY, amount: '25000',
        action_index: '33', activation_block: '150061', deactivation_block: null }, over)

    it('refuses a key an active delegation holds, before any MINT is sent', async function () {
        const delegations = [{ status: 'valid', signing_pubkey: PUBKEY, source: 'mDelegator', action_index: '50', deactivation_block: null }]
        const { result, calls, logged } = await run({ broadcast: true }, { xchain: 0, coin: '0.001', delegations })
        expect(result.staked).to.be.false
        expect(result.delegated).to.deep.equal(delegations)
        expect(calls.mint).to.have.length(0)
        expect(calls.stake).to.have.length(0)
        expect(logged.join('\n')).to.include('held by a delegation (action 50 from mDelegator)')
    })

    it('asks the explorer for the delegations by pubkey', async function () {
        const { sdk } = makeSdk({ xchain: 25000, coin: '0.001' })
        await stakeValidator({}, { settings: { enabled: true, pubkey: PUBKEY, network: 'testnet' },
            wallets: { STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' }, makeSdk: () => sdk, sdk: {}, log: () => {} })
        expect(sdk.explorer.getDelegations.firstCall.args.slice(0, 2)).to.deep.equal([PUBKEY, 'pubkey'])
    })

    it('does not count a delegation whose deactivation block has passed', async function () {
        const delegations = [{ status: 'valid', signing_pubkey: PUBKEY, source: 'mDelegator', action_index: '50', deactivation_block: '1000' }]
        const { result } = await run({}, { xchain: 25000, coin: '0.001', delegations, tip: 200000 })
        expect(result.dryRun).to.be.true
    })

    it('blocks, rather than passes, when the explorer cannot answer the pubkey lookup', async function () {
        const { result, calls, logged } = await run({ broadcast: true },
            { xchain: 0, coin: '0.001', delegationsThrow: 'Explorer returned HTTP 404 for /TBTC/api/delegations/x/pubkey' })
        expect(result.blockers.join(' ')).to.include('could not confirm this signing pubkey is not delegated')
        expect(calls.mint).to.have.length(0)
        expect(logged.join('\n')).to.include('BLOCKED')
    })

    it('blocks when the pubkey lookup answers without a row list', async function () {
        const { result, calls } = await run({ broadcast: true },
            { xchain: 25000, coin: '0.001', delegationsBody: { error: 'unknown type' } })
        expect(result.blockers.join(' ')).to.include('returned no row list')
        expect(calls.stake).to.have.length(0)
    })
})
