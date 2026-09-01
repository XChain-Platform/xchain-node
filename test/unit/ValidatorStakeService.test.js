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

const { stakeValidator, unstakeValidator, planMints } = require('../../src/services/ValidatorStakeService')

const PUBKEY  = 'ab'.repeat(32)
const ADDRESS = 'mStakeAddress'

// A fake SDK shaped like the parts the command touches: explorer reads,
// balances, and a session whose mint/stake record what they were asked.
function makeSdk(chain = {}) {
    const calls = { mint: [], stake: [] }
    const sdk = {
        explorer: {
            getAddress:    sinon.stub().resolves({ balances: { confirmed: chain.coin ?? '0.001', pending: '0' } }),
            getToken:      sinon.stub().resolves({ mints: { max: chain.mintMax ?? 10000, address_max: chain.addressMax ?? 50000 } }),
            // The whole validator set, which is the method the SDK actually has.
            // Carries an unrelated validator too, so the pubkey filter is exercised
            // rather than "the only row wins".
            getValidators: chain.validatorsThrow
                ? sinon.stub().rejects(new Error(chain.validatorsThrow))
                : sinon.stub().resolves({ data: [
                    { status: 'valid', signing_pubkey: 'ff'.repeat(32), amount: '25000', action_index: '1', activation_block: '1' },
                    ...(chain.existing ? [chain.existing] : [])
                ] })
        },
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
        _requireEncoder: () => ({
            getUTXOs: async () => ({ utxos: chain.noChange ? [] : [
                { txid: prevTxidRef.value || 'seed', fullTxid: prevTxidRef.value || 'seed', vout: 1, value: '150000', confirmations: 0 }
            ] })
        })
    }
    // The fake encoder answers with an output of whatever was broadcast last.
    const prevTxidRef = { value: null }
    const origSubmit = sdk.session
    sdk.session = () => {
        const s = origSubmit()
        const inner = s.submit
        s.submit = async (a, e, o) => { const r = await inner(a, e, o); prevTxidRef.value = r.txid; return r }
        return s
    }
    return { sdk, calls }
}

function run(opts, chain, settingsExtra = {}) {
    const { sdk, calls } = makeSdk(chain)
    const logged = []
    const deps = {
        settings: { enabled: true, pubkey: PUBKEY, network: 'testnet', P2P_PORT: 10002, ...settingsExtra },
        wallets:  { NETWORK: 'testnet', STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
        makeSdk:  () => sdk,
        sdk:      { XChainSDK: function () { throw new Error('makeSdk should be used') } },
        log:      m => logged.push(String(m))
    }
    return stakeValidator(opts, deps).then(result => ({ result, calls, logged }))
}

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

    describe('stakeValidator()', function () {

        it('dry run prints the plan and sends nothing', async function () {
            const { result, calls, logged } = await run({}, { xchain: 0, coin: '0.001' })
            expect(result.dryRun).to.be.true
            expect(calls.mint).to.have.length(0)
            expect(calls.stake).to.have.length(0)
            expect(logged.join('\n')).to.include('MINT 1/3: 10000 XCHAIN')
            expect(logged.join('\n')).to.include('STAKE v1: 25000 XCHAIN to ' + PUBKEY)
            expect(logged.join('\n')).to.include('Dry run')
        })

        it('with --broadcast mints the shortfall in order, then stakes', async function () {
            const { result, calls } = await run({ broadcast: true }, { xchain: 5000, coin: '0.001' })
            expect(calls.mint.map(c => c.params)).to.deep.equal([
                { VERSION: 0, TICK: 'XCHAIN', AMOUNT: '10000' },
                { VERSION: 0, TICK: 'XCHAIN', AMOUNT: '10000' }
            ])
            expect(calls.stake).to.have.length(1)
            expect(calls.stake[0].params).to.deep.equal({ VERSION: 1, AMOUNT: '25000', SIGNING_PUBKEY: PUBKEY })
            expect(result.staked).to.be.true
            expect(result.txid).to.equal('staketx')
        })

        // The whole point of chaining: the indexer resolves a STAKE against every
        // ledger entry with a lower action index, so the mints only need to be
        // EARLIER IN THE SAME BLOCK. Waiting a block per step buys nothing.
        it('sends everything back to back and waits only on the STAKE', async function () {
            const { calls, result } = await run({ broadcast: true }, { xchain: 0, coin: '0.001' })
            expect(calls.mint).to.have.length(3)
            for (const m of calls.mint) expect(m.opts.waitForIndexer, 'a mint must not wait for a block').to.be.false
            expect(calls.stake[0].opts.waitForIndexer, 'the stake waits, so the operator sees it land').to.be.true
            expect(calls.stake[0].opts.timeout).to.be.above(60 * 60 * 1000)
            expect(result.chained).to.be.true
        })

        // Ordering inside the block is guaranteed by construction, not hoped for:
        // each action is funded from the previous one's outputs, and consensus
        // forbids a child from preceding its parent in a block.
        it('funds each action from the previous one, forcing the in-block order', async function () {
            const { calls } = await run({ broadcast: true }, { xchain: 0, coin: '0.001' })
            expect(calls.mint[0].enc.utxos, 'the first action funds itself freely').to.be.undefined
            expect(calls.mint[1].enc.utxos.map(u => u.txid)).to.deep.equal(['mint1'])
            expect(calls.mint[2].enc.utxos.map(u => u.txid)).to.deep.equal(['mint2'])
            expect(calls.stake[0].enc.utxos.map(u => u.txid)).to.deep.equal(['mint3'])
        })

        it('waits for the mints to index when no chain can be formed, rather than racing the STAKE', async function () {
            const { calls, logged, result } = await run(
                { broadcast: true, chainTimeoutMs: 5, balancePollMs: 5 },
                { xchain: 0, coin: '0.001', noChange: true })
            expect(logged.join('\n')).to.include('cannot chain')
            expect(logged.join('\n')).to.include('the funding chain broke')
            expect(calls.stake, 'the stake still goes out, after the wait').to.have.length(1)
            expect(calls.stake[0].enc.utxos, 'funded freely once ordering stops mattering').to.be.undefined
            expect(result.chained).to.be.false
        })

        it('reports pending mints instead of staking when they never index', async function () {
            const { calls, result, logged } = await run(
                { broadcast: true, chainTimeoutMs: 5, balancePollMs: 5, timeout: 0.0001 },
                { xchain: 0, coin: '0.001', noChange: true, mintsNeverIndex: true })
            expect(calls.mint).to.have.length(3)
            expect(calls.stake, 'never broadcast a STAKE that would be rejected').to.have.length(0)
            expect(result.pendingMints).to.be.true
            expect(logged.join('\n')).to.include('re-run this command to send the STAKE')
        })

        it('--serialize keeps the old block-per-action behaviour', async function () {
            const { calls } = await run({ broadcast: true, serialize: true, balancePollMs: 5 }, { xchain: 0, coin: '0.001' })
            for (const m of calls.mint) expect(m.opts.waitForIndexer).to.be.true
            for (const m of calls.mint) expect(m.enc.utxos, 'no chaining when serialized').to.be.undefined
            expect(calls.stake).to.have.length(1)
        })

        it('skips minting when already funded', async function () {
            const { calls } = await run({ broadcast: true }, { xchain: 25000, coin: '0.001' })
            expect(calls.mint).to.have.length(0)
            expect(calls.stake).to.have.length(1)
        })

        it('--no-wait returns as soon as the STAKE is broadcast', async function () {
            const { result, calls, logged } = await run({ broadcast: true, wait: false }, { xchain: 0, coin: '0.001' })
            expect(calls.mint).to.have.length(3)
            expect(calls.stake).to.have.length(1)
            expect(calls.stake[0].opts.waitForIndexer).to.be.false
            expect(result.staked).to.be.true
            expect(logged.join('\n')).to.include('Broadcast. Watch it land at')
        })

        it('passes --fee-per-kb through to the encoder', async function () {
            const { calls } = await run({ broadcast: true, feePerKb: '0.0001' }, { xchain: 25000, coin: '0.001' })
            expect(calls.stake[0].enc).to.deep.equal({ feePerKb: 0.0001 })
        })

        it('refuses when the address has no coin for fees', async function () {
            const { result, calls, logged } = await run({ broadcast: true }, { xchain: 0, coin: '0' })
            expect(result.blockers.join(' ')).to.match(/no confirmed TBTC/)
            expect(calls.mint).to.have.length(0)
            expect(logged.join('\n')).to.include('BLOCKED')
        })

        it('does nothing when the pubkey already carries a valid stake', async function () {
            const existing = { status: 'valid', signing_pubkey: PUBKEY, amount: '25000', action_index: '33', activation_block: '150061' }
            const { result, calls, logged } = await run({ broadcast: true }, { xchain: 25000, coin: '0.001', existing })
            expect(result.staked).to.be.false
            expect(result.existing).to.equal(existing)
            expect(calls.stake).to.have.length(0)
            expect(logged.join('\n')).to.include('already carries a valid STAKE')
        })

        it('on mainnet never mints and blocks on a shortfall', async function () {
            const { result, calls } = await run({ broadcast: true }, { xchain: 1000, coin: '0.01' }, { network: 'mainnet', P2P_PORT: 10001 })
            expect(calls.mint).to.have.length(0)
            expect(calls.stake).to.have.length(0)
            expect(result.blockers.join(' ')).to.match(/not mintable on mainnet/)
        })

        it('refuses a WIF that does not control the recorded stake address', async function () {
            const { sdk } = makeSdk({ xchain: 25000 })
            sdk.session = () => ({ address: 'mSomeOtherAddress' })
            let err = null
            try {
                await stakeValidator({}, {
                    settings: { enabled: true, pubkey: PUBKEY, network: 'testnet' },
                    wallets:  { STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
                    makeSdk:  () => sdk, sdk: {}, log: () => {}
                })
            } catch (e) { err = e }
            expect(err).to.exist
            expect(err.message).to.match(/controls mSomeOtherAddress, not the mStakeAddress/)
        })

        it('warns and keeps going when the validator set cannot be read, instead of reading the failure as "not staked"', async function () {
            const { result, logged } = await run({}, { xchain: 25000, coin: '0.001', validatorsThrow: 'explorer 503' })
            expect(logged.join('\n')).to.include('could not read the validator set (explorer 503)')
            expect(result.dryRun).to.be.true
        })

        // The guard above is only as good as the method name it calls: a stub
        // for a method the real SDK does not have passes every test here while
        // the live path throws into a catch and reports "not staked".
        it('calls explorer methods that the published SDK actually exposes', function () {
            const { XChainSDK } = require('@dankest-llc/xchain-sdk')
            const sdk = new XChainSDK({ network: 'bitcoin-testnet' })   // offline: no network I/O in the constructor
            for (const m of ['getValidators', 'getAddress', 'getToken'])
                expect(sdk.explorer[m], 'sdk.explorer.' + m).to.be.a('function')
            for (const m of ['getBalances', 'session'])
                expect(sdk[m], 'sdk.' + m).to.be.a('function')
            expect(sdk.explorer.getValidator, 'getValidator does NOT exist; do not call it').to.be.undefined
        })

        it('refuses without a validator', async function () {
            let err = null
            try { await stakeValidator({}, { settings: null }) } catch (e) { err = e }
            expect(err.message).to.match(/no validator configured/)
        })
    })

    // Standing down matters as much as joining: membership is derived from
    // chain stake alone, so a staked validator that is not running still counts
    // toward every capability's N and raises the federation's quorum threshold
    // while contributing nothing.
    describe('unstakeValidator()', function () {

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

        it('says the delay out loud: the stake keeps counting for 6 more blocks', async function () {
            const { logged } = await runUnstake({ broadcast: true }, { existing: STAKED })
            expect(logged.join('\n')).to.include('for 6 more blocks')
            expect(logged.join('\n')).to.include('leave the active set 6 blocks after')
        })

        it('does nothing when the pubkey carries no valid stake', async function () {
            const { result, unstakeCalls, logged } = await runUnstake({ broadcast: true }, {})
            expect(result.nothingStaked).to.be.true
            expect(unstakeCalls).to.have.length(0)
            expect(logged.join('\n')).to.include('carries no valid stake')
        })

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
