'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')

const {
    clearChainFenceSql,
    clearNetworkFenceSql,
    manualClearStatement
} = require('../../../src/db/price_fence')

describe('price fence SQL builders', () => {
    it('builds the chain-wide fence clear', () => {
        expect(clearChainFenceSql('xchain_hub', 'DOGE')).to.equal(
            "DELETE FROM `xchain_hub`.price_ingest_watermarks WHERE source_chain = 'DOGE'"
        )
    })

    it('builds the network-scoped fence clear with the legacy bucket', () => {
        expect(clearNetworkFenceSql('xchain_hub', 'DOGE', 'dogecoin-mainnet')).to.equal(
            "DELETE FROM `xchain_hub`.price_ingest_watermarks WHERE source_chain = 'DOGE' AND network IN ('dogecoin-mainnet', '')"
        )
    })

    it('builds the manual network-scoped fence clear', () => {
        expect(manualClearStatement('DOGE', 'dogecoin-mainnet')).to.equal(
            "DELETE FROM price_ingest_watermarks WHERE source_chain = 'DOGE' AND network IN ('dogecoin-mainnet', '');"
        )
    })

    it('escapes embedded quotes in the chain ticker', () => {
        expect(clearChainFenceSql('xchain_hub', "O'BRIEN")).to.equal(
            "DELETE FROM `xchain_hub`.price_ingest_watermarks WHERE source_chain = 'O\\'BRIEN'"
        )
    })
})
