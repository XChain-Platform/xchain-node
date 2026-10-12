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
const sinon = require('sinon')

const { stakeValidator, unstakeValidator } = require('../../../src/services/validator_stake_service')
const { PUBKEY, ADDRESS, makeSdk, run } = require('../../helpers/stake_harness')

// Deps whose every reach past the pubkey check is recorded: the WIF read and the SDK build.
function guardedDeps(pubkey) {
    const touched = { wif: 0 }
    const wallets = { NETWORK: 'testnet', STAKE_ADDRESS: ADDRESS }
    Object.defineProperty(wallets, 'STAKE_WIF_SECRET', { get() { touched.wif++; return 'cFakeWif' } })
    const buildSdk = sinon.stub().throws(new Error('the SDK must not be built for a malformed pubkey'))
    const settings = { enabled: true, network: 'testnet', P2P_PORT: 10002 }
    if (pubkey !== undefined) settings.pubkey = pubkey
    return { touched, buildSdk, deps: { settings, wallets, makeSdk: buildSdk, sdk: {}, log: () => {} } }
}

async function rejection(promise) {
    try { await promise } catch (e) { return e }
    return null
}

describe('ValidatorStakeService', function () {
    describe('the validator signing pubkey shape', function () {

        const malformed = {
            '66 hex (a secp256k1 key pasted in)': 'ab'.repeat(33),
            '62 hex (truncated)':                 'ab'.repeat(31),
            '64 characters, not hex':             'zz'.repeat(32),
            'empty':                              '',
            'missing':                            undefined
        }

        for (const [label, pubkey] of Object.entries(malformed)) {
            it(`stake refuses a ${label} pubkey before the WIF read or any chain read`, async function () {
                const { touched, buildSdk, deps } = guardedDeps(pubkey)
                const err = await rejection(stakeValidator({}, deps))
                expect(err, 'a malformed pubkey must be refused').to.be.an('error')
                expect(err.message).to.match(/signing pubkey in validator\.json is not 64 hex characters/)
                expect(err.message).to.match(/Nothing was sent/)
                expect(touched.wif).to.equal(0)
                expect(buildSdk.called).to.equal(false)
            })
        }

        it('stake with --broadcast refuses a truncated pubkey and sends no MINT and no STAKE', async function () {
            const { sdk, calls } = makeSdk({ xchain: 0, coin: '0.001' })
            const deps = {
                settings: { enabled: true, pubkey: 'ab'.repeat(31), network: 'testnet', P2P_PORT: 10002 },
                wallets:  { NETWORK: 'testnet', STAKE_ADDRESS: ADDRESS, STAKE_WIF_SECRET: 'cFakeWif' },
                makeSdk:  () => sdk, sdk: {}, log: () => {}
            }
            const err = await rejection(stakeValidator({ broadcast: true }, deps))
            expect(err && err.message).to.match(/not 64 hex characters/)
            expect(calls.mint).to.have.length(0)
            expect(calls.stake).to.have.length(0)
            // Control: the same chain with a well-formed pubkey does mint, so the zero above is the guard.
            const control = await run({ broadcast: true }, { xchain: 0, coin: '0.001' })
            expect(control.calls.mint.length).to.be.above(0)
        })

        it('stake accepts an uppercase 64-hex pubkey and sends it lowercased', async function () {
            const { calls } = await run({ broadcast: true }, { xchain: 30000, coin: '0.001' }, { pubkey: PUBKEY.toUpperCase() })
            expect(calls.stake).to.have.length(1)
            expect(calls.stake[0].params.SIGNING_PUBKEY).to.equal(PUBKEY)
        })

        it('unstake refuses a malformed pubkey with the shape error, not "carries no valid stake"', async function () {
            const { touched, buildSdk, deps } = guardedDeps('ab'.repeat(33))
            const err = await rejection(unstakeValidator({ broadcast: true }, deps))
            expect(err && err.message).to.match(/not 64 hex characters/)
            expect(err.message).to.not.match(/carries no valid stake/)
            expect(touched.wif).to.equal(0)
            expect(buildSdk.called).to.equal(false)
        })
    })
})
