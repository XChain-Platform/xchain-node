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

    return proxyquire('../../../src/services/status_service', {
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

// Two containers of the SAME service, built from different commits. Every other
// column agrees (same service, same state, same versions), which is exactly how a
// container running a stale tree passed for a fresh one: the deployed commit was
// the one fact nothing on this screen carried.
function stateWithTwoContainers() {
    const installedModulesObj = {}
    return makeStateStub({
        isStatusUpdated: sinon.stub().returns(false),
        getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
        resetInstalledModules: sinon.stub().callsFake(() => {
            for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k]
        }),
        db: {
            isReady: sinon.stub().returns(true),
            getAllModuleContainers: sinon.stub().resolves([
                { module: 'xchain-indexer', coin: 'bitcoin',  network: 'regtest', container_id: 'aaa' },
                { module: 'xchain-indexer', coin: 'dogecoin', network: 'regtest', container_id: 'bbb' }
            ])
        },
        getLastPrintedStatus: sinon.stub().returns('')
    })
}

function labelled(commit) {
    return {
        State: { Status: 'running' },
        NetworkSettings: { Ports: {} },
        Config: { Labels: commit ? { 'xchain.source.commit': commit } : {} }
    }
}

describe('StatusService: getStatus() commit column', function () {

    it('prints the commit each container was built from, per container', async function () {
        const fresh = '2'.repeat(40)
        const stale = '9'.repeat(40)
        const state = stateWithTwoContainers()
        let capturedOutput = ''
        state.setLastPrintedStatus = sinon.stub().callsFake(v => { capturedOutput = v })

        const getStatusFromContainer = sinon.stub()
        getStatusFromContainer.withArgs('aaa').resolves(labelled(fresh))
        getStatusFromContainer.withArgs('bbb').resolves(labelled(stale))

        const ss = loadStatusService(state, { getStatusFromContainer })
        await ss.getStatus(null, null, false)

        expect(capturedOutput).to.include('COMMIT')
        expect(capturedOutput).to.include(fresh.slice(0, 12))
        expect(capturedOutput).to.include(stale.slice(0, 12))
    })
})

describe('StatusService: getStatus() commit column', function () {

    it('omits the commit column when no image carries a source stamp', async function () {
        const state = stateWithTwoContainers()
        let capturedOutput = ''
        state.setLastPrintedStatus = sinon.stub().callsFake(v => { capturedOutput = v })

        const ss = loadStatusService(state, {
            getStatusFromContainer: sinon.stub().resolves(labelled(null))
        })
        await ss.getStatus(null, null, false)

        expect(capturedOutput).to.not.include('COMMIT')
    })
})

describe('StatusService: getStatus() commit column', function () {

    it('never shows the module checkout as a container commit', async function () {
        // The checkout is one shared directory that moves with every update, so
        // sourcing this column from it would claim today's code for a container built
        // days ago: the same lie the version column already tells.
        const state = stateWithTwoContainers()
        let capturedOutput = ''
        state.setLastPrintedStatus = sinon.stub().callsFake(v => { capturedOutput = v })

        const checkoutCommit = '7'.repeat(40)
        const ss = loadStatusService(state, {
            getStatusFromContainer: sinon.stub().resolves(labelled(null)),
            getModuleCommit: sinon.stub().resolves(checkoutCommit)
        })
        await ss.getStatus(null, null, false)

        expect(capturedOutput).to.not.include(checkoutCommit.slice(0, 12))
    })
})
