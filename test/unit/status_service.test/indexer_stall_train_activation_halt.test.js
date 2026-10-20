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
    './docker_service':  { getStatusFromContainer: async () => { throw new Error('not used') } },
    './version_service': {
        checkRemoteNodeVersion: async () => {}, getLocalNodeVersion: async () => '0', getContainerNodeVersion: async () => '0',
        getLocalModuleVersion: async () => '0', getContainerModuleVersion: async () => '0'
    }
})
const { reduceIndexerStall, describeIndexerStallNote } = StatusService

describe('StatusService: train_activation_halt stall class', function () {

    const payload = {
        status: 'healthy',
        lag: 3,
        degraded: true,
        stallClass: 'train_activation_halt',
        stallReason: 'train_activation_halt: rule set 3 required at 900'
    }

    it('reduces the payload to a named stall', function () {
        expect(reduceIndexerStall(payload)).to.include({
            stalled: true,
            word: 'train_activation_halt',
            stall_class: 'train_activation_halt'
        })
    })

    it('names the indexer update command in the note', function () {
        const note = describeIndexerStallNote('bitcoin', 'mainnet', reduceIndexerStall(payload))
        expect(note).to.include('xchain-node update xchain-indexer bitcoin mainnet')
    })

    // The hint is keyed on the indexer's halt prefix minus its colon; a rename there must fail here, not fall to the generic line.
    it('keys the halt hint on the prefix the indexer writes the reason with', function () {
        if (!fs.existsSync(INDEXER_DIR)) {
            if (REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but xchain-indexer is not checked out at ' + INDEXER_DIR)
            return this.skip()      // sibling repo not checked out
        }
        const { TRAIN_ACTIVATION_HALT_PREFIX } = require(path.join(INDEXER_DIR, 'src/XChainIndexer/stall_health.js'))
        expect(TRAIN_ACTIVATION_HALT_PREFIX.endsWith(':')).to.equal(true)
        const word = TRAIN_ACTIVATION_HALT_PREFIX.slice(0, -1)
        const stall = reduceIndexerStall({ stallReason: TRAIN_ACTIVATION_HALT_PREFIX + ' rule set 3 required at 900', stallClass: word })
        expect(stall).to.include({ stalled: true, word })
        const note = describeIndexerStallNote('bitcoin', 'mainnet', stall)
        expect(note).to.include('names a rule set this build does not implement')
        expect(note).to.not.include('has no specific remedy for this stall')
    })
})
