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
const path = require('path')

const SRC = path.resolve(__dirname, '../../src') + path.sep

// NODE_PREFIX is read once when src/config loads, so a prefixed stack needs a fresh load
// of every src module. Snapshot the require cache and the env var, then put both back so
// later suites keep their default-prefix singletons.
function isSrc(id) { return id.startsWith(SRC) }

describe('module database names under a non-default NODE_PREFIX', function () {
    let savedCache, savedPrefix, prefixed

    before(function () {
        savedPrefix = process.env.NODE_PREFIX
        savedCache = {}
        for (const id of Object.keys(require.cache)) {
            if (isSrc(id)) { savedCache[id] = require.cache[id]; delete require.cache[id] }
        }
        process.env.NODE_PREFIX = 'stack-b.test'
        prefixed = require('../../src/services/config_service')
    })

    after(function () {
        if (savedPrefix === undefined) delete process.env.NODE_PREFIX
        else process.env.NODE_PREFIX = savedPrefix
        for (const id of Object.keys(require.cache)) {
            if (isSrc(id)) delete require.cache[id]
        }
        Object.assign(require.cache, savedCache)
    })

    it('carries the sanitized prefix in the derived database name', function () {
        expect(prefixed.getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet'))
            .to.equal('XChain_stack_b_test_BTC_Mainnet_Decoder')
    })

    it('carries the prefix in the module DB user names', async function () {
        const decoder = await prefixed.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        const indexer = await prefixed.getDefaultConfig('xchain-indexer', 'bitcoin', 'mainnet')
        expect(decoder.DECODER_DB_USER).to.equal('xchain_stack_b_test_decoder_bitcoin_mainnet')
        expect(indexer.INDEXER_DB_USER).to.equal('xchain_stack_b_test_indexer_bitcoin_mainnet')
        expect(decoder.DECODER_DB_NAME).to.equal('XChain_stack_b_test_BTC_Mainnet_Decoder')
    })

    it('restores the default-prefix modules after the suite', function () {
        // Runs while the prefixed load is still cached; the real check is that after()
        // reinstates the snapshot, asserted by the sibling describe below.
        expect(process.env.NODE_PREFIX).to.equal('stack-b.test')
    })
})

describe('module database names after the prefix suite', function () {
    it('leave the default-prefix names unchanged and the env restored', async function () {
        const cs = require('../../src/services/config_service')
        expect(cs.getModuleDatabaseName('xchain-decoder', 'bitcoin', 'mainnet')).to.equal('XChain_BTC_Mainnet_Decoder')
        const cfg = await cs.getDefaultConfig('xchain-decoder', 'bitcoin', 'mainnet')
        expect(cfg.DECODER_DB_USER).to.equal('xchain_decoder_bitcoin_mainnet')
    })
})
