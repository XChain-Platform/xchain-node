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


const { expect, makeServiceWithConfig } = require('./helpers.test')

// The fold gate is unpinned on regtest, so a deployed venue arms it only
// through the container env, and the hub and indexer must arm as a unit.
function anchorFoldPassthrough() {
    const VAR = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION'

    let saved

    beforeEach(function () {
        saved = process.env[VAR]
        delete process.env[VAR]
    })

    afterEach(function () {
        if (saved === undefined) delete process.env[VAR]; else process.env[VAR] = saved
    })

    it('carries a host value of 0 to a regtest indexer as the string 0', async function () {
        process.env[VAR] = '0'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', 'regtest')
        expect(config[VAR]).to.equal('0')
    })

    it('NEVER reaches a shared-ledger indexer, whatever the host env says', async function () {
        process.env[VAR] = '0'
        const cs = makeServiceWithConfig('')
        for (const net of ['mainnet', 'testnet']) {
            const config = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', net)
            expect(config, net).to.not.have.property(VAR)
        }
    })

    it('reaches the container hub, so the venue arms as a unit', async function () {
        process.env[VAR] = '0'
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig('xchain-hub', null, null)
        expect(config[VAR]).to.equal('0')
    })

    it('is absent from both configs when the host leaves it unset', async function () {
        const cs = makeServiceWithConfig('')
        const indexer = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', 'regtest')
        const hub = await cs.getDefaultConfig('xchain-hub', null, null)
        expect(indexer).to.not.have.property(VAR)
        expect(hub).to.not.have.property(VAR)
    })
}

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('ANCHOR fold passthrough', anchorFoldPassthrough)
    })
})
