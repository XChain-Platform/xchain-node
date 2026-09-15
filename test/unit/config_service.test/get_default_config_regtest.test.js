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


const {
    sinon, configStub, expect, proxyquire, path,
    NODE_PREFIX, SEP, DB_SEP, NODE_MODULE_NAME, DB_MODULE_NAME,
    HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME, Coin, Network,
    XChainService, CoinTickerSymbol, REGTEST_MODULES, moduleDir, tmpDir,
    cryptoNodesDir, dataDir, configDir, NO_VALIDATOR, makeConfigService,
    streamFromString, makeServiceWithConfig, makeMemoryConfigService, CONTAINER_ID, coinSidecar,
    coinMain, hubSidecar
} = require('./helpers.test')

// The regtest-only passthrough. Every name here is a value a host env var must
// never carry onto a shared ledger: three are consensus inputs where a per-node
// value forks settlement, and the fourth only shapes how much a failed barrier
// attempt costs. This gate is one of TWO independent ones (the indexer refuses
// the same vars again on its own side), and neither had a test, while the list
// is edited by whoever needs the next knob.
function regtestOnlyPassthrough() {
    const REGTEST_ONLY = [
        'XC_ROLLCALL_REGTEST_ACTIVATION',
        'XC_ROLLCALL_GATES_REGTEST_ACTIVATION',
        'HUB_SYNC_ANCHOR_ATTEST_GRACE_S',
        'HUB_PRICE_SYNC_TIMEOUT_MS',
        'XCHAIN_COINPAY_EXPIRATION_S'
    ]

    let saved
    beforeEach(function () {
        saved = {}
        for (const k of REGTEST_ONLY) { saved[k] = process.env[k]; process.env[k] = '1234' }
    })
    afterEach(function () {
        for (const k of REGTEST_ONLY) {
            if (saved[k] === undefined) delete process.env[k]
            else process.env[k] = saved[k]
        }
    })

    it('carries every regtest-only var onto a regtest indexer', async function () {
        const cs = makeServiceWithConfig('')
        const config = await cs.getDefaultConfig(XChainService.XCHAIN_INDEXER, 'bitcoin', 'regtest')
        for (const k of REGTEST_ONLY) expect(config[k], k).to.equal('1234')
    })

    for (const net of ['mainnet', 'testnet']) {
        it('carries none of them onto ' + net + ', so a host variable cannot reach a shared ledger', async function () {
            const cs = makeServiceWithConfig('')
            const config = await cs.getDefaultConfig(XChainService.XCHAIN_INDEXER, 'bitcoin', net)
            for (const k of REGTEST_ONLY) expect(config, k).to.not.have.property(k)
        })
    }

}

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('regtest-only env passthrough to the indexer', regtestOnlyPassthrough)
    })
})
