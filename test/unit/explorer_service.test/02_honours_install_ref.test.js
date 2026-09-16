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

// The explorer was one of two modules whose install ignored the ref the command
// named, so `install develop ...` built it from the default branch (master) while
// every generic-path module built from develop. These pin the ref reaching the
// clone, because that argument is the whole defect: everything downstream of it
// looked correct while testing the wrong tree.
describe('ExplorerService: installExplorerModule() honours the install ref', function () {

    it('clones at the branch the caller named', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().onFirstCall().resolves(false).resolves(true)
        })
        const es = loadExplorerService(stubs)
        await es.installExplorerModule(false, 'develop')
        expect(stubs.cloneGit.firstCall.args[0]).to.equal(EXPLORER_MODULE_NAME)
        expect(stubs.cloneGit.firstCall.args[3]).to.equal('develop')
    })

    it('clones a release branch verbatim, so a frozen-ref e2e tests the frozen tree', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().onFirstCall().resolves(false).resolves(true)
        })
        const es = loadExplorerService(stubs)
        await es.installExplorerModule(false, 'release/v0.10.0')
        expect(stubs.cloneGit.firstCall.args[3]).to.equal('release/v0.10.0')
    })

    it('passes the manifest pin (ref AND commit) when a release install is active', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().onFirstCall().resolves(false).resolves(true),
            resolveComponentRef: sinon.stub().returns({ ref: 'v0.9.0', commit: 'a'.repeat(40), pinned: true })
        })
        const es = loadExplorerService(stubs)
        await es.installExplorerModule(false, null)
        expect(stubs.cloneGit.firstCall.args[3]).to.equal('v0.9.0')
        expect(stubs.cloneGit.firstCall.args[4]).to.equal('a'.repeat(40))
    })

    it('passes null when no ref was named, keeping the default-branch behaviour', async function () {
        const stubs = makeExplorerServiceStubs({
            explorerPing: sinon.stub().onFirstCall().resolves(false).resolves(true)
        })
        const es = loadExplorerService(stubs)
        await es.installExplorerModule(false)
        expect(stubs.cloneGit.firstCall.args[3]).to.equal(null)
    })
})
