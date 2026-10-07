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

// The key the stake CLI reads the explorer tip under. The explorer's /status
// keys last_block by route code (BTC/TBTC/RBTC), never by the SDK network name,
// and the stake fakes build their status from coins.stakeCoin, so this pins
// that code to what the SDK itself routes to.

const { expect } = require('chai')
const { XChainSDK } = require('@dankest-llc/xchain-sdk')

const { COIN_NETWORKS } = require('../../../src/services/validator_service')
const { readAnsweredCapabilitySets } = require('../../../src/services/validator_service/capability_drift')

describe('explorer tip key', function () {
    for (const [network, coins] of Object.entries(COIN_NETWORKS)) {
        it(`keys the ${network} stake tip by the explorer route code the SDK uses`, function () {
            expect(coins.stakeCoin).to.equal(new XChainSDK({ network: coins.stake }).explorer.coin)
            expect(coins.stakeCoin).to.not.equal(coins.stake)
        })
    }

    it('cannot read a tip keyed by the SDK network name', async function () {
        const sdk = { explorer: {
            getCapabilityValidators: async () => ({ validators: [] }),
            getStatus: async () => ({ last_block: { 'bitcoin-testnet': 200000 } })
        } }
        const r = await readAnsweredCapabilitySets('ab'.repeat(32), 'testnet', ['price'], { sdk: { XChainSDK }, makeSdk: () => sdk })
        expect(r.unavailable).to.equal(true)
        expect(r.reason).to.match(/no last block for TBTC/)
    })
})
