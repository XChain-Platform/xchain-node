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

describe('StatusService: getStatus() branch column', function () {

    it('includes branch column in output when any module is on a non-master branch', async function () {
        const installedModulesObj = {}
        const state = makeStateStub({
            isStatusUpdated: sinon.stub().returns(false),
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            resetInstalledModules: sinon.stub().callsFake(() => {
                for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k]
            }),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'ppp' }
                ])
            },
            getLastPrintedStatus: sinon.stub().returns('')
        })

        let capturedOutput = ''
        const setLastPrintedStatus = sinon.stub().callsFake(v => { capturedOutput = v })
        state.setLastPrintedStatus = setLastPrintedStatus

        const ss = loadStatusService(state, {
            getModuleBranch: sinon.stub().resolves('feature/my-branch')
        })
        await ss.getStatus('bitcoin', 'mainnet', false)

        expect(capturedOutput).to.include('BRANCH')
        expect(capturedOutput).to.include('feature/my-branch')
    })
})

describe('StatusService: getStatus() branch column', function () {

    it('omits branch column when all modules are on master', async function () {
        const installedModulesObj = {}
        const state = makeStateStub({
            isStatusUpdated: sinon.stub().returns(false),
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            resetInstalledModules: sinon.stub().callsFake(() => {
                for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k]
            }),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'qqq' }
                ])
            },
            getLastPrintedStatus: sinon.stub().returns('')
        })

        let capturedOutput = ''
        const setLastPrintedStatus = sinon.stub().callsFake(v => { capturedOutput = v })
        state.setLastPrintedStatus = setLastPrintedStatus

        const ss = loadStatusService(state, {
            getModuleBranch: sinon.stub().resolves('master')
        })
        await ss.getStatus('bitcoin', 'mainnet', false)

        expect(capturedOutput).to.not.include('BRANCH')
    })
})
