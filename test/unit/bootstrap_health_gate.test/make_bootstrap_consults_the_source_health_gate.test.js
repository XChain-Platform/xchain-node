'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    COIN,
    DB_CONTAINER,
    NETWORK,
    SVC_CONTAINER,
    XChainService,
    expect,
    proxyquire,
    sinon
} = require('./support/bootstrap_health_gate')

function loadServiceWithGate(gateStub) {
    return proxyquire('../../../../src/services/bootstrap_service', {
        '../state': { db: { getModuleContainer: sinon.stub().resolves(SVC_CONTAINER) } },
        './config_service': {
            getDefaultConfig: sinon.stub().resolves({}),
            getModuleDatabaseName: sinon.stub().returns('db'),
            getUtxoTrackerVolumeName: sinon.stub().returns('vol')
        },
        './docker_service':   { stopContainer: sinon.stub().resolves(), startContainer: sinon.stub().resolves() },
        './database_service': {
            getDatabaseContainerId: sinon.stub().resolves(DB_CONTAINER),
            ensureDatabasePool: sinon.stub().resolves(),
            askMariadbRootPassword: sinon.stub().resolves('pw')
        },
        './bootstrap_health_gate': { assertBootstrapSourceHealthy: gateStub }
    })
}

// The gate has to actually be wired into `bootstrap create`, or none of the
// above matters. Loaded with the gate REAL and everything else stubbed, so a
// future refactor that drops the call fails here.
describe('makeBootstrap() consults the source health gate', function () {

    it('aborts the create when the gate refuses', async function () {
        const gateStub = sinon.stub().rejects(new Error('Refusing to create a bootstrap from litecoin/mainnet xchain-decoder'))
        const svc = loadServiceWithGate(gateStub)
        let err = null
        try { await svc.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_DECODER) } catch (e) { err = e }
        expect(err, 'the create must not proceed past a refusal').to.not.equal(null)
        expect(err.message).to.match(/Refusing to create a bootstrap/)
        expect(gateStub.calledOnceWithExactly(COIN, NETWORK, XChainService.XCHAIN_DECODER)).to.equal(true)
    })

    it('gates the utxo-tracker BEFORE stopping its container, so a refusal costs no downtime', async function () {
        const gateStub = sinon.stub().rejects(new Error('Refusing to create a bootstrap'))
        const stopContainer = sinon.stub().resolves()
        const svc = proxyquire('../../../../src/services/bootstrap_service', {
            '../state': { db: { getModuleContainer: sinon.stub().resolves(SVC_CONTAINER) } },
            './config_service': {
                getDefaultConfig: sinon.stub().resolves({ UTXO_TRACKER_BOOTSTRAP_VOLUME: '/tmp/x' }),
                getModuleDatabaseName: sinon.stub().returns('db'),
                getUtxoTrackerVolumeName: sinon.stub().returns('vol')
            },
            './docker_service':   { stopContainer, startContainer: sinon.stub().resolves() },
            './database_service': {
                getDatabaseContainerId: sinon.stub().resolves(DB_CONTAINER),
                ensureDatabasePool: sinon.stub().resolves(),
                askMariadbRootPassword: sinon.stub().resolves('pw')
            },
            './bootstrap_health_gate': { assertBootstrapSourceHealthy: gateStub }
        })
        try { await svc.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER) } catch (_) { /* expected */ }
        expect(stopContainer.called, 'the tracker must not be stopped for a create the gate refuses').to.equal(false)
    })

    it('still rejects an unsupported module before consulting the gate', async function () {
        const gateStub = sinon.stub().resolves({ skipped: false, reasons: [] })
        const svc = loadServiceWithGate(gateStub)
        let err = null
        try { await svc.makeBootstrap(COIN, NETWORK, 'xchain-unknown') } catch (e) { err = e }
        expect(err.message).to.match(/Unsupported module/)
        expect(gateStub.called).to.equal(false)
    })
})
