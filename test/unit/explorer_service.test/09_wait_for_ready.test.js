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

// The wait exists because the explorer polls the hub for its coins, so a fresh
// install returns while it is still answering 503. It must converge a service
// that is talking, and must NOT burn its budget on a host where no explorer is
// listening at all (a coin-only install), which is also what keeps it out of the
// way of suites that run against a fully mocked stack.
describe('ExplorerService: waitForExplorerReady()', function () {

    it('returns true as soon as the explorer reports healthy', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerProbe: sinon.stub().resolves({ answering: true, healthy: true })
        })
        const es = loadExplorerService(stubs)
        expect(await es.waitForExplorerReady(10000)).to.be.true
    })

    it('keeps waiting through degraded replies, then succeeds when it converges', async function () {
        const probe = sinon.stub()
        probe.onCall(0).resolves({ answering: true, healthy: false })
        probe.onCall(1).resolves({ answering: true, healthy: false })
        probe.resolves({ answering: true, healthy: true })
        const stubs = makeExplorerServiceStubs({ explorerProbe: probe })
        const es = loadExplorerService(stubs)
        expect(await es.waitForExplorerReady(10000)).to.be.true
        expect(probe.callCount).to.be.greaterThan(2)
    })

    it('gives up early, reporting no problem, when nothing is listening at all', async function () {
        // Silence is "no explorer on this host", not "an explorer converging".
        // Grinding the full budget here would add minutes to every coin-only install.
        const probe = sinon.stub().resolves({ answering: false, healthy: false })
        const stubs = makeExplorerServiceStubs({ explorerProbe: probe, sleep: sinon.stub().resolves() })
        const es = loadExplorerService(stubs)
        expect(await es.waitForExplorerReady(150000, 0)).to.be.true
    })

    it('reports false when a talking explorer never converges inside the budget', async function () {
        const probe = sinon.stub().resolves({ answering: true, healthy: false })
        const stubs = makeExplorerServiceStubs({ explorerProbe: probe, sleep: sinon.stub().resolves() })
        const es = loadExplorerService(stubs)
        expect(await es.waitForExplorerReady(10)).to.be.false
    })
})
