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

// `ps` shows NOT READY for a service that is up and passing its healthcheck but reports
// ready false (indexer /status, decoder /live), or an indexer holding a hub barrier past
// its ceiling, which reduceIndexerStall still calls a healthy defer. An older image that
// carries none of the fields keeps the plain running row.

const sinon      = require('sinon')
const { configStub } = require('../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function makeContainerStatus() {
    return { State: { Status: 'running', Health: { Status: 'healthy' } }, NetworkSettings: { Ports: {} }, Config: { Labels: {} } }
}

// `health` answers the JSON-RPC probe, `surfaces` the readiness route, both by container id.
function load(rows, health, surfaces) {
    const installedModulesObj = {}
    let printed = ''
    const state = {
        db: { isReady: sinon.stub().returns(true), getAllModuleContainers: sinon.stub().resolves(rows) },
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
    const routes = []
    const ss = proxyquire('../../../src/services/status_service', {
        '../config': configStub({ NODE_MODULE_NAME: 'node', SEP: '-',
            Coin:    { BITCOIN: 'bitcoin', LITECOIN: 'litecoin' },
            Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' },
            XChainService: { XCHAIN_DECODER: 'xchain-decoder', XCHAIN_INDEXER: 'xchain-indexer', XCHAIN_UTXO_TRACKER: 'xchain-utxo-tracker' } }),
        '../state': state,
        './docker_service':  { getStatusFromContainer: sinon.stub().resolves(makeContainerStatus()) },
        './version_service': {
            checkRemoteNodeVersion: sinon.stub().resolves(), getLocalNodeVersion: sinon.stub().resolves('27.0'),
            getContainerNodeVersion: sinon.stub().resolves('27.0'), getLocalModuleVersion: sinon.stub().resolves('1.0.0'),
            getContainerModuleVersion: sinon.stub().resolves('1.0.0')
        },
        './config_service': { getDefaultConfig: async () => ({ INDEXER_API_PORT: '3004', DECODER_API_PORT: '3002' }) },
        './peer_services': { bindPeerServices: () => ({
            bootstrapHealthGate: {
                probeServiceStatus: async (id) => health[id],
                probeReadinessSurface: async (id, port, route) => { routes.push(route); return surfaces[id] || null },
                MODULE_API_PORT_KEY: { 'xchain-decoder': 'DECODER_API_PORT', 'xchain-indexer': 'INDEXER_API_PORT' } },
            moduleService: { getModuleBranch: sinon.stub().resolves('master') }
        }) }
    })
    return { ss, routes, printed: () => printed }
}

const IDX = { module: 'xchain-indexer', coin: 'bitcoin', network: 'mainnet', container_id: 'idx' }
const DEC = { module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet', container_id: 'dec' }

describe('StatusService: getStatus() NOT READY column', function () {

    it('prints NOT READY and lists the reasons for an indexer whose /status says ready false', async function () {
        const { ss, routes, printed } = load([IDX], { idx: { status: 'healthy', stallReason: null } },
            { idx: { ready: false, notReadyReasons: ['decoder_reorg_halted', 'behind_chain_tip'] } })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)
        expect(routes).to.deep.equal(['/status'])
        expect(result.bitcoin.mainnet['xchain-indexer'].not_ready.reasons).to.deep.equal(['decoder_reorg_halted', 'behind_chain_tip'])
        expect(printed()).to.match(/xchain-indexer.*running NOT READY/)
        expect(printed()).to.match(/! bitcoin\/mainnet xchain-indexer is NOT READY \(decoder_reorg_halted, behind_chain_tip\)/)
    })

    it('prints NOT READY for an indexer past its barrier ceiling although the stall reducer calls it a healthy defer', async function () {
        const { ss, printed } = load([IDX],
            { idx: { status: 'healthy', stallReason: 'price_sync_barrier', stallClass: 'barrier_defer' } },
            { idx: { ready: true, barrierCeilingExceeded: true } })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)
        expect(result.bitcoin.mainnet['xchain-indexer'].stall).to.equal(undefined)
        expect(result.bitcoin.mainnet['xchain-indexer'].not_ready.reasons).to.deep.equal(['barrier_ceiling_exceeded'])
        expect(printed()).to.match(/xchain-indexer.*running NOT READY/)
        expect(printed()).to.not.match(/STALL/)
    })

    it('prints NOT READY for a decoder whose /live body says ready false, reading /live', async function () {
        const { ss, routes, printed } = load([DEC], { dec: { status: 'healthy', reorg_halted: true } },
            { dec: { status: 'healthy', ready: false, not_ready_reasons: ['reorg_halt'] } })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)
        expect(routes).to.deep.equal(['/live'])
        expect(result.bitcoin.mainnet['xchain-decoder'].not_ready.reasons).to.deep.equal(['reorg_halt'])
        expect(printed()).to.match(/xchain-decoder.*running REORG_HALT NOT READY/)
        expect(printed()).to.match(/xchain-decoder is NOT READY \(reorg_halt\)/)
    })

    it('keeps today\'s plain running row when the fields are absent, ready is true or the route is unreadable', async function () {
        const { ss, printed } = load([IDX, DEC, { ...IDX, coin: 'litecoin', container_id: 'ltc' }],
            { idx: { status: 'healthy' }, dec: { status: 'healthy' }, ltc: { status: 'healthy' } },
            { idx: { indexerBlock: 5, stallClass: 'none' }, dec: { status: 'healthy', ready: true, not_ready_reasons: [] } })
        const result = await ss.getStatus(null, null, false)
        expect(result.bitcoin.mainnet['xchain-indexer'].not_ready).to.equal(undefined)
        expect(result.bitcoin.mainnet['xchain-decoder'].not_ready).to.equal(undefined)
        expect(result.litecoin.mainnet['xchain-indexer'].not_ready).to.equal(undefined)
        expect(printed()).to.not.match(/NOT READY/)
        expect(printed()).to.not.match(/^!/m)
    })

    it('reduceNotReady reads only an explicit ready false or a true ceiling flag', function () {
        const { ss } = load([], {}, {})
        expect(ss.reduceNotReady(null)).to.equal(null)
        expect(ss.reduceNotReady({})).to.equal(null)
        expect(ss.reduceNotReady({ ready: 'no' })).to.equal(null)
        expect(ss.reduceNotReady({ ready: false })).to.deep.equal({ notReady: true, reasons: [] })
        expect(ss.reduceNotReady({ ready: false, barrierCeilingExceeded: true, notReadyReasons: ['x'] }).reasons)
            .to.deep.equal(['x', 'barrier_ceiling_exceeded'])
    })
})
