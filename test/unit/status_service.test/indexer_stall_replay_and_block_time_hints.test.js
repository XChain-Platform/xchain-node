'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs')
const path = require('path')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const INDEXER_DIR = path.join(__dirname, '../../../../xchain-indexer')
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'
const StatusService = proxyquire('../../../src/services/status_service', {
    './docker_service': { getStatusFromContainer: async () => { throw new Error('not used') } },
    './version_service': {
        checkRemoteNodeVersion: async () => {}, getLocalNodeVersion: async () => '0', getContainerNodeVersion: async () => '0',
        getLocalModuleVersion: async () => '0', getContainerModuleVersion: async () => '0'
    }
})

const { reduceIndexerStall, describeIndexerStallNote } = StatusService

describe('StatusService: replay and decoder-time stall hints', function () {
    for (const reason of ['retroactive_replay', 'decoder_block_time_unavailable']) {
        it('prints a specific remedy for ' + reason, function () {
            const stall = reduceIndexerStall({ stallReason: reason, stallClass: 'barrier_defer' })
            expect(stall).to.include({ stalled: true, word: reason })
            const note = describeIndexerStallNote('bitcoin', 'mainnet', stall)
            expect(note).to.not.include('has no specific remedy for this stall')
            expect(note).to.include('xchain-node logs xchain-indexer bitcoin mainnet')
            if (reason === 'decoder_block_time_unavailable') expect(note).to.include('xchain-decoder')
        })
    }

    it('keys both hints on reasons the sibling indexer still raises', function () {
        if (!fs.existsSync(INDEXER_DIR)) {
            if (REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-indexer is not checked out at ' + INDEXER_DIR)
            return this.skip()
        }
        const startup = fs.readFileSync(path.join(INDEXER_DIR, 'src/XChainIndexer/startup.js'), 'utf8')
        const blockParse = fs.readFileSync(path.join(INDEXER_DIR, 'src/XChainIndexer/block_parse.js'), 'utf8')
        expect(startup).to.include("'retroactive_replay'")
        expect(blockParse).to.include("'decoder_block_time_unavailable'")
    })
})
