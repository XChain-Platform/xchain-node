'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')

const {
    ARM_ENV_NAMES,
    publisherFundingPlan,
    fundPublisher,
    main,
} = require('../../../scripts/rail_fund_publisher')

const WALLET = {
    network: 'regtest',
    dogeAddress: 'nZpublisherAddress',
}

function planFor (env, wallet = WALLET) {
    return publisherFundingPlan({
        env,
        wallet,
        minerPort: 3125,
        amount: 100,
    })
}

function recordingPost () {
    const calls = []
    return {
        calls,
        post: async (...args) => {
            calls.push(args)
            return { data: { result: 'ok' } }
        },
    }
}

describe('rail publisher funding plan', function () {
    it('does nothing when no anchor arm is set', async function () {
        expect(planFor({})).to.equal(null)
        let reads = 0
        const result = await main({
            env: {},
            readWallets: () => { reads += 1 },
            readFileSync: () => { reads += 1 },
            post: () => { reads += 1 },
        })
        expect(result).to.equal(null)
        expect(reads).to.equal(0)
    })

    for (const arm of ARM_ENV_NAMES) {
        it('funds and mines when only ' + arm + ' is set', async function () {
            const plan = planFor({ [arm]: '42' })
            expect(plan).to.deep.equal({
                address: WALLET.dogeAddress,
                amount: 100,
                minerUrl: 'http://127.0.0.1:3125',
            })

            const request = recordingPost()
            await fundPublisher(plan, { post: request.post })
            expect(request.calls).to.have.length(2)
            expect(request.calls[0]).to.deep.equal([
                plan.minerUrl,
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'send_funds',
                    params: { address: WALLET.dogeAddress, amount: 100 },
                },
            ])
            expect(request.calls[1]).to.deep.equal([
                plan.minerUrl,
                {
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'generate_blocks',
                    params: { count: 1 },
                },
            ])
        })
    }

    it('rejects a non-regtest wallet and names its network field', function () {
        expect(() => planFor({ [ARM_ENV_NAMES[0]]: '42' }, {
            network: 'mainnet',
            dogeAddress: WALLET.dogeAddress,
        })).to.throw('wallet.network')
    })

    it('rejects a missing publisher address and names its field', function () {
        expect(() => planFor({ [ARM_ENV_NAMES[0]]: '42' }, {
            network: 'regtest',
        })).to.throw('wallet.dogeAddress')
    })
})

describe('rail publisher funding execution', function () {
    it('rejects a failing send_funds call by method and does not mine', async function () {
        const methods = []
        let message
        try {
            await fundPublisher(planFor({ [ARM_ENV_NAMES[0]]: '42' }), {
                post: async (url, body) => {
                    methods.push(body.method)
                    throw new Error('miner unavailable')
                },
            })
        } catch (error) {
            message = error.message
        }
        expect(message).to.include('send_funds')
        expect(methods).to.deep.equal(['send_funds'])
    })

    it('treats JSON-RPC errors as a method failure', async function () {
        let message
        try {
            await fundPublisher(planFor({ [ARM_ENV_NAMES[0]]: '42' }), {
                post: async () => ({ data: { error: { message: 'rejected' } } }),
            })
        } catch (error) {
            message = error.message
        }
        expect(message).to.include('send_funds')
        expect(message).to.include('rejected')
    })

    it('uses only public wallet information and never exposes a WIF', async function () {
        const secret = 'cVprivateWifMustNotAppear'
        const request = recordingPost()
        const result = await main({
            env: { [ARM_ENV_NAMES[0]]: '42' },
            readWallets: () => ({
                NETWORK: 'regtest',
                DOGE_ADDRESS: WALLET.dogeAddress,
                DOGE_WIF_SECRET: secret,
            }),
            readFileSync: () => 'REGTEST_MINER_PORT=3125\n',
            post: request.post,
        })
        const observable = JSON.stringify({ result, calls: request.calls })
        expect(observable).to.not.include(secret)
        expect(request.calls[0][1].params.address).to.equal(WALLET.dogeAddress)
    })
})
