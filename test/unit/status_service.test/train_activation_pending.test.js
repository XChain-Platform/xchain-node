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
const { reduceIndexerStall, describeIndexerStallNote,
    reduceTrainActivationPending, describeTrainActivationPendingNote } = StatusService

const HALT_PAYLOAD = {
    status: 'healthy',
    lag: 3,
    degraded: true,
    stallClass: 'train_activation_halt',
    stallReason: 'train_activation_halt: rule set 3 required at 900'
}

describe('StatusService: pending train activation and halt guidance', function () {

    it('reduces pending activation data and writes an actionable note', function () {
        const finding = reduceTrainActivationPending({ train_activation: {
            status: 'pending', required_rule_set: '3.0.0', required_at_height: 900, reason: 'x'
        } })
        expect(finding).to.deep.equal({
            pending: true, required_rule_set: '3.0.0', required_at_height: 900, reason: 'x'
        })
        const note = describeTrainActivationPendingNote('bitcoin', 'mainnet', finding)
        expect(note).to.include('3.0.0')
        expect(note).to.include('900')
        expect(note).to.include('xchain-node update xchain-indexer bitcoin mainnet')
    })

    it('does not reduce non-pending or malformed activation data', function () {
        for (const train_activation of [{ status: 'clear' }, { status: 'halt' },
            { status: 'unevaluated' }, null, 'pending'])
            expect(reduceTrainActivationPending({ train_activation })).to.equal(null)
        expect(reduceTrainActivationPending({})).to.equal(null)
    })

    it('branches halt guidance on whether the gate named a required rule set', function () {
        const named = reduceIndexerStall({ ...HALT_PAYLOAD,
            train_activation: { status: 'halt', required_rule_set: '3.0.0' } })
        const namedNote = describeIndexerStallNote('bitcoin', 'mainnet', named)
        expect(namedNote).to.include('3.0.0')
        expect(namedNote).to.include('xchain-node update xchain-indexer bitcoin mainnet')

        for (const reason of ['train_activation_halt: train_activation: the release manifest carries a trainActivation block this build cannot read',
            'train_activation_halt: train_activation: the activation gate itself failed to evaluate']) {
            const unknown = reduceIndexerStall({ stallClass: 'train_activation_halt', stallReason: reason,
                train_activation: { status: 'halt', required_rule_set: null } })
            const note = describeIndexerStallNote('bitcoin', 'mainnet', unknown)
            expect(note).to.not.include('xchain-node update')
            expect(note).to.include('xchain-node logs xchain-indexer bitcoin mainnet')
        }
    })
})
