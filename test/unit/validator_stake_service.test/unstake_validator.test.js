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

const { unstakeValidator } = require('../../../src/services/validator_stake_service')
const sinon = require('sinon')

const PUBKEY  = 'ab'.repeat(32)
const ADDRESS = 'mStakeAddress'

function makeExplorer(chain) {
    return {
        getAddress: sinon.stub().resolves({ balances: { confirmed: chain.coin ?? '0.001', pending: '0' } }),
        getToken:   chain.tokenMissing
            ? sinon.stub().rejects(Object.assign(
                new Error('Explorer returned HTTP 404 for /RBTC/api/token/XCHAIN'),
                { code: 'EXPLORER_HTTP_404', details: { status: 404 } }))
            : sinon.stub().resolves({ mints: { max: chain.mintMax ?? 10000, address_max: chain.addressMax ?? 50000 } }),
        // The whole validator set, which is the method the SDK actually has.
        // Carries an unrelated validator too, so the pubkey filter is exercised
        // rather than "the only row wins".
        getValidators: chain.validatorsThrow
            ? sinon.stub().rejects(new Error(chain.validatorsThrow))
            : sinon.stub().resolves({ data: [
                { status: 'valid', signing_pubkey: 'ff'.repeat(32), amount: '25000', action_index: '1', activation_block: '1' },
                ...(chain.existing ? [chain.existing] : [])
            ] })
    }
}

function trackPreviousOutput(session, prevTxidRef) {
    return () => {
        const s = session()
        const inner = s.submit
        s.submit = async (a, e, o) => { const r = await inner(a, e, o); prevTxidRef.value = r.txid; return r }
        return s
    }
}

// A fake SDK shaped like the parts the command touches: explorer reads,
// balances, and a session whose mint/stake record what they were asked.
function makeSdk(chain = {}) {
    const calls = { mint: [], stake: [] }
    const sdk = {
        explorer: makeExplorer(chain),
        // The mints credit once they index. Modelled by reporting the post-mint
        // balance after they have been sent, so the fallback path can finish.
        getBalances: async () => {
            const base = chain.xchain !== undefined ? chain.xchain : 0
            const credited = calls.mint.length && chain.mintsNeverIndex !== true
                ? base + calls.mint.reduce((s, c) => s + Number(c.params.AMOUNT), 0)
                : base
            return { data: [{ tick: 'XCHAIN', amount: String(credited) }] }
        },
        // Every action goes through session.submit; the convenience wrappers
        // (mint/stake) are sugar over it, and the service calls submit directly
        // so one code path handles the funding chain.
        session: () => ({
            address: ADDRESS,
            submit: async (actionData, enc, opts) => {
                const rec = { params: actionData.params, enc, opts }
                if (actionData.action === 'MINT') calls.mint.push(rec)
                if (actionData.action === 'STAKE') calls.stake.push(rec)
                const txid = actionData.action === 'STAKE' ? 'staketx' : 'mint' + calls.mint.length
                // Report the inputs the encoder was told to use, so the chain
                // assertion in the service sees a real answer.
                const spentInputs = (enc.utxos || []).map(u => ({ txid: u.txid, vout: u.vout }))
                return { txid, spentInputs }
            }
        }),
        // The chain link: each broadcast leaves a change output the next action
        // is funded from. Keyed by txid so the service's filter is exercised.
        requireEncoder: () => ({
            getUTXOs: async () => ({ utxos: chain.noChange ? [] : [
                { txid: prevTxidRef.value || 'seed', fullTxid: prevTxidRef.value || 'seed', vout: 1, value: '150000', confirmations: 0 }
            ] })
        })
    }
    // The fake encoder answers with an output of whatever was broadcast last.
    const prevTxidRef = { value: null }
    sdk.session = trackPreviousOutput(sdk.session, prevTxidRef)
    return { sdk, calls }
}

function runUnstake(opts, chain, settingsExtra = {}) {
    const { sdk, calls } = makeSdk(chain)
    const logged = []
    const deps = {
        settings: { enabled: true, pubkey: PUBKEY, network: 'testnet', P2P_PORT: 10002, ...settingsExtra },
        wallets:  { NETWORK: 'testnet', STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
        makeSdk:  () => sdk,
        sdk:      {},
        log:      m => logged.push(String(m))
    }
    const unstakeCalls = []
    const origSession = sdk.session
    sdk.session = () => {
        const s = origSession()
        const inner = s.submit
        s.submit = async (a, e, o) => { if (a.action === 'UNSTAKE') unstakeCalls.push({ params: a.params, enc: e, opts: o }); return inner(a, e, o) }
        return s
    }
    return unstakeValidator(opts, deps).then(result => ({ result, calls, unstakeCalls, logged }))
}

const STAKED = { status: 'valid', signing_pubkey: PUBKEY, amount: '25000', action_index: '44', activation_block: '150313' }

describe('ValidatorStakeService', function () {

    // Standing down matters as much as joining: membership is derived from
    // chain stake alone, so a staked validator that is not running still counts
    // toward every capability's N and raises the federation's quorum threshold
    // while contributing nothing.
    describe('unstakeValidator()', function () {

        it('dry run reports the active stake and sends nothing', async function () {
            const { result, unstakeCalls, logged } = await runUnstake({}, { existing: STAKED })
            expect(result.dryRun).to.be.true
            expect(unstakeCalls).to.have.length(0)
            expect(logged.join('\n')).to.include('active stake   : 25000 XCHAIN (action 44, activated at block 150313)')
            expect(logged.join('\n')).to.include('Dry run')
        })

        it('with --broadcast sends UNSTAKE v0 for this pubkey', async function () {
            const { result, unstakeCalls } = await runUnstake({ broadcast: true }, { existing: STAKED })
            expect(unstakeCalls).to.have.length(1)
            expect(unstakeCalls[0].params).to.deep.equal({ VERSION: 0, SIGNING_PUBKEY: PUBKEY })
            expect(result.unstaked).to.be.true
        })

        // Leaving the active set and getting the coins back are two clocks nearly
        // three orders of magnitude apart. Printing only the first told operators
        // their XCHAIN was spendable in an hour when it is locked for a week.
        it('the plan prints BOTH clocks: 6 blocks to leave the set, 1000 to unlock', async function () {
            const { logged } = await runUnstake({}, { existing: STAKED })
            const out = logged.join('\n')
            expect(out).to.include('active set: 6 more blocks (roughly 60 minutes)')
            expect(out).to.include('cooldown  : 1000 blocks (roughly 7 days)')
            expect(out).to.include('25000 XCHAIN stays locked')
            expect(out).to.include('NOT')
            expect(out).to.include('spendable before then')
        })
    })
})

describe('ValidatorStakeService', function () {

    describe('unstakeValidator()', function () {

        it('the post-broadcast summary repeats both clocks, not just the delay', async function () {
            const { logged } = await runUnstake({ broadcast: true }, { existing: STAKED })
            const out = logged.join('\n')
            expect(out).to.include('leave the active set 6 blocks (roughly 60 minutes) after the block')
            expect(out).to.include('stays locked for 1000 blocks (roughly 7 days)')
            expect(out).to.include('cooldown sweep credits it back')
        })

        // The old text promised spendability at the activation delay. Nothing in
        // either message may say the coins come back on that clock again.
        it('never claims the XCHAIN is spendable once the stake leaves the set', async function () {
            const { logged } = await runUnstake({ broadcast: true }, { existing: STAKED })
            expect(logged.join('\n')).to.not.match(/6 (more )?blocks[^.]*spendable/)
            expect(logged.join('\n')).to.not.include('XCHAIN is spendable again')
        })

        // Regtest mines on demand, so a wall-clock gloss there would be invented.
        it('omits the duration on regtest, where block spacing is meaningless', async function () {
            const { logged } = await runUnstake({}, { existing: STAKED },
                { network: 'regtest', P2P_PORT: undefined })
            const out = logged.join('\n')
            expect(out).to.include('active set: 6 more blocks.')
            expect(out).to.include('cooldown  : 1000 blocks.')
            expect(out).to.not.include('roughly')
        })

        it('does nothing when the pubkey carries no valid stake', async function () {
            const { result, unstakeCalls, logged } = await runUnstake({ broadcast: true }, {})
            expect(result.nothingStaked).to.be.true
            expect(unstakeCalls).to.have.length(0)
            expect(logged.join('\n')).to.include('carries no valid stake')
        })
    })
})

describe('ValidatorStakeService', function () {

    describe('unstakeValidator()', function () {

        // Refusing beats guessing here: an unreadable validator set could mean
        // "nothing staked", and acting on that reading is how a real stake gets
        // left in place while the operator is told they have stood down.
        it('refuses when the validator set cannot be read', async function () {
            let err = null
            try { await runUnstake({ broadcast: true }, { validatorsThrow: 'explorer 503' }) } catch (e) { err = e }
            expect(err).to.exist
            expect(err.message).to.match(/could not read the validator set/)
        })

        it('refuses a WIF that does not control the recorded stake address', async function () {
            const { sdk } = makeSdk({ existing: STAKED })
            sdk.session = () => ({ address: 'mSomeOtherAddress', submit: async () => ({ txid: 'x' }) })
            let err = null
            try {
                await unstakeValidator({ broadcast: true }, {
                    settings: { enabled: true, pubkey: PUBKEY, network: 'testnet' },
                    wallets:  { STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
                    makeSdk:  () => sdk, sdk: {}, log: () => {}
                })
            } catch (e) { err = e }
            expect(err).to.exist
            expect(err.message).to.match(/controls mSomeOtherAddress/)
        })

        it('refuses without a validator', async function () {
            let err = null
            try { await unstakeValidator({}, { settings: null }) } catch (e) { err = e }
            expect(err.message).to.match(/no validator configured/)
        })
    })
})
