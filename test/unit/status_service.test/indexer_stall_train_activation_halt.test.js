'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

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
})
