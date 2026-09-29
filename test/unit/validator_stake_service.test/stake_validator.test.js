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

describe('ValidatorStakeService', function () {

    describe('stakeValidator()', function () {

        // The exit cost belongs before the money moves. An operator who reads only
        // the activation delay budgets an hour for capital locked up for a week.
        it('the plan states the escrow and the cooldown that frees it', async function () {
            const { logged } = await run({}, { xchain: 30000, coin: '0.001' })
            const out = logged.join('\n')
            expect(out).to.include('25000 XCHAIN is escrowed for as long as you stay staked')
            expect(out).to.include('cooldown of 1000 blocks (roughly 7 days)')
            expect(out).to.include('6 blocks it takes to leave the active set')
        })

        it('the post-broadcast summary takes the activation delay from the registry', async function () {
            const { logged } = await run({ broadcast: true }, { xchain: 30000, coin: '0.001' })
            expect(logged.join('\n')).to.include('activates 6 blocks (roughly 60 minutes) after it is indexed')
        })

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
    })
})

describe('ValidatorStakeService', function () {

    describe('stakeValidator()', function () {

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
    })
})

describe('ValidatorStakeService', function () {

    describe('stakeValidator()', function () {
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

        // The STAKE's own link is the only chained hop of a single-mint run, so a
        // miss there must wait the mint out rather than broadcast an unchained STAKE.
        it('waits for a single mint to index when only the STAKE hop cannot chain', async function () {
            const { calls, logged, result } = await run(
                { broadcast: true, chainTimeoutMs: 5, balancePollMs: 5 },
                { xchain: 15000, coin: '0.001', noChangeFor: ['mint1'] })
            expect(calls.mint).to.have.length(1)
            expect(logged.join('\n')).to.include('cannot chain')
            expect(logged.join('\n')).to.include('the funding chain broke')
            expect(calls.stake).to.have.length(1)
            expect(calls.stake[0].enc.utxos, 'funded freely once the mint indexed').to.be.undefined
            expect(result.staked).to.be.true
            expect(result.chained).to.be.false
        })

        it('keeps the mints chained and waits when only the last MINT to STAKE hop breaks', async function () {
            const { calls, logged, result } = await run(
                { broadcast: true, chainTimeoutMs: 5, balancePollMs: 5 },
                { xchain: 0, coin: '0.001', noChangeFor: ['mint3'] })
            expect(calls.mint[1].enc.utxos.map(u => u.txid)).to.deep.equal(['mint1'])
            expect(calls.mint[2].enc.utxos.map(u => u.txid)).to.deep.equal(['mint2'])
            expect(logged.join('\n')).to.include('the funding chain broke')
            expect(calls.stake[0].enc.utxos).to.be.undefined
            expect(result.chained).to.be.false
        })

        it('sends no STAKE when the STAKE hop breaks and the mint never indexes', async function () {
            const { calls, logged, result } = await run(
                { broadcast: true, chainTimeoutMs: 5, balancePollMs: 5, timeout: 0.0001 },
                { xchain: 15000, coin: '0.001', noChangeFor: ['mint1'], mintsNeverIndex: true })
            expect(calls.stake, 'never broadcast a STAKE that can land ahead of its funding').to.have.length(0)
            expect(result.pendingMints).to.be.true
            expect(logged.join('\n')).to.include('re-run this command to send the STAKE')
        })
    })
})

describe('ValidatorStakeService', function () {

    describe('stakeValidator()', function () {

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

        it('prints the complete validator URL for every network', async function () {
            const cases = [
                ['mainnet', 10001, 'BTC'],
                ['testnet', 10002, 'TBTC'],
                ['regtest', 10003, 'RBTC']
            ]
            for (const [network, port, coin] of cases) {
                const { logged } = await run(
                    { broadcast: true, wait: false },
                    { xchain: 30000, coin: '0.001' },
                    { network, P2P_PORT: port })
                expect(logged.join('\n'), network).to.include(
                    'Broadcast. Watch it land at https://explorer.xchain.io/' + coin + '/validator/' + PUBKEY)
            }
        })

        it('passes --fee-per-kb through to the encoder', async function () {
            const { calls } = await run({ broadcast: true, feePerKb: '0.0001' }, { xchain: 25000, coin: '0.001' })
            expect(calls.stake[0].enc).to.deep.equal({ feePerKb: 0.0001 })
        })
    })
})

describe('ValidatorStakeService', function () {

    describe('stakeValidator()', function () {

        // A freshly reset regtest venue has no XCHAIN token record at all, and the
        // explorer answers that with a bare HTTP 404 rather than an empty token.
        // That must not leak through as an unexplained crash: name the missing
        // token and point at the fix instead of reporting the raw 404.
        it('names the missing gas token and the bootstrap instead of a raw explorer 404', async function () {
            let caught = null
            try {
                await run({}, { xchain: 0, coin: '0.001', tokenMissing: true })
            } catch (e) {
                caught = e
            }
            expect(caught, 'stakeValidator should reject, not resolve').to.not.equal(null)
            expect(caught.message).to.not.include('404')
            expect(caught.message).to.not.include('Explorer returned HTTP')
            expect(caught.message).to.include('XCHAIN gas token does not exist')
            expect(caught.message).to.include('bootstrap')
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
    })
})

describe('ValidatorStakeService', function () {

    describe('stakeValidator()', function () {

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
            for (const m of ['getValidators', 'getAddress', 'getToken', 'getDelegations', 'getStatus'])
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
})
