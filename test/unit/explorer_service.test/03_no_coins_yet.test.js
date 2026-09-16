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

const sinon      = require('sinon')
const { configStub } = require('../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const EXPLORER_MODULE_NAME = 'xchain-explorer'

function makeExplorerServiceStubs(overrides = {}) {
    return {
        db: {
            getModuleContainer:    overrides.dbGetModuleContainer    || sinon.stub().resolves(null),
            deleteModuleContainer: overrides.dbRemoveModuleContainer || sinon.stub().resolves()
        },
        getLastStatus:    overrides.getLastStatus    || sinon.stub().returns(null),
        isStatusUpdated:  overrides.isStatusUpdated  || sinon.stub().returns(false),
        sleep:            overrides.sleep            || sinon.stub().resolves(),
        getDefaultConfig: overrides.getDefaultConfig || sinon.stub().resolves({
            EXPLORER_HOST: 'localhost',
            EXPLORER_PORT: 18080
        }),
        getDockerNetwork: overrides.getDockerNetwork || sinon.stub().returns('xchain-node-bitcoin-mainnet'),
        getInstalledCoinsAndNetworks: overrides.getInstalledCoinsAndNetworks || sinon.stub().resolves({}),
        statusChanged:    overrides.statusChanged    || sinon.stub().resolves(),
        getStatus:        overrides.getStatus        || sinon.stub().resolves({}),
        addContainerToNetwork: overrides.addContainerToNetwork || sinon.stub().resolves(),
        killContainer:    overrides.killContainer    || sinon.stub().resolves(),
        removeContainer:  overrides.removeContainer  || sinon.stub().resolves(),
        cloneGit:         overrides.cloneGit         || sinon.stub().resolves(true),
        buildAndUp:       overrides.buildAndUp       || sinon.stub().resolves('c'.repeat(64)),
        explorerPing:     overrides.explorerPing     || sinon.stub().resolves(false),
        explorerProbe:    overrides.explorerProbe    || null,
        // Default is the no-active-release answer the real service gives: the
        // caller's ref passes through unpinned.
        resolveComponentRef: overrides.resolveComponentRef
            || sinon.stub().callsFake((component, fallbackRef) => ({ ref: fallbackRef, commit: null, pinned: false }))
    }
}

function loadExplorerService(stubs) {
    // Build a mock ExplorerConnector class so we can control ping()
    const MockExplorerConnector = sinon.stub()
    MockExplorerConnector.prototype.ping = stubs.explorerPing
    // probe() is what the install path reads. Default it to the real class's own
    // relationship between the two (a healthy explorer answers; an unhealthy one
    // is assumed silent) so every pre-existing case keeps its meaning, and let a
    // test override it to express the third state: answering but degraded.
    MockExplorerConnector.prototype.probe = stubs.explorerProbe
        || (async function () {
            const healthy = await stubs.explorerPing()
            return { answering: healthy, healthy }
        })

    return proxyquire('../../../src/services/explorer_service', {
        '../config': configStub({
            EXPLORER_MODULE_NAME: 'xchain-explorer'
        }),
        '../state': {
            db:              stubs.db,
            getLastStatus:   stubs.getLastStatus,
            isStatusUpdated: stubs.isStatusUpdated
        },
        '../utils/helpers': {
            sleep:         stubs.sleep,
            redactSecrets: (err) => String(err && err.message ? err.message : err)
        },
        './config_service': {
            getDefaultConfig: stubs.getDefaultConfig,
            getDockerNetwork: stubs.getDockerNetwork
        },
        './status_service': {
            statusChanged:                stubs.statusChanged,
            getStatus:                    stubs.getStatus,
            getInstalledCoinsAndNetworks: stubs.getInstalledCoinsAndNetworks
        },
        './docker_service': {
            addContainerToNetwork: stubs.addContainerToNetwork,
            killContainer:         stubs.killContainer,
            removeContainer:       stubs.removeContainer
        },
        './module_service': {
            cloneGit:   stubs.cloneGit,
            buildAndUp: stubs.buildAndUp
        },
        './release_manifest_service': {
            resolveComponentRef: stubs.resolveComponentRef
        },
        './explorer_connector.js': MockExplorerConnector
    })
}

// The explorer only reports healthy once it holds a DB pool, and its pools come
// from the coin stacks. `install <ref> all` installs it in the shared bucket,
// BEFORE any coin exists, so requiring health there made a first install
// unsatisfiable: measured on a clean hosted runner, the explorer answered 503
// degraded for ten seconds and the whole stack install failed. It never showed on
// a dev box or CI venue, both of which already carry coin DBs.
describe('ExplorerService: installExplorerModule() on a stack with no coins yet', function () {

    it('accepts an answering-but-degraded explorer when no coin is installed', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerProbe: sinon.stub().resolves({ answering: true, healthy: false }),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({})
        })
        const es = loadExplorerService(stubs)
        expect(await es.installExplorerModule(false)).to.be.true
        expect(stubs.buildAndUp.called).to.be.true
    })

    it('still REFUSES an answering-but-degraded explorer once a coin is installed', async function () {
        // With a coin present the explorer should hold a pool for it, so degraded
        // is a real fault and must not be waved through by the carve-out above.
        const stubs = makeExplorerServiceStubs({
            explorerProbe: sinon.stub().resolves({ answering: true, healthy: false }),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({ bitcoin: ['regtest'] })
        })
        const es = loadExplorerService(stubs)
        let threw = null
        try { await es.installExplorerModule(false) } catch (err) { threw = err }
        expect(threw).to.match(/Couldn't install the explorer module/)
    })

    it('refuses a container that never answers at all, coins or not', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerProbe: sinon.stub().resolves({ answering: false, healthy: false }),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({})
        })
        const es = loadExplorerService(stubs)
        let threw = null
        try { await es.installExplorerModule(false) } catch (err) { threw = err }
        expect(threw).to.match(/Couldn't install the explorer module/)
    })

    it('a healthy explorer is accepted whether or not a coin is installed', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerProbe: sinon.stub().resolves({ answering: true, healthy: true }),
            getInstalledCoinsAndNetworks: sinon.stub().resolves({ bitcoin: ['regtest'] })
        })
        const es = loadExplorerService(stubs)
        expect(await es.installExplorerModule(false)).to.be.true
    })
})
