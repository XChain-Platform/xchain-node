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

const { XChainService }         = require('../../src/config/constants')
const { getDockerNetwork }      = require('../../src/services/ConfigService')
const { crossChainNetworksFor } = require('../../src/services/ModuleService')

// crossChainNetworksFor decides which sibling-coin docker networks an indexer
// container joins at create time. The stakes: a BTC indexer that cannot resolve
// its DOGE sibling by container name stalls the ROLLCALL epoch close (and the
// ANCHOR reward rail) while reporting healthy, and a hand-applied
// `docker network connect` dies with the container at the next update or
// recreate. These tests pin the membership rules; the docker side reuses
// addContainerToNetwork, which has its own coverage.
describe('crossChainNetworksFor', function () {

    const installed = {
        bitcoin:  ['regtest'],
        dogecoin: ['regtest', 'testnet'],
        litecoin: ['testnet']
    }

    it('joins an indexer to every installed sibling coin on the SAME network tier', function () {
        const networks = crossChainNetworksFor(XChainService.XCHAIN_INDEXER, 'bitcoin', 'regtest', installed)
        expect(networks).to.deep.equal([getDockerNetwork('dogecoin', 'regtest')])
    })

    it('never crosses network tiers: a testnet sibling is invisible to a regtest indexer', function () {
        // litecoin is installed, but only its testnet stack; the regtest indexer
        // must not join it.
        const networks = crossChainNetworksFor(XChainService.XCHAIN_INDEXER, 'bitcoin', 'regtest', installed)
        expect(networks).to.not.include(getDockerNetwork('litecoin', 'testnet'))
        expect(networks).to.not.include(getDockerNetwork('litecoin', 'regtest'))
    })

    it('excludes the container\'s own coin network (docker run already provides it)', function () {
        const networks = crossChainNetworksFor(XChainService.XCHAIN_INDEXER, 'dogecoin', 'regtest', installed)
        expect(networks).to.deep.equal([getDockerNetwork('bitcoin', 'regtest')])
    })

    it('returns all same-tier siblings, sorted, when several are installed', function () {
        const both = {
            bitcoin:  ['testnet'],
            dogecoin: ['testnet'],
            litecoin: ['testnet']
        }
        const networks = crossChainNetworksFor(XChainService.XCHAIN_INDEXER, 'bitcoin', 'testnet', both)
        const expected = [
            getDockerNetwork('dogecoin', 'testnet'),
            getDockerNetwork('litecoin', 'testnet')
        ].sort()
        expect(networks).to.deep.equal(expected)
    })

    it('applies to the indexer only: every other module gets no extra networks', function () {
        for (const module of [XChainService.XCHAIN_DECODER, XChainService.XCHAIN_ENCODER,
                              XChainService.XCHAIN_UTXO_TRACKER, 'xchain-hub', 'xchain-sync']) {
            expect(crossChainNetworksFor(module, 'bitcoin', 'regtest', installed),
                module + ' must not gain cross-chain networks').to.deep.equal([])
        }
    })

    it('is inert without a coin/network context (shared or one-shot containers)', function () {
        expect(crossChainNetworksFor(XChainService.XCHAIN_INDEXER, null, null, installed)).to.deep.equal([])
        expect(crossChainNetworksFor(XChainService.XCHAIN_INDEXER, 'bitcoin', null, installed)).to.deep.equal([])
        expect(crossChainNetworksFor(XChainService.XCHAIN_INDEXER, null, 'regtest', installed)).to.deep.equal([])
    })

    it('is inert against a missing or empty installed map', function () {
        expect(crossChainNetworksFor(XChainService.XCHAIN_INDEXER, 'bitcoin', 'regtest', undefined)).to.deep.equal([])
        expect(crossChainNetworksFor(XChainService.XCHAIN_INDEXER, 'bitcoin', 'regtest', {})).to.deep.equal([])
    })

    it('derives names through getDockerNetwork, so a NODE_PREFIX override follows automatically', function () {
        // Equality against getDockerNetwork's live output (not a hardcoded
        // prefix) is the assertion everywhere above; this test states the rule
        // explicitly so a hand-built name never sneaks in.
        const networks = crossChainNetworksFor(XChainService.XCHAIN_INDEXER, 'bitcoin', 'regtest', installed)
        for (const name of networks) {
            expect(name).to.equal(getDockerNetwork('dogecoin', 'regtest'))
        }
    })
})
