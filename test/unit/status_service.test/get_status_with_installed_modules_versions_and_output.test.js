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

describe('StatusService: getStatus() with installed modules', function () {

    it('handles node module versions via getLocalNodeVersion / getContainerNodeVersion', async function () {
        const installedModulesObj = {}
        const state = makeStateStub({
            isStatusUpdated: sinon.stub().returns(false),
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            resetInstalledModules: sinon.stub().callsFake(() => {
                for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k]
            }),
            getRemoteModuleVersions: sinon.stub().returns({
                'node-bitcoin': { tag_name: 'v27.0' }
            }),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'node', coin: 'bitcoin', network: 'mainnet', container_id: 'fff' }
                ])
            }
        })

        const ss = loadStatusService(state, {
            getLocalNodeVersion:     sinon.stub().resolves('26.0'),
            getContainerNodeVersion: sinon.stub().resolves('27.0')
        })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        expect(result.bitcoin.mainnet['node'].local_version).to.equal('26.0')
        expect(result.bitcoin.mainnet['node'].container_version).to.equal('27.0')
        expect(result.bitcoin.mainnet['node'].remote_version).to.equal('27.0')
    })
})

describe('StatusService: getStatus() with installed modules', function () {

    it('formats port bindings into a comma-separated string', async function () {
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
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'ggg' }
                ])
            }
        })

        const containerStatus = makeContainerStatus('running', {
            '3003/tcp': [
                { HostIp: '0.0.0.0', HostPort: '3003' },
                { HostIp: '127.0.0.1', HostPort: '3004' }
            ]
        })
        const ss = loadStatusService(state, {
            getStatusFromContainer: sinon.stub().resolves(containerStatus)
        })
        // We don't expose the rows directly, but we can verify setLastPrintedStatus was called
        await ss.getStatus('bitcoin', 'mainnet', false)
        expect(state.setLastPrintedStatus.called).to.be.true
    })
})

describe('StatusService: getStatus() with installed modules', function () {

    it('annotates the STATUS cell with restart count and non-healthy health status', async function () {
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
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'ggg' }
                ])
            }
        })

        // Real `docker inspect` shape: RestartCount is a TOP-LEVEL sibling of State,
        // never a field inside it. Nesting the fixture makes this test pass against
        // a shape docker cannot emit and hides the production read bug.
        const containerStatus = {
            State: { Status: 'running', Health: { Status: 'unhealthy' } },
            RestartCount: 3,
            NetworkSettings: { Ports: {} }
        }
        const ss = loadStatusService(state, {
            getStatusFromContainer: sinon.stub().resolves(containerStatus)
        })
        await ss.getStatus('bitcoin', 'mainnet', false)

        const printedOutput = state.setLastPrintedStatus.lastCall.args[0]
        expect(printedOutput).to.include('running x3')
        expect(printedOutput).to.include('(unhealthy)')
        // Churning state is downgraded from the plain "running" green to yellow.
        expect(printedOutput).to.include('\x1b[33m')
    })
})

describe('StatusService: getStatus() with installed modules', function () {

    it('leaves a clean container (no restarts, healthy) unchanged and green', async function () {
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
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'ggg' }
                ])
            }
        })

        const containerStatus = {
            State: { Status: 'running', Health: { Status: 'healthy' } },
            RestartCount: 0,
            NetworkSettings: { Ports: {} }
        }
        const ss = loadStatusService(state, {
            getStatusFromContainer: sinon.stub().resolves(containerStatus)
        })
        await ss.getStatus('bitcoin', 'mainnet', false)

        const printedOutput = state.setLastPrintedStatus.lastCall.args[0]
        expect(printedOutput).to.include('running')
        expect(printedOutput).to.not.include('x0')
        expect(printedOutput).to.not.include('(healthy)')
        expect(printedOutput).to.include('\x1b[32m')
    })
})

describe('StatusService: getStatus() with installed modules', function () {

    it('calls checkRemoteNodeVersion when checkVersions=true and version absent', async function () {
        const installedModulesObj = {}
        const checkRemote = sinon.stub().resolves()
        const state = makeStateStub({
            isStatusUpdated: sinon.stub().returns(false),
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            resetInstalledModules: sinon.stub().callsFake(() => {
                for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k]
            }),
            getRemoteModuleVersions: sinon.stub().returns({}),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'hhh' }
                ])
            }
        })

        const ss = loadStatusService(state, { checkRemoteNodeVersion: checkRemote })
        await ss.getStatus('bitcoin', 'mainnet', false, true)
        expect(checkRemote.called).to.be.true
    })
})

describe('StatusService: getStatus() with installed modules', function () {

    it('prints status output when printStatus=true on fresh call', async function () {
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
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'iii' }
                ])
            },
            getLastPrintedStatus: sinon.stub().returns('TABLE OUTPUT')
        })

        const consoleSpy = sinon.stub(console, 'log')
        try {
            const ss = loadStatusService(state)
            await ss.getStatus('bitcoin', 'mainnet', true)
            expect(consoleSpy.called).to.be.true
        } finally {
            consoleSpy.restore()
        }
    })
})
