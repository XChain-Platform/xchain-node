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

// `ps` reads the indexer's stall and the tracker's halt off their health
// surfaces and folds them into the STATUS column and the notes under the
// table, the way it already does the decoder's REORG_HALT marker. A healthy
// node beside a healthy decoder beside a stuck indexer must not print three
// green lines.

const sinon      = require('sinon')
const { configStub } = require('../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function makeContainerStatus(state = 'running') {
    return { State: { Status: state, Health: { Status: 'healthy' } }, NetworkSettings: { Ports: {} }, Config: { Labels: {} } }
}

// One installed row per module named, every container running, and the
// health probe answering `payloads[module]` for it.
function loadWithProbe(rows, payloads) {
    const installedModulesObj = {}
    let printed = ''
    const state = {
        db: {
            isReady: sinon.stub().returns(true),
            getAllModuleContainers: sinon.stub().resolves(rows)
        },
        getInstalledModules:     () => installedModulesObj,
        setInstalledModules:     sinon.stub(),
        resetInstalledModules:   () => { for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k] },
        getRemoteModuleVersions: () => ({}),
        isStatusUpdated:         () => false,
        setStatusUpdated:        sinon.stub(),
        getLastStatus:           () => null,
        setLastStatus:           sinon.stub(),
        getLastPrintedStatus:    () => printed,
        setLastPrintedStatus:    (s) => { printed = s },
        appendLastPrintedStatus: sinon.stub()
    }
    const probe = sinon.stub().callsFake(async (containerId) => payloads[containerId])
    const ss = proxyquire('../../../src/services/status_service', {
        '../config': configStub({ NODE_MODULE_NAME: 'node', SEP: '-',
            Coin:    { BITCOIN: 'bitcoin', DOGECOIN: 'dogecoin', LITECOIN: 'litecoin' },
            Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' },
            XChainService: { XCHAIN_DECODER: 'xchain-decoder', XCHAIN_INDEXER: 'xchain-indexer', XCHAIN_UTXO_TRACKER: 'xchain-utxo-tracker' } }),
        '../state': state,
        './docker_service':  { getStatusFromContainer: sinon.stub().resolves(makeContainerStatus()) },
        './version_service': {
            checkRemoteNodeVersion: sinon.stub().resolves(), getLocalNodeVersion: sinon.stub().resolves('27.0'),
            getContainerNodeVersion: sinon.stub().resolves('27.0'), getLocalModuleVersion: sinon.stub().resolves('1.0.0'),
            getContainerModuleVersion: sinon.stub().resolves('1.0.0')
        },
        './config_service': { getDefaultConfig: async () => ({ INDEXER_API_PORT: '3004', UTXO_TRACKER_API_PORT: '3001', DECODER_API_PORT: '3002' }) },
        './peer_services': { bindPeerServices: () => ({
            bootstrapHealthGate: { probeServiceStatus: probe, MODULE_API_PORT_KEY: {
                'xchain-decoder': 'DECODER_API_PORT', 'xchain-indexer': 'INDEXER_API_PORT', 'xchain-utxo-tracker': 'UTXO_TRACKER_API_PORT' } },
            moduleService: { getModuleBranch: sinon.stub().resolves('master') }
        }) }
    })
    return { ss, probe, printed: () => printed }
}

describe('StatusService: getStatus() STALL and HALTED columns', function () {

    it('prints STALL plus the reason word for an indexer deferring on a missing DOGE read, and the note names the variable', async function () {
        const { ss, probe, printed } = loadWithProbe(
            [{ module: 'xchain-indexer', coin: 'bitcoin', network: 'testnet', container_id: 'idx' },
             { module: 'xchain-decoder', coin: 'bitcoin', network: 'testnet', container_id: 'dec' }],
            { idx: { status: 'unhealthy', stallReason: 'rollcall_proof_unavailable', stallClass: 'wedged', lastBlockCommittedAt: 1757869440000 },
              dec: { status: 'healthy', reorg_halted: false } })
        const result = await ss.getStatus('bitcoin', 'testnet', false)

        expect(probe.calledTwice).to.equal(true)
        expect(result.bitcoin.testnet['xchain-indexer'].stall.word).to.equal('rollcall_proof_unavailable')
        expect(printed()).to.match(/xchain-indexer.*running STALL rollcall_proof_unavailable/)
        expect(printed()).to.match(/xchain-decoder.*running\s/)
        expect(printed()).to.not.match(/xchain-decoder.*STALL/)
        expect(printed()).to.match(/! bitcoin\/testnet xchain-indexer is STALLED \(rollcall_proof_unavailable\)/)
        expect(printed()).to.match(/DOGE_INDEXER_API_URL/)
    })

    it('leaves an indexer deferring inside a barrier grace window, and an advancing one, plain running', async function () {
        const { ss, printed } = loadWithProbe(
            [{ module: 'xchain-indexer', coin: 'bitcoin', network: 'mainnet', container_id: 'idx' },
             { module: 'xchain-indexer', coin: 'litecoin', network: 'mainnet', container_id: 'ltc' }],
            { idx: { status: 'healthy', stallReason: 'price_sync_barrier', stallClass: 'barrier_defer' },
              ltc: { status: 'healthy', stallReason: null, stallClass: 'none' } })
        const result = await ss.getStatus(null, null, false)

        expect(result.bitcoin.mainnet['xchain-indexer'].stall).to.equal(undefined)
        expect(printed()).to.not.match(/STALL/)
        expect(printed()).to.not.match(/^!/m)
    })

    it('prints HALTED for a tracker that halted on a reorg past its window, with the reason and the reset under the table', async function () {
        const reason = "Can't delete a block from 'last blocks': list is empty (reorg exceeds tracked window). This index has to be rebuilt."
        const { ss, printed } = loadWithProbe(
            [{ module: 'xchain-utxo-tracker', coin: 'bitcoin', network: 'testnet', container_id: 'utx' }],
            { utx: { status: 'halted', halted: true, halt_reason: reason, db: true } })
        const result = await ss.getStatus('bitcoin', 'testnet', false)

        expect(result.bitcoin.testnet['xchain-utxo-tracker'].halt).to.deep.equal({ halted: true, reason })
        expect(printed()).to.match(/xchain-utxo-tracker.*running HALTED/)
        expect(printed()).to.match(/! bitcoin\/testnet xchain-utxo-tracker is HALTED and no restart clears it/)
        expect(printed()).to.match(/list is empty/)
        expect(printed()).to.match(/xchain-node reset xchain-utxo-tracker bitcoin testnet/)
    })

    it('a tracker whose surface cannot be read stays plain running', async function () {
        const { ss, printed } = loadWithProbe(
            [{ module: 'xchain-utxo-tracker', coin: 'bitcoin', network: 'testnet', container_id: 'utx' }],
            {})
        const result = await ss.getStatus('bitcoin', 'testnet', false)
        expect(result.bitcoin.testnet['xchain-utxo-tracker'].halt).to.equal(undefined)
        expect(printed()).to.not.match(/HALTED/)
    })
})
