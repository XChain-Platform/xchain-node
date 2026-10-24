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

// Every failed bootstrap restore tells the operator to "re-run install with
// XCHAIN_NODE_FORCE_BOOTSTRAP=1". On an installed module install returned before it
// ever read that flag, so the remedy did nothing. These tests drive installModule
// with an installed module and the bootstrap service stubbed, and check whether the
// restore runs again.

const { sinon, expect, makeStubs, loadModuleService, moduleSuite } = require('../support/helpers')
const { XChainService } = require('../../../../src/config')

const COIN = 'bitcoin'
const NETWORK = 'mainnet'

function installedStatus(module) {
    return { [COIN]: { [NETWORK]: { [module]: { container_version: '1.2.3' } } } }
}

function loadWith({ module, force }) {
    const stubs = makeStubs()
    const buildAndUp = sinon.stub().resolves('new-container-id')
    const bootstrap = {
        FRESHNESS_EMPTY: 'empty',
        forceBootstrapRequested: () => force,
        utxoTrackerVolumeFreshness: sinon.stub().resolves('populated'),
        mariaDbModuleFreshness: sinon.stub().resolves('populated'),
        ensureBootstrapUtxoTracker: sinon.stub().resolves(true),
        ensureBootstrapMariaDb: sinon.stub().resolves(true)
    }
    const ms = loadModuleService(stubs, null, {
        '../state': {
            db: stubs.db,
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => installedStatus(module)
        },
        './bootstrap_service': bootstrap,
        './version_service': {
            getLocalNodeVersion: sinon.stub().resolves(null),
            getLocalModuleVersion: sinon.stub().resolves('1.2.3'),
            checkRemoteNodeVersion: sinon.stub().resolves()
        },
        './module_service/build_and_up.js': { configureDependencies: () => {}, buildAndUp }
    })
    return { ms, stubs, buildAndUp, bootstrap }
}

moduleSuite('installModule(): XCHAIN_NODE_FORCE_BOOTSTRAP on an installed module', function () {

    it('reinstalls an installed decoder and takes the restore again when the flag is set', async function () {
        const { ms, stubs, buildAndUp, bootstrap } = loadWith({ module: XChainService.XCHAIN_DECODER, force: true })

        const result = await ms.installModule(XChainService.XCHAIN_DECODER, COIN, NETWORK)

        expect(result).to.equal('new-container-id')
        expect(buildAndUp.calledOnce).to.equal(true)
        // The running container is handed over by id, so buildAndUp stops it gracefully.
        expect(buildAndUp.firstCall.args.slice(0, 4))
            .to.deep.equal([XChainService.XCHAIN_DECODER, COIN, NETWORK, 'old-container-id'])
        expect(stubs.db.getModuleContainer.calledWith(XChainService.XCHAIN_DECODER, COIN, NETWORK)).to.equal(true)
        expect(bootstrap.ensureBootstrapMariaDb.calledOnceWith(COIN, NETWORK, XChainService.XCHAIN_DECODER)).to.equal(true)
    })

    it('takes the restore again for an installed utxo-tracker', async function () {
        const { ms, bootstrap } = loadWith({ module: XChainService.XCHAIN_UTXO_TRACKER, force: true })

        await ms.installModule(XChainService.XCHAIN_UTXO_TRACKER, COIN, NETWORK)

        expect(bootstrap.ensureBootstrapUtxoTracker.calledOnceWith(COIN, NETWORK)).to.equal(true)
    })

    it('leaves an installed module alone without the flag', async function () {
        const { ms, buildAndUp, bootstrap } = loadWith({ module: XChainService.XCHAIN_INDEXER, force: false })

        const result = await ms.installModule(XChainService.XCHAIN_INDEXER, COIN, NETWORK)

        expect(result).to.equal(false)
        expect(buildAndUp.called).to.equal(false)
        expect(bootstrap.ensureBootstrapMariaDb.called).to.equal(false)
    })

    it('never rebuilds a module that has no bootstrap restore, flag or not', async function () {
        const { ms, buildAndUp } = loadWith({ module: XChainService.XCHAIN_ENCODER, force: true })

        const result = await ms.installModule(XChainService.XCHAIN_ENCODER, COIN, NETWORK)

        expect(result).to.equal(false)
        expect(buildAndUp.called).to.equal(false)
    })
})
