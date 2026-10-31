'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { sinon, expect, makeStubs, loadModuleService, moduleSuite } = require('../support/helpers')
const { XChainService } = require('../../../../src/config')

const COIN = 'bitcoin'
const NETWORK = 'mainnet'

function loadForPresence({ presence, force = false, registryId = 'registered-id' }) {
    const stubs = makeStubs()
    stubs.probeContainerPresenceByName.resolves(presence)
    stubs.db.getModuleContainerStrict.resolves(registryId)
    const buildAndUp = sinon.stub().resolves('new-id')
    const bootstrap = {
        FRESHNESS_EMPTY: 'empty',
        forceBootstrapRequested: () => force,
        utxoTrackerVolumeFreshness: sinon.stub().resolves('populated'),
        mariaDbModuleFreshness: sinon.stub().resolves('populated'),
        ensureBootstrapUtxoTracker: sinon.stub().resolves(),
        ensureBootstrapMariaDb: sinon.stub().resolves()
    }
    const ms = loadModuleService(stubs, null, {
        '../state': { db: stubs.db, getRemoteModuleVersions: () => ({}), getLastStatus: () => ({}) },
        './bootstrap_service': bootstrap,
        './version_service': {
            getLocalNodeVersion: sinon.stub().resolves(null),
            getLocalModuleVersion: sinon.stub().resolves('1.0.0'),
            checkRemoteNodeVersion: sinon.stub().resolves()
        },
        './module_service/build_and_up.js': { configureDependencies: () => {}, buildAndUp }
    })
    return { ms, stubs, buildAndUp }
}

async function expectRejection(promise, message) {
    try {
        await promise
        expect.fail('expected rejection')
    } catch (err) {
        expect(err.message).to.include(message)
    }
}

moduleSuite('installModule(): Docker presence gate', function () {
    it('leaves a live decoder unchanged when cached status has no version', async function () {
        const { ms, buildAndUp } = loadForPresence({ presence: 'exists' })
        expect(await ms.installModule(XChainService.XCHAIN_DECODER, COIN, NETWORK)).to.equal(false)
        expect(buildAndUp.called).to.equal(false)
    })

    it('refuses an ambiguous decoder probe before clone or build', async function () {
        const { ms, stubs, buildAndUp } = loadForPresence({ presence: 'unknown' })
        await expectRejection(ms.installModule(XChainService.XCHAIN_DECODER, COIN, NETWORK), 'nothing was changed')
        expect(buildAndUp.called).to.equal(false)
        expect(stubs.execFile.called).to.equal(false)
    })

    it('builds a decoder only after Docker confirms it is gone', async function () {
        const { ms, buildAndUp } = loadForPresence({ presence: 'gone' })
        expect(await ms.installModule(XChainService.XCHAIN_DECODER, COIN, NETWORK)).to.equal('new-id')
        expect(buildAndUp.calledOnce).to.equal(true)
    })

    it('refuses an ambiguous singleton probe', async function () {
        const { ms, buildAndUp } = loadForPresence({ presence: 'unknown' })
        await expectRejection(ms.installModule('xchain-hub', null, null), 'Docker could not confirm')
        expect(buildAndUp.called).to.equal(false)
    })

    it('hands forced bootstrap the strictly resolved container id', async function () {
        const { ms, stubs, buildAndUp } = loadForPresence({ presence: 'exists', force: true })
        await ms.installModule(XChainService.XCHAIN_DECODER, COIN, NETWORK)
        expect(stubs.db.getModuleContainerStrict.calledOnceWith(XChainService.XCHAIN_DECODER, COIN, NETWORK)).to.equal(true)
        expect(buildAndUp.firstCall.args[3]).to.equal('registered-id')
    })

    it('refuses forced bootstrap when the strict registry lookup fails', async function () {
        const { ms, stubs, buildAndUp } = loadForPresence({ presence: 'exists', force: true })
        stubs.db.getModuleContainerStrict.rejects(new Error('registry unavailable'))
        await expectRejection(ms.installModule(XChainService.XCHAIN_DECODER, COIN, NETWORK), 'registry unavailable')
        expect(buildAndUp.called).to.equal(false)
    })

    it('preserves an explicit rebuild handover without probing presence', async function () {
        const { ms, stubs, buildAndUp } = loadForPresence({ presence: 'exists' })
        await ms.installModule(XChainService.XCHAIN_ENCODER, COIN, NETWORK, false, 'menu-selected-id')
        expect(stubs.probeContainerPresenceByName.called).to.equal(false)
        expect(buildAndUp.firstCall.args[3]).to.equal('menu-selected-id')
    })
})
