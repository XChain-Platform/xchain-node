'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The ROLLCALL wiring guard's two predicates: which deploys read roll calls
// at all, and what counts as a DOGE read being wired. A BTC testnet indexer
// stood up with no DOGE read looped ROLLCALL PROOF UNAVAILABLE from its first
// epoch close while every container read healthy; these pin the scope.

const { expect } = require('chai')

const { rollcallNetworkFor, dogeReadWired } = require('../../../src/services/rollcall_wiring')

const INDEXER = 'xchain-indexer'
const HUB     = 'xchain-hub'

describe('ROLLCALL wiring guard: which deploys read roll calls', function () {

    it('a BTC indexer, on the network it is deployed to', () => {
        expect(rollcallNetworkFor(INDEXER, 'bitcoin', 'testnet', {})).to.equal('testnet')
        expect(rollcallNetworkFor(INDEXER, 'bitcoin', 'Mainnet', {})).to.equal('mainnet')
    })

    it('never an LTC or DOGE indexer', () => {
        expect(rollcallNetworkFor(INDEXER, 'litecoin', 'testnet', {})).to.equal(null)
        expect(rollcallNetworkFor(INDEXER, 'dogecoin', 'mainnet', {})).to.equal(null)
    })

    it('a hub only in validator mode, keyed on its HUB_NETWORK', () => {
        expect(rollcallNetworkFor(HUB, null, null, { P2P_VALIDATOR_ADDR: 'h:1', HUB_NETWORK: 'Testnet' })).to.equal('testnet')
        expect(rollcallNetworkFor(HUB, null, null, { HUB_NETWORK: 'testnet' })).to.equal(null)
        expect(rollcallNetworkFor(HUB, null, null, { P2P_VALIDATOR_ADDR: 'h:1' })).to.equal(null)
    })

    it('no other module, and nothing without a coin or network', () => {
        expect(rollcallNetworkFor('xchain-decoder', 'bitcoin', 'testnet', {})).to.equal(null)
        expect(rollcallNetworkFor(INDEXER, 'bitcoin', null, {})).to.equal(null)
        expect(rollcallNetworkFor(INDEXER, null, 'testnet', null)).to.equal(null)
    })
})

describe('ROLLCALL wiring guard: what counts as wired', function () {

    it('either spelling of the URL, set and non-blank, in the env about to be written', () => {
        expect(dogeReadWired({ DOGE_INDEXER_API_URL: 'http://doge:3004' })).to.equal(true)
        expect(dogeReadWired({ DOGE_INDEXER_URL: 'http://doge:3004' })).to.equal(true)
    })

    it('not a blank URL, not the key alone, not a missing env', () => {
        expect(dogeReadWired({ DOGE_INDEXER_API_URL: '   ' })).to.equal(false)
        expect(dogeReadWired({ DOGE_INDEXER_API_KEY: 'k' })).to.equal(false)
        expect(dogeReadWired({})).to.equal(false)
        expect(dogeReadWired(null)).to.equal(false)
    })
})
