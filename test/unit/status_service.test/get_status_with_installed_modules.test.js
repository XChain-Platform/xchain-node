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

    it('builds status for a running container and returns installedModules', async function () {
        // One installed module row in DB
        const installedModulesObj = {}
        const state = makeStateStub({
            isStatusUpdated:  sinon.stub().returns(false),
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            resetInstalledModules: sinon.stub().callsFake(() => {
                // clear the object in-place (simulate resetInstalledModules)
                for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k]
            }),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'aaa' }
                ])
            }
        })

        const containerStatus = makeContainerStatus('running', {
            '3003/tcp': [{ HostIp: '0.0.0.0', HostPort: '3003' }]
        })
        const getStatusFromContainer = sinon.stub().resolves(containerStatus)

        const ss = loadStatusService(state, { getStatusFromContainer })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        expect(result).to.be.an('object')
        expect(result.bitcoin.mainnet['xchain-encoder']).to.exist
        expect(result.bitcoin.mainnet['xchain-encoder'].status).to.equal(containerStatus)
        expect(state.setLastStatus.calledOnce).to.be.true
        expect(state.setStatusUpdated.calledWith(true)).to.be.true
    })
})

describe('StatusService: getStatus() with installed modules', function () {

    it('removes module from installedModules AND reconciles the registry when docker confirms the container is gone', async function () {
        const installedModulesObj = {}
        const deleteModuleContainer = sinon.stub().resolves(true)
        const state = makeStateStub({
            isStatusUpdated:  sinon.stub().returns(false),
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            resetInstalledModules: sinon.stub().callsFake(() => {
                for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k]
            }),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'bbb' }
                ]),
                deleteModuleContainer
            }
        })

        // Realistic `docker inspect` failure for a container that no longer exists.
        const goneErr = new Error('Command failed: docker inspect bbb\nError: No such object: bbb')
        goneErr.stderr = 'Error: No such object: bbb\n'
        const getStatusFromContainer = sinon.stub().rejects(goneErr)
        const ss = loadStatusService(state, { getStatusFromContainer })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        const coinNetModules = (result.bitcoin || {})[`mainnet`] || {}
        expect(coinNetModules['xchain-encoder']).to.be.undefined
        // ...and the persistent registry row reconciled, not only in-memory status.
        expect(deleteModuleContainer.calledOnceWith('xchain-encoder', 'bitcoin', 'mainnet')).to.be.true
    })
})

describe('StatusService: getStatus() with installed modules', function () {

    it('cleans up empty coin slot when all containers are confirmed gone', async function () {
        const installedModulesObj = {}
        const state = makeStateStub({
            isStatusUpdated:  sinon.stub().returns(false),
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            resetInstalledModules: sinon.stub().callsFake(() => {
                for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k]
            }),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'ccc' }
                ]),
                deleteModuleContainer: sinon.stub().resolves(true)
            }
        })

        const goneErr = new Error('No such container: ccc')
        const getStatusFromContainer = sinon.stub().rejects(goneErr)
        const ss = loadStatusService(state, { getStatusFromContainer })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        expect(result.bitcoin).to.be.undefined
    })
})

describe('StatusService: getStatus() with installed modules', function () {

    it('does NOT prune or touch the registry on a transient inspect failure (daemon unreachable)', async function () {
        const installedModulesObj = {}
        const deleteModuleContainer = sinon.stub().resolves(true)
        const state = makeStateStub({
            isStatusUpdated:  sinon.stub().returns(false),
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            resetInstalledModules: sinon.stub().callsFake(() => {
                for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k]
            }),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'ddd' }
                ]),
                deleteModuleContainer
            }
        })

        // Daemon-down: the container may well still be live, so dropping it here
        // would silently orphan it and let uninstall false-succeed.
        const transientErr = new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')
        const getStatusFromContainer = sinon.stub().rejects(transientErr)
        const ss = loadStatusService(state, { getStatusFromContainer })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        // Module is retained with an explicit unknown state...
        const mod = result.bitcoin.mainnet['xchain-encoder']
        expect(mod).to.exist
        expect(mod.status.State.Status).to.equal('unknown')
        // ...and no registry row is deleted on an ambiguous/transient failure.
        expect(deleteModuleContainer.called).to.be.false
    })
})

describe('StatusService: getStatus() with installed modules', function () {

    it('sets remote_version on module from remoteModuleVersions', async function () {
        const installedModulesObj = {}
        const state = makeStateStub({
            isStatusUpdated: sinon.stub().returns(false),
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            resetInstalledModules: sinon.stub().callsFake(() => {
                for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k]
            }),
            getRemoteModuleVersions: sinon.stub().returns({
                'xchain-encoder': '1.2.3'
            }),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'ddd' }
                ])
            }
        })

        const ss = loadStatusService(state)
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        expect(result.bitcoin.mainnet['xchain-encoder'].remote_version).to.equal('1.2.3')
    })
})

describe('StatusService: getStatus() with installed modules', function () {

    it('sets local_version and container_version on module', async function () {
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
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'eee' }
                ])
            }
        })

        const ss = loadStatusService(state, {
            getLocalModuleVersion:    sinon.stub().resolves('1.5.0'),
            getContainerModuleVersion: sinon.stub().resolves('1.4.0')
        })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        expect(result.bitcoin.mainnet['xchain-encoder'].local_version).to.equal('1.5.0')
        expect(result.bitcoin.mainnet['xchain-encoder'].container_version).to.equal('1.4.0')
    })
})
