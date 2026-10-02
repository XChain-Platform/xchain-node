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

// The hub and a regtest indexer must arm fold, stake and slash at the same
// heights; shared-ledger indexers must never see a regtest arm.

const { expect, makeServiceWithConfig } = require('../config_service.test/helpers.test')

const VARS = [
    'XC_ANCHOR_FOLD_REGTEST_ACTIVATION',
    'XC_ANCHOR_STAKE_REGTEST_ACTIVATION',
    'XC_ANCHOR_SLASH_REGTEST_ACTIVATION'
]
const VALUES = { [VARS[0]]: '0', [VARS[1]]: '12', [VARS[2]]: '14' }

describe('anchor arm passthrough', function () {
    let saved

    beforeEach(function () {
        saved = {}
        for (const name of VARS) { saved[name] = process.env[name]; process.env[name] = VALUES[name] }
    })

    afterEach(function () {
        for (const name of VARS) {
            if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]
        }
    })

    it('hands the hub and a regtest indexer the same three values', async function () {
        const cs = makeServiceWithConfig('')
        const hub = await cs.getDefaultConfig('xchain-hub', null, null)
        const indexer = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', 'regtest')
        for (const name of VARS) {
            expect(hub[name], `hub ${name}`).to.equal(VALUES[name])
            expect(indexer[name], `indexer ${name}`).to.equal(VALUES[name])
        }
    })

    it('never hands a shared-ledger indexer any of them', async function () {
        const cs = makeServiceWithConfig('')
        for (const net of ['mainnet', 'testnet']) {
            const config = await cs.getDefaultConfig('xchain-indexer', 'dogecoin', net)
            for (const name of VARS) expect(config, `${net} ${name}`).to.not.have.property(name)
        }
    })
})
