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

const sinon = require('sinon')
const { expect } = require('chai')

const { HUB_PASSTHROUGH_VARS } = require('../../../src/services/config_service/networks')
const { HUB_PASSTHROUGH_ENV } = require('../../../src/config')
const {
    SHARED_REGTEST_GATE_ARMS, HUB_ONLY_REGTEST_GATE_ARMS
} = require('../../../src/config/regtest_gate_arms')
const {
    CONSENSUS_ENV_KEYS,
    isConsensusEnvKeyHonoredOn,
    consensusEnvKeysForNetwork,
    describeConsensusEnvSupply,
    findHubConsensusEnvDrift,
    assertNoHubConsensusEnvDrift,
    isHubConsensusEnvDriftError
} = require('../../../src/services/hub_consensus_env_guard')

const ROUND_CADENCE_KEYS = ['ORACLE_ROUND_INTERVAL', 'ORACLE_SUBMISSION_WINDOW']
const CHECKPOINT_CADENCE_KEYS = ['CHECKPOINT_INTERVAL_BLOCKS', 'ANCHOR_CHECKPOINT_EVERY_N', 'ANCHOR_ELECTION_TOLERANCE_BLOCKS']
const ARM_KEYS = HUB_PASSTHROUGH_VARS.filter(name => /^XC_[A-Z0-9_]+_(ACTIVATION|TIME)$/.test(name))

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

function registerNetworkGateArmTests() {
        it('finds the regtest arm names in the passthrough list', () => {
            expect(ARM_KEYS.length).to.be.greaterThan(0)
            expect(ARM_KEYS).to.deep.equal([...SHARED_REGTEST_GATE_ARMS, ...HUB_ONLY_REGTEST_GATE_ARMS])
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

        it('refuses through the assert path when a carried time arm is dropped', async () => {
            const key = 'XC_LISTS_MARKET_REGTEST_TIME'
            let thrown = null
            try {
                await assertNoHubConsensusEnvDrift(
                    { HUB_NETWORK: 'regtest' },
                    { execFileAsync: inspectStub({ HUB_NETWORK: 'regtest', [key]: '1700000000' }), env: {} }
                )
            } catch (err) { thrown = err }
            expect(isHubConsensusEnvDriftError(thrown)).to.equal(true)
            expect(thrown.drift).to.deep.equal([{ key }])
        })
}

function registerNetworkCadenceTests() {
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
}

function registerNetworkGatedContract() {
    describe('network-gated consensus keys', function networkGatedContract() {
        registerNetworkGateArmTests()
        registerNetworkCadenceTests()
    })
}

const ATTEST_TIMING_KEYS = ['ATTEST_RESPONSE_FORWARD_S_OVERRIDE', 'ATTEST_BATCH_WINDOW_S_OVERRIDE']

function inspectStub(env) {
    const rows = Object.keys(env).map(k => `${k}=${env[k]}`)
    return sinon.stub().resolves({ stdout: JSON.stringify(rows) + '\n' })
}

function registerAttestTimingContract() {
    describe('attestation timing overrides', function attestTimingContract() {
        it('passes both overrides through and guards both', () => {
            for (const key of ATTEST_TIMING_KEYS) {
                expect(HUB_PASSTHROUGH_VARS, key).to.include(key)
                expect(CONSENSUS_ENV_KEYS, key).to.include(key)
            }
        })

        it('honors both on regtest and nowhere else', () => {
            for (const key of ATTEST_TIMING_KEYS) {
                expect(isConsensusEnvKeyHonoredOn(key, 'regtest'), key).to.equal(true)
                for (const network of ['mainnet', 'testnet', '']) {
                    expect(isConsensusEnvKeyHonoredOn(key, network), key + ' on ' + network).to.equal(false)
                }
            }
            expect(consensusEnvKeysForNetwork('mainnet')).to.not.include.members(ATTEST_TIMING_KEYS)
            expect(consensusEnvKeysForNetwork('regtest')).to.include.members(ATTEST_TIMING_KEYS)
        })

        it('flags a regtest recreate from a clean shell that drops either override', () => {
            const live = { HUB_NETWORK: 'regtest', ATTEST_RESPONSE_FORWARD_S_OVERRIDE: '2', ATTEST_BATCH_WINDOW_S_OVERRIDE: '30' }
            const keys = drift => drift.map(d => d.key).sort()
            expect(keys(findHubConsensusEnvDrift({ HUB_NETWORK: 'regtest' }, live))).to.deep.equal(ATTEST_TIMING_KEYS.slice().sort())
            expect(keys(findHubConsensusEnvDrift({}, live))).to.deep.equal(['ATTEST_BATCH_WINDOW_S_OVERRIDE', 'ATTEST_RESPONSE_FORWARD_S_OVERRIDE', 'HUB_NETWORK'])
            expect(findHubConsensusEnvDrift({ HUB_NETWORK: 'regtest', ...live }, live)).to.deep.equal([])
        })

        it('does not refuse dropping a stale override off regtest', () => {
            const live = { HUB_NETWORK: 'mainnet', ATTEST_RESPONSE_FORWARD_S_OVERRIDE: '2', ATTEST_BATCH_WINDOW_S_OVERRIDE: '30' }
            expect(findHubConsensusEnvDrift({ HUB_NETWORK: 'mainnet' }, live)).to.deep.equal([])
        })

        it('refuses the deploy through the assert path and names only the keys', async () => {
            const live = { HUB_NETWORK: 'regtest', ATTEST_RESPONSE_FORWARD_S_OVERRIDE: '2' }
            let thrown = null
            try {
                await assertNoHubConsensusEnvDrift({ HUB_NETWORK: 'regtest' }, { execFileAsync: inspectStub(live), env: {} })
            } catch (err) { thrown = err }
            expect(isHubConsensusEnvDriftError(thrown)).to.equal(true)
            expect(thrown.drift).to.deep.equal([{ key: 'ATTEST_RESPONSE_FORWARD_S_OVERRIDE' }])
            expect(thrown.message).to.contain('ATTEST_RESPONSE_FORWARD_S_OVERRIDE')
        })

        it('reports an unsupplied override as defaulted on regtest only', () => {
            expect(describeConsensusEnvSupply({ HUB_NETWORK: 'regtest' }).defaulted).to.include.members(ATTEST_TIMING_KEYS)
            expect(describeConsensusEnvSupply({ HUB_NETWORK: 'mainnet' }).defaulted).to.not.include.members(ATTEST_TIMING_KEYS)
        })
    })
}

function registerUnverifiedPairsContract() {
    const key = 'ORACLE_ALLOW_UNVERIFIED_PAIRS'
    describe('unverified pair override', function unverifiedPairsContract() {
        it('passes the override through and guards it on regtest only', () => {
            expect(HUB_PASSTHROUGH_VARS).to.include(key)
            expect(CONSENSUS_ENV_KEYS).to.include(key)
            expect(() => void HUB_PASSTHROUGH_ENV[key]).not.to.throw()
            expect(isConsensusEnvKeyHonoredOn(key, 'regtest')).to.equal(true)
            for (const network of ['mainnet', 'testnet', '']) {
                expect(isConsensusEnvKeyHonoredOn(key, network)).to.equal(false)
            }
        })

        it('flags a regtest drop, accepts a carried value, and ignores off-regtest drops', () => {
            const live = { HUB_NETWORK: 'regtest', [key]: 'true' }
            expect(findHubConsensusEnvDrift({ HUB_NETWORK: 'regtest' }, live)).to.deep.equal([{ key }])
            expect(findHubConsensusEnvDrift({ ...live }, live)).to.deep.equal([])
            for (const network of ['mainnet', 'testnet']) {
                expect(findHubConsensusEnvDrift(
                    { HUB_NETWORK: network }, { HUB_NETWORK: network, [key]: 'true' }
                )).to.deep.equal([])
            }
        })

        it('refuses a regtest deploy through the assert path', async () => {
            const live = { HUB_NETWORK: 'regtest', [key]: 'true' }
            let thrown = null
            try {
                await assertNoHubConsensusEnvDrift(
                    { HUB_NETWORK: 'regtest' }, { execFileAsync: inspectStub(live), env: {} }
                )
            } catch (err) { thrown = err }
            expect(isHubConsensusEnvDriftError(thrown)).to.equal(true)
            expect(thrown.drift).to.deep.equal([{ key }])
        })

        it('reports the unsupplied override as defaulted on regtest only', () => {
            expect(describeConsensusEnvSupply({ HUB_NETWORK: 'regtest' }).defaulted).to.include(key)
            expect(describeConsensusEnvSupply({ HUB_NETWORK: 'mainnet' }).defaulted).not.to.include(key)
        })
    })
}

function registerCheckpointCadenceContract() {
    describe('checkpoint cadence overrides', function checkpointCadenceContract() {
        it('passes both through and guards them on regtest only', () => {
            for (const key of CHECKPOINT_CADENCE_KEYS) {
                expect(HUB_PASSTHROUGH_VARS, key).to.include(key)
                expect(CONSENSUS_ENV_KEYS, key).to.include(key)
                expect(isConsensusEnvKeyHonoredOn(key, 'regtest'), key).to.equal(true)
                for (const network of ['mainnet', 'testnet', '']) {
                    expect(isConsensusEnvKeyHonoredOn(key, network), key + ' on ' + network).to.equal(false)
                }
            }
        })

        it('detects a regtest drop and accepts values carried forward', () => {
            const live = { HUB_NETWORK: 'regtest', CHECKPOINT_INTERVAL_BLOCKS: '2', ANCHOR_CHECKPOINT_EVERY_N: '3', ANCHOR_ELECTION_TOLERANCE_BLOCKS: '2' }
            const keys = drift => drift.map(d => d.key).sort()
            expect(keys(findHubConsensusEnvDrift({ HUB_NETWORK: 'regtest' }, live)))
                .to.deep.equal(CHECKPOINT_CADENCE_KEYS.slice().sort())
            expect(findHubConsensusEnvDrift({ ...live }, live)).to.deep.equal([])
            expect(keys(findHubConsensusEnvDrift({}, live)))
                .to.deep.equal([...CHECKPOINT_CADENCE_KEYS, 'HUB_NETWORK'].sort())
        })

        it('ignores stale values off regtest and reports regtest defaults', () => {
            for (const network of ['mainnet', 'testnet', '']) {
                const live = { CHECKPOINT_INTERVAL_BLOCKS: '2', ANCHOR_CHECKPOINT_EVERY_N: '3', ANCHOR_ELECTION_TOLERANCE_BLOCKS: '2' }
                if (network) live.HUB_NETWORK = network
                expect(findHubConsensusEnvDrift(network ? { HUB_NETWORK: network } : {}, live)).to.deep.equal([])
            }
            expect(describeConsensusEnvSupply({ HUB_NETWORK: 'regtest' }).defaulted)
                .to.include.members(CHECKPOINT_CADENCE_KEYS)
        })
    })
}

function registerSupplyProvenanceContract() {
    describe('recreate supply provenance', function supplyProvenanceContract() {
        it('separates carried settings from values supplied by the invoking shell', () => {
            const state = describeConsensusEnvSupply(
                { HUB_NETWORK: 'regtest', ORACLE_MIN_SUBMISSIONS: '1' },
                'regtest',
                ['ORACLE_MIN_SUBMISSIONS']
            )
            expect(state.supplied).to.include('HUB_NETWORK')
            expect(state.supplied).to.not.include('ORACLE_MIN_SUBMISSIONS')
            expect(state.carried).to.deep.equal(['ORACLE_MIN_SUBMISSIONS'])
            expect(state.defaulted).to.not.include('ORACLE_MIN_SUBMISSIONS')
        })
    })
}

const SNAPSHOT_SEAM_KEYS = ['XDEX_SEED_LOCAL_VALIDATOR', 'XDEX_SNAPSHOT_BLOCK']

function registerSnapshotSeamContract() {
    describe('regtest snapshot seams', function snapshotSeamContract() {
        it('guards every XDEX_ name the hub passthrough carries', () => {
            const xdex = HUB_PASSTHROUGH_VARS.filter(name => /^XDEX_/.test(name))
            expect(xdex.slice().sort()).to.deep.equal(SNAPSHOT_SEAM_KEYS.slice().sort())
            for (const key of xdex) expect(CONSENSUS_ENV_KEYS, key).to.include(key)
        })

        it('honors both on regtest and nowhere else', () => {
            for (const key of SNAPSHOT_SEAM_KEYS) {
                expect(isConsensusEnvKeyHonoredOn(key, 'regtest'), key).to.equal(true)
                for (const network of ['mainnet', 'testnet', '']) {
                    expect(isConsensusEnvKeyHonoredOn(key, network), key + ' on ' + network).to.equal(false)
                }
            }
        })

        it('flags a regtest update from a clean shell that drops either seam', () => {
            const keys = drift => drift.map(d => d.key)
            const live = { HUB_NETWORK: 'regtest', XDEX_SEED_LOCAL_VALIDATOR: '1' }
            expect(keys(findHubConsensusEnvDrift({ HUB_NETWORK: 'regtest' }, live))).to.deep.equal(['XDEX_SEED_LOCAL_VALIDATOR'])
            expect(keys(findHubConsensusEnvDrift({}, live)).sort()).to.deep.equal(['HUB_NETWORK', 'XDEX_SEED_LOCAL_VALIDATOR'])
            const anchored = { HUB_NETWORK: 'regtest', XDEX_SNAPSHOT_BLOCK: '100' }
            expect(keys(findHubConsensusEnvDrift({ HUB_NETWORK: 'regtest' }, anchored))).to.deep.equal(['XDEX_SNAPSHOT_BLOCK'])
        })

        it('accepts a deploy that carries the seam forward', () => {
            const live = { HUB_NETWORK: 'regtest', XDEX_SEED_LOCAL_VALIDATOR: '1' }
            expect(findHubConsensusEnvDrift({ ...live }, live)).to.deep.equal([])
        })

        it('does not refuse dropping a stale seam off regtest', () => {
            for (const network of ['mainnet', 'testnet']) {
                const live = { HUB_NETWORK: network, XDEX_SEED_LOCAL_VALIDATOR: '1', XDEX_SNAPSHOT_BLOCK: '100' }
                expect(findHubConsensusEnvDrift({ HUB_NETWORK: network }, live), network).to.deep.equal([])
            }
            const standalone = { XDEX_SEED_LOCAL_VALIDATOR: '1' }
            expect(findHubConsensusEnvDrift({}, standalone)).to.deep.equal([])
        })

        it('reports an unsupplied seam as defaulted on regtest only', () => {
            expect(describeConsensusEnvSupply({ HUB_NETWORK: 'regtest' }).defaulted).to.include.members(SNAPSHOT_SEAM_KEYS)
            expect(describeConsensusEnvSupply({ HUB_NETWORK: 'mainnet' }).defaulted).to.not.include.members(SNAPSHOT_SEAM_KEYS)
        })
    })
}

function hubEnvPassthroughContract() {
    registerPassthroughListContract()
    registerNetworkGatedContract()
    registerCheckpointCadenceContract()
    registerSupplyProvenanceContract()
    registerAttestTimingContract()
    registerUnverifiedPairsContract()
    registerSnapshotSeamContract()
}

describe('hub env passthrough contract', hubEnvPassthroughContract)
