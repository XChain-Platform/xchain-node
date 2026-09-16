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
const { configStub } = require('../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function makeContainerStatus(state = 'running', ports = {}) {
    return {
        State: { Status: state },
        NetworkSettings: { Ports: ports }
    }
}

function makeStateStub(overrides = {}) {
    return {
        db: {
            isReady:                sinon.stub().returns(true),
            getAllModuleContainers:  sinon.stub().resolves([]),
            ...((overrides.db) || {})
        },
        getInstalledModules:    overrides.getInstalledModules    || sinon.stub().returns({}),
        setInstalledModules:    overrides.setInstalledModules    || sinon.stub(),
        resetInstalledModules:  overrides.resetInstalledModules  || sinon.stub(),
        getRemoteModuleVersions: overrides.getRemoteModuleVersions || sinon.stub().returns({}),
        isStatusUpdated:        overrides.isStatusUpdated        || sinon.stub().returns(false),
        setStatusUpdated:       overrides.setStatusUpdated       || sinon.stub(),
        getLastStatus:          overrides.getLastStatus          || sinon.stub().returns(null),
        setLastStatus:          overrides.setLastStatus          || sinon.stub(),
        getLastPrintedStatus:   overrides.getLastPrintedStatus   || sinon.stub().returns(''),
        setLastPrintedStatus:   overrides.setLastPrintedStatus   || sinon.stub(),
        appendLastPrintedStatus: overrides.appendLastPrintedStatus || sinon.stub()
    }
}

function loadStatusService(state, overrides = {}) {
    const getStatusFromContainerStub = overrides.getStatusFromContainer || sinon.stub().resolves(makeContainerStatus())
    const checkRemoteNodeVersionStub  = overrides.checkRemoteNodeVersion  || sinon.stub().resolves()
    const getLocalNodeVersionStub     = overrides.getLocalNodeVersion     || sinon.stub().resolves('27.0')
    const getContainerNodeVersionStub = overrides.getContainerNodeVersion || sinon.stub().resolves('27.0')
    const getLocalModuleVersionStub   = overrides.getLocalModuleVersion   || sinon.stub().resolves('1.0.0')
    const getContainerModuleVersionStub = overrides.getContainerModuleVersion || sinon.stub().resolves('1.0.0')
    const updateHubStub               = overrides.updateHub     || sinon.stub().resolves()
    const updateExplorerStub          = overrides.updateExplorer || sinon.stub().resolves()
    const getModuleBranchStub         = overrides.getModuleBranch || sinon.stub().resolves('master')

    return proxyquire('../../src/services/status_service', {
        '../config': configStub({
            NODE_MODULE_NAME: 'node',
            SEP:              '-',
            Coin:    { BITCOIN: 'bitcoin', DOGECOIN: 'dogecoin', LITECOIN: 'litecoin' },
            Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' },
            XChainService: { XCHAIN_DECODER: 'xchain-decoder' }
        }),
        '../state': state,
        './docker_service': {
            getStatusFromContainer: getStatusFromContainerStub
        },
        './version_service': {
            checkRemoteNodeVersion:     checkRemoteNodeVersionStub,
            getLocalNodeVersion:        getLocalNodeVersionStub,
            getContainerNodeVersion:    getContainerNodeVersionStub,
            getLocalModuleVersion:      getLocalModuleVersionStub,
            getContainerModuleVersion:  getContainerModuleVersionStub
        },
        // Lazy-required inside statusChanged
        './hub_service':      { updateHub:      updateHubStub },
        './explorer_service': { updateExplorer: updateExplorerStub },
        // Lazy-required inside getStatus (getModuleBranch)
        './module_service': { getModuleBranch: getModuleBranchStub }
    })
}

describe('StatusService: statusChanged()', function () {

    it('sets statusUpdated to false and calls updateHub + updateExplorer', async function () {
        const state = makeStateStub()
        const updateHub     = sinon.stub().resolves()
        const updateExplorer = sinon.stub().resolves()

        const ss = loadStatusService(state, { updateHub, updateExplorer })
        await ss.statusChanged()

        expect(state.setStatusUpdated.calledWith(false)).to.be.true
        expect(updateHub.calledOnce).to.be.true
        expect(updateExplorer.calledOnce).to.be.true
    })

    // updateHub() rejects on an unreachable coin network now (it used to
    // swallow the docker error and return true). These two pin that the
    // rejection is reported without taking the unrelated explorer push down
    // with it, which a plain sequential await would have done.
    it('still pushes explorer config when updateHub rejects, then rethrows', async function () {
        const state = makeStateStub()
        const updateHub      = sinon.stub().rejects(new Error('xchain-hub -> bitcoin/mainnet'))
        const updateExplorer = sinon.stub().resolves()

        const ss = loadStatusService(state, { updateHub, updateExplorer })
        let threw = null
        try { await ss.statusChanged() } catch (err) { threw = err }

        expect(threw).to.be.an('error')
        expect(threw.message).to.equal('xchain-hub -> bitcoin/mainnet')
        expect(updateExplorer.calledOnce).to.be.true
    })

    it('reports the hub failure first when both pushes reject', async function () {
        const state = makeStateStub()
        const updateHub      = sinon.stub().rejects(new Error('hub attach failed'))
        const updateExplorer = sinon.stub().rejects(new Error('explorer push failed'))

        const ss = loadStatusService(state, { updateHub, updateExplorer })
        let threw = null
        try { await ss.statusChanged() } catch (err) { threw = err }

        expect(threw).to.be.an('error')
        expect(threw.message).to.equal('hub attach failed')
        expect(updateExplorer.calledOnce).to.be.true
    })
})

describe('StatusService: getStatus() cache hit', function () {

    it('returns cached status immediately when isStatusUpdated is true', async function () {
        const cachedStatus = { bitcoin: { mainnet: {} } }
        const state = makeStateStub({
            isStatusUpdated: sinon.stub().returns(true),
            getLastStatus:   sinon.stub().returns(cachedStatus)
        })

        const ss = loadStatusService(state)
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        expect(result).to.equal(cachedStatus)
        expect(state.db.getAllModuleContainers.called).to.be.false
    })

    it('prints cached status when printStatus=true and cache is hot', async function () {
        const cachedStatus = {}
        const state = makeStateStub({
            isStatusUpdated:      sinon.stub().returns(true),
            getLastStatus:        sinon.stub().returns(cachedStatus),
            getLastPrintedStatus: sinon.stub().returns('printed output')
        })
        const consoleSpy = sinon.stub(console, 'log')
        try {
            const ss = loadStatusService(state)
            await ss.getStatus(null, null, true)
            expect(consoleSpy.calledWith('printed output')).to.be.true
        } finally {
            consoleSpy.restore()
        }
    })
})

describe('StatusService: getStatus() DB not ready', function () {

    it('returns empty object when db is not ready', async function () {
        const state = makeStateStub({
            isStatusUpdated: sinon.stub().returns(false),
            db: {
                isReady:               sinon.stub().returns(false),
                getAllModuleContainers: sinon.stub().resolves([])
            }
        })

        const ss = loadStatusService(state)
        const result = await ss.getStatus(null, null, false)
        expect(result).to.deep.equal({})
    })
})
