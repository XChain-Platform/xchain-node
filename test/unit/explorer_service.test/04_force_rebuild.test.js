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

function pingSecondCall() {
    let pingCallCount = 0
    return sinon.stub().callsFake(() => {
        pingCallCount++
        // Return true on the second call (post-install) to exit the while loop
        return Promise.resolve(pingCallCount >= 2)
    })
}

function expectOldExplorerUntouched(stubs) {
    expect(stubs.killContainer.called).to.be.false
    expect(stubs.removeContainer.called).to.be.false
    expect(stubs.db.deleteModuleContainer.called).to.be.false
}

describe('ExplorerService: installExplorerModule() force=true', function () {

    // buildAndUp stops and removes the container it is handed, after the image builds.
    it('kills and removes existing container when force=true and container exists', async function () {
        const existingId = 'existing-id'
        const stubs = makeExplorerServiceStubs({
            dbGetModuleContainer: sinon.stub().resolves(existingId),
            explorerPing: pingSecondCall()
        })
        const es = loadExplorerService(stubs)
        const result = await es.installExplorerModule(true)
        expect(result).to.be.true
        expect(stubs.buildAndUp.calledOnce).to.be.true
        expect(stubs.buildAndUp.firstCall.args).to.deep.equal([EXPLORER_MODULE_NAME, null, null, existingId])
        expectOldExplorerUntouched(stubs)
    })

    it('swallows errors from killContainer/removeContainer during force rebuild', async function () {
        const existingId = 'old-id'
        const stubs = makeExplorerServiceStubs({
            dbGetModuleContainer: sinon.stub().resolves(existingId),
            killContainer:  sinon.stub().rejects(new Error('already stopped')),
            removeContainer: sinon.stub().rejects(new Error('already gone')),
            explorerPing: pingSecondCall()
        })
        const es = loadExplorerService(stubs)
        const result = await es.installExplorerModule(true)
        expect(result).to.be.true
        expectOldExplorerUntouched(stubs)
    })

    it('skips kill/remove when no existing container in DB (force=true)', async function () {
        const stubs = makeExplorerServiceStubs({
            dbGetModuleContainer: sinon.stub().resolves(null),
            explorerPing: pingSecondCall()
        })
        const es = loadExplorerService(stubs)
        await es.installExplorerModule(true)
        expect(stubs.killContainer.called).to.be.false
        expect(stubs.removeContainer.called).to.be.false
        expect(stubs.buildAndUp.firstCall.args[3]).to.equal(null)
    })
})

describe('ExplorerService: installExplorerModule() force=true keeps the old explorer on failure', function () {

    it('leaves the running explorer and its registry row alone when the clone fails', async function () {
        const stubs = makeExplorerServiceStubs({
            dbGetModuleContainer: sinon.stub().resolves('live-id'),
            cloneGit: sinon.stub().rejects(new Error('clone failed'))
        })
        const es = loadExplorerService(stubs)
        let threw = null
        try { await es.installExplorerModule(true) } catch (err) { threw = err }
        expect(threw).to.be.an('error').with.property('message', 'clone failed')
        expect(stubs.buildAndUp.called).to.be.false
        expectOldExplorerUntouched(stubs)
    })

    it('leaves the registry row alone when the image build fails', async function () {
        const stubs = makeExplorerServiceStubs({
            dbGetModuleContainer: sinon.stub().resolves('live-id'),
            buildAndUp: sinon.stub().rejects('Error creating Docker image: build failed')
        })
        const es = loadExplorerService(stubs)
        let threw = null
        try { await es.installExplorerModule(true) } catch (err) { threw = err }
        expect(threw).to.not.equal(null)
        expect(stubs.buildAndUp.firstCall.args[3]).to.equal('live-id')
        expectOldExplorerUntouched(stubs)
    })

    it('does not look up an overwrite id when force=false', async function () {
        const stubs = makeExplorerServiceStubs({
            dbGetModuleContainer: sinon.stub().resolves('live-id'),
            explorerPing: sinon.stub().onFirstCall().resolves(false).resolves(true)
        })
        const es = loadExplorerService(stubs)
        await es.installExplorerModule(false)
        expect(stubs.buildAndUp.firstCall.args[3]).to.equal(null)
    })
})
