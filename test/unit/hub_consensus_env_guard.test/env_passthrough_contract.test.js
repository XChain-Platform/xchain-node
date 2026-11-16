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

const { HUB_PASSTHROUGH_VARS } = require('../../../src/services/config_service/networks')
const { HUB_PASSTHROUGH_ENV } = require('../../../src/config')
const {
    CONSENSUS_ENV_KEYS,
    isConsensusEnvKeyHonoredOn,
    findHubConsensusEnvDrift
} = require('../../../src/services/hub_consensus_env_guard')

const ROUND_CADENCE_KEYS = ['ORACLE_ROUND_INTERVAL', 'ORACLE_SUBMISSION_WINDOW']
const ARM_KEYS = HUB_PASSTHROUGH_VARS.filter(name => /^XC_[A-Z_]+_ACTIVATION$/.test(name))

function registerPassthroughListContract() {
    describe('the passthrough list', function passthroughListContract() {
        it('names each variable once', () => {
            const seen = new Set()
            const repeated = HUB_PASSTHROUGH_VARS.filter(name => seen.has(name) || !seen.add(name))
            expect(repeated).to.deep.equal([])
        })

        it('is covered by the host env view except the two timing reads', () => {
            // The view throws on a read of any name it does not declare.
            const undeclared = HUB_PASSTHROUGH_VARS.filter(name => {
                try { void HUB_PASSTHROUGH_ENV[name]; return false } catch { return true }
            })
            expect(undeclared).to.deep.equal([])
        })

        it('declares both admission timing reads in the host env view', () => {
            for (const name of ['ATTESTATION_ROUND_TIMEOUT_MS', 'ADMISSION_WATERMARK_SAMPLE_MS']) {
                expect(() => void HUB_PASSTHROUGH_ENV[name]).not.to.throw()
            }
        })
    })
}

function registerNetworkGatedContract() {
    describe('network-gated consensus keys', function networkGatedContract() {
        it('finds the regtest arm names in the passthrough list', () => {
            expect(ARM_KEYS.length).to.be.greaterThan(0)
        })

        it('guards every passed-through XC_*_ACTIVATION arm on regtest only', () => {
            for (const key of ARM_KEYS) {
                expect(CONSENSUS_ENV_KEYS, key).to.include(key)
                expect(isConsensusEnvKeyHonoredOn(key, 'regtest'), key).to.equal(true)
                for (const network of ['mainnet', 'testnet', '']) {
                    expect(isConsensusEnvKeyHonoredOn(key, network), key + ' on ' + network).to.equal(false)
                }
            }
        })

        it('flags a regtest recreate that drops a gate arm the live hub carries', () => {
            for (const key of ARM_KEYS) {
                const drift = findHubConsensusEnvDrift(
                    { HUB_NETWORK: 'regtest' },
                    { HUB_NETWORK: 'regtest', [key]: '0' }
                )
                expect(drift, key).to.deep.equal([{ key }])
            }
        })

        it('does not flag a dropped gate arm the hub ignores off regtest', () => {
            for (const network of ['mainnet', 'testnet']) {
                for (const key of ARM_KEYS) {
                    expect(findHubConsensusEnvDrift(
                        { HUB_NETWORK: network }, { HUB_NETWORK: network, [key]: '0' }
                    ), key).to.deep.equal([])
                }
            }
        })

        it('honors the round cadence pair on regtest and nowhere else', () => {
            for (const key of ROUND_CADENCE_KEYS) {
                expect(isConsensusEnvKeyHonoredOn(key, 'regtest'), key).to.equal(true)
                for (const network of ['mainnet', 'testnet', '']) {
                    expect(isConsensusEnvKeyHonoredOn(key, network), key + ' on ' + network).to.equal(false)
                }
            }
        })

        it('does not refuse a recreate over a stale round cadence value off regtest', () => {
            for (const network of ['mainnet', 'testnet', '']) {
                const live = { ORACLE_ROUND_INTERVAL: '5000', ORACLE_SUBMISSION_WINDOW: '3000' }
                if (network) live.HUB_NETWORK = network
                expect(findHubConsensusEnvDrift(network ? { HUB_NETWORK: network } : {}, live)).to.deep.equal([])
            }
        })
    })
}

function hubEnvPassthroughContract() {
    registerPassthroughListContract()
    registerNetworkGatedContract()
}

describe('hub env passthrough contract', hubEnvPassthroughContract)
