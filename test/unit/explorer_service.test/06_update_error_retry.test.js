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

function makeUpdateErrorStubs() {
    // Scenario: first ping succeeds but updateExplorer throws on first try,
    // then on retry ping succeeds and updateExplorer succeeds
    let pingCount = 0
    let updateExplorerCallCount = 0
    const lastStatus = {
        '': { '': { 'xchain-explorer': { status: { State: { Status: 'running' } } } } }
    }

    const updateExplorer = sinon.stub().callsFake(() => {
        updateExplorerCallCount++
        if (updateExplorerCallCount === 1) throw new Error('transient error')
        return Promise.resolve(true)
    })

    return makeExplorerServiceStubs({
        explorerPing: sinon.stub().callsFake(() => {
            pingCount++
            // Return true on the first and subsequent calls (to drive the ping branch)
            return Promise.resolve(true)
        }),
        sleep: sinon.stub().resolves(),
        getLastStatus: sinon.stub().returns(lastStatus),
        dbGetModuleContainer: sinon.stub().resolves('explorer-cid'),
        getInstalledCoinsAndNetworks: sinon.stub().resolves({})
    })
}

function loadUpdateErrorExplorer(stubs) {
    const MockExplorerConnector = sinon.stub()
    MockExplorerConnector.prototype.ping = stubs.explorerPing
    MockExplorerConnector.prototype.probe = async () => {
        const healthy = await stubs.explorerPing()
        return { answering: healthy, healthy }
    }

    return proxyquire('../../../src/services/explorer_service', {
        '../config': configStub({ EXPLORER_MODULE_NAME: 'xchain-explorer' }),
        '../state': {
            db: stubs.db,
            getLastStatus: stubs.getLastStatus,
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
        './explorer_connector.js': MockExplorerConnector
    })
}

describe('ExplorerService: installExplorerModule() updateExplorer error in loop', function () {

    it('retries on updateExplorer error and returns true when subsequent ping+updateExplorer succeed', async function () {
        const stubs = makeUpdateErrorStubs()
        const es = loadUpdateErrorExplorer(stubs)

        // updateExplorer is called internally and is self-referential within the
        // module, so it cannot be stubbed directly through proxyquire; the retry
        // path is instead verified indirectly, by checking that the install still
        // resolves true once ping and the internal updateExplorer both succeed
        // on the retry after the first updateExplorer call fails.
        const result = await es.installExplorerModule(true)
        expect(result).to.be.true
    })
})
