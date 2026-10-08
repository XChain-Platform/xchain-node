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
const { XChainService } = require('../../src/config')
const { configuredDatabaseName } = require('../../src/utils/module_database_name')

const DEFAULT_DECODER = 'XChain_BTC_Mainnet_Decoder'
const DEFAULT_INDEXER = 'XChain_BTC_Mainnet_Indexer'

describe('configuredDatabaseName()', function () {
    it('uses the configured decoder name over the derived default', function () {
        const cfg = { DECODER_DB_NAME: 'CustomDecoder', INDEXER_DB_NAME: 'CustomIndexer' }
        expect(configuredDatabaseName(XChainService.XCHAIN_DECODER, cfg, DEFAULT_DECODER)).to.equal('CustomDecoder')
    })

    it('uses the configured indexer name over the derived default', function () {
        const cfg = { DECODER_DB_NAME: 'CustomDecoder', INDEXER_DB_NAME: ' CustomIndexer ' }
        expect(configuredDatabaseName(XChainService.XCHAIN_INDEXER, cfg, DEFAULT_INDEXER)).to.equal('CustomIndexer')
    })

    it('falls back to the derived default when the key is missing, blank or not a string', function () {
        for (const cfg of [{}, { DECODER_DB_NAME: '' }, { DECODER_DB_NAME: '   ' }, { DECODER_DB_NAME: 7 }, null]) {
            expect(configuredDatabaseName(XChainService.XCHAIN_DECODER, cfg, DEFAULT_DECODER)).to.equal(DEFAULT_DECODER)
        }
    })

    it('ignores database keys for a module that has no database of its own', function () {
        const cfg = { DECODER_DB_NAME: 'CustomDecoder', INDEXER_DB_NAME: 'CustomIndexer' }
        expect(configuredDatabaseName(XChainService.XCHAIN_ENCODER, cfg, 'derived')).to.equal('derived')
    })

    it('refuses an unsafe configured name instead of handing it to SQL', function () {
        const cfg = { INDEXER_DB_NAME: 'Custom; DROP DATABASE mysql' }
        expect(() => configuredDatabaseName(XChainService.XCHAIN_INDEXER, cfg, DEFAULT_INDEXER))
            .to.throw(/Unsafe MariaDB database name/)
    })
})
