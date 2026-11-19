'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon')
const { expect } = require('chai')

const { stakeValidator, unstakeValidator } = require('../../../src/services/validator_stake_service')
const { PUBKEY, ADDRESS, makeSdk, run } = require('../../helpers/stake_harness')

function testnetStatus(stale) {
    return {
        stale: { TBTC: stale },
        last_block: { TBTC: 200000 },
        tip_age_seconds: { TBTC: stale ? 900 : 5 }
    }
}

function stakeDeps(sdk) {
    return {
        settings: { enabled: true, pubkey: PUBKEY, network: 'testnet', P2P_PORT: 10002 },
        wallets: { NETWORK: 'testnet', STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
        makeSdk: () => sdk,
        sdk: {},
        log: () => {}
    }
}

function makeUnstakeSdk(stale) {
    const submitted = []
    const explorer = {
        getStatus: sinon.stub().resolves(testnetStatus(stale)),
        getValidators: sinon.stub().resolves({ data: [{
            status: 'valid', signing_pubkey: PUBKEY, source: ADDRESS,
            amount: '25000', action_index: '44', activation_block: '1'
        }] }),
        getSleeps: sinon.stub().resolves({ total: 0, data: [] })
    }
    const sdk = {
        explorer,
        session: () => ({
            address: ADDRESS,
            submit: async (action, enc, opts) => {
                submitted.push({ action, enc, opts })
                return { txid: 'unstaketx' }
            }
        })
    }
    return { sdk, explorer, submitted }
}

function runUnstake(stale, opts = {}) {
    const fixture = makeUnstakeSdk(stale)
    const deps = {
        settings: { enabled: true, pubkey: PUBKEY, network: 'testnet', P2P_PORT: 10002 },
        wallets: { NETWORK: 'testnet', STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
        makeSdk: () => fixture.sdk,
        sdk: {},
        log: () => {}
    }
    return unstakeValidator(opts, deps).then(result => ({ ...fixture, result }))
}

describe('ValidatorStakeService explorer freshness', function () {
    it('refuses stale stake plans before dry-run or broadcast reads and sends', async function () {
        for (const opts of [{}, { broadcast: true }]) {
            const { sdk, calls } = makeSdk({
                xchain: 0,
                coin: '0.001',
                stale: { TBTC: true },
                tipAgeSeconds: { TBTC: 900 }
            })
            const err = await stakeValidator(opts, stakeDeps(sdk)).then(() => null, failure => failure)
            expect(err && err.message).to.include('behind the chain for TBTC at block 200000 (15 minutes old)')
            expect(calls.mint).to.have.length(0)
            expect(calls.stake).to.have.length(0)
            expect(sdk.explorer.getAddress.called).to.be.false
        }
    })

    it('accepts an explicit fresh verdict and an absent freshness map', async function () {
        const fresh = await run({}, { xchain: 30000, coin: '0.001', stale: { TBTC: false } })
        const unmeasured = await run({}, { xchain: 30000, coin: '0.001' })
        expect(fresh.result.dryRun).to.be.true
        expect(unmeasured.result.dryRun).to.be.true
    })

    it('uses strict freshness only on the first send in a stake chain', async function () {
        const { calls } = await run({ broadcast: true }, { xchain: 0, coin: '0.001', stale: { TBTC: false } })
        expect(calls.mint[0].opts.strictFreshness).to.be.true
        expect(calls.mint.slice(1).every(call => call.opts.strictFreshness === undefined)).to.be.true
        expect(calls.stake[0].opts.strictFreshness).to.be.undefined

        const funded = await run({ broadcast: true }, { xchain: 30000, coin: '0.001', stale: { TBTC: false } })
        expect(funded.calls.stake[0].opts.strictFreshness).to.be.true
    })

    it('reports a first-submit freshness refusal as sending nothing', async function () {
        const err = await run({ broadcast: true }, {
            xchain: 30000, coin: '0.001', stale: { TBTC: false }, submitStale: true
        }).then(() => null, failure => failure)
        expect(err && err.message).to.include('became stale before the first transaction was signed')
        expect(err.message).to.include('Nothing was sent')
    })

    it('refuses stale unstake state before reading validators or sending', async function () {
        const fixture = makeUnstakeSdk(true)
        const deps = {
            settings: { enabled: true, pubkey: PUBKEY, network: 'testnet', P2P_PORT: 10002 },
            wallets: { NETWORK: 'testnet', STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
            makeSdk: () => fixture.sdk,
            sdk: {},
            log: () => {}
        }
        const err = await unstakeValidator({ broadcast: true }, deps).then(() => null, failure => failure)
        expect(err && err.message).to.include('behind the chain for TBTC')
        expect(fixture.explorer.getValidators.called).to.be.false
        expect(fixture.submitted).to.have.length(0)
    })

    it('backstops a normal UNSTAKE submit with strict freshness', async function () {
        const { result, submitted } = await runUnstake(false, { broadcast: true })
        expect(result.unstaked).to.be.true
        expect(submitted).to.have.length(1)
        expect(submitted[0].opts.strictFreshness).to.be.true
    })
})
