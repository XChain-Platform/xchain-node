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
const fs = require('fs')
const { SHARED_REGTEST_GATE_ARMS } = require('../../../src/config/regtest_gate_arms')

// The regtest-only passthrough. Gate arms and operational overrides must reach
// a regtest indexer, while mainnet and testnet indexers must never inherit them.
function regtestOnlyPassthrough() {
    const REGTEST_ONLY = [
        ...SHARED_REGTEST_GATE_ARMS,
        'HUB_SYNC_ANCHOR_ATTEST_GRACE_S',
        'HUB_PRICE_SYNC_TIMEOUT_MS',
        'XCHAIN_COINPAY_EXPIRATION_S',
        'EXACT_INTEGER_WIRE_FIELDS_REGTEST_TIME'
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

    it('covers every ENV_READERS key in a sibling indexer checkout', function () {
        const repoRoot = path.resolve(__dirname, '../../..')
        const indexerDir = process.env.XCHAIN_INDEXER_DIR || path.resolve(repoRoot, '../xchain-indexer')
        const sharedRows = path.join(indexerDir, 'src/protocol_changes/shared_rows.js')
        if (!fs.existsSync(sharedRows)) {
            this.test.title += ' [skipped: no sibling indexer checkout or XCHAIN_INDEXER_DIR]'
            this.skip()
        }

        const source = fs.readFileSync(sharedRows, 'utf8')
        const readers = source.match(/const ENV_READERS = \{([\s\S]*?)\n\};/)
        expect(readers, 'ENV_READERS declaration').to.not.equal(null)
        const keys = [...readers[1].matchAll(/^\s*(XC_[A-Z0-9_]+)\s*:/gm)].map((match) => match[1])
        expect(keys, 'ENV_READERS keys').to.not.be.empty
        expect(SHARED_REGTEST_GATE_ARMS).to.include.members(keys)
    })

}

describe('ConfigService', function () {
    describe('getDefaultConfig()', function () {
        describe('regtest-only env passthrough to the indexer', regtestOnlyPassthrough)
    })
})
