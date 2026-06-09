'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

    return proxyquire('../../src/services/StatusService', {
        '../config/constants': {
            NODE_MODULE_NAME: 'node',
            SEP:              '-',
            Coin:    { BITCOIN: 'bitcoin', DOGECOIN: 'dogecoin', LITECOIN: 'litecoin' },
            Network: { MAINNET: 'mainnet', TESTNET: 'testnet', REGTEST: 'regtest' }
        },
        '../state': state,
        './DockerService': {
            getStatusFromContainer: getStatusFromContainerStub
        },
        './VersionService': {
            checkRemoteNodeVersion:     checkRemoteNodeVersionStub,
            getLocalNodeVersion:        getLocalNodeVersionStub,
            getContainerNodeVersion:    getContainerNodeVersionStub,
            getLocalModuleVersion:      getLocalModuleVersionStub,
            getContainerModuleVersion:  getContainerModuleVersionStub
        },
        // Lazy-required inside statusChanged
        './HubService':      { updateHub:      updateHubStub },
        './ExplorerService': { updateExplorer: updateExplorerStub },
        // Lazy-required inside getStatus (getModuleBranch)
        './ModuleService': { getModuleBranch: getModuleBranchStub }
    })
}

// ---------------------------------------------------------------------------
// statusChanged()
// ---------------------------------------------------------------------------

describe('StatusService — statusChanged()', function () {

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
})

// ---------------------------------------------------------------------------
// getStatus() — cache hit
// ---------------------------------------------------------------------------

describe('StatusService — getStatus() cache hit', function () {

    it('returns cached status immediately when isStatusUpdated is true', async function () {
        const cachedStatus = { bitcoin: { mainnet: {} } }
        const state = makeStateStub({
            isStatusUpdated: sinon.stub().returns(true),
            getLastStatus:   sinon.stub().returns(cachedStatus)
        })

        const ss = loadStatusService(state)
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        expect(result).to.equal(cachedStatus)
        // DB should not have been queried
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

// ---------------------------------------------------------------------------
// getStatus() — DB not ready
// ---------------------------------------------------------------------------

describe('StatusService — getStatus() DB not ready', function () {

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

// ---------------------------------------------------------------------------
// getStatus() — fresh, with installed modules
// ---------------------------------------------------------------------------

describe('StatusService — getStatus() with installed modules', function () {

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

    it('removes module from installedModules when getStatusFromContainer throws', async function () {
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
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'bbb' }
                ])
            }
        })

        const getStatusFromContainer = sinon.stub().rejects(new Error('container gone'))
        const ss = loadStatusService(state, { getStatusFromContainer })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        // Module should have been removed from the coin/network slot
        const coinNetModules = (result.bitcoin || {})[`mainnet`] || {}
        expect(coinNetModules['xchain-encoder']).to.be.undefined
    })

    it('cleans up empty coin slot when all containers fail', async function () {
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
                ])
            }
        })

        const getStatusFromContainer = sinon.stub().rejects(new Error('gone'))
        const ss = loadStatusService(state, { getStatusFromContainer })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        // bitcoin key should be cleaned up
        expect(result.bitcoin).to.be.undefined
    })

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

// ---------------------------------------------------------------------------
// getInstalledCoinsAndNetworks()
// ---------------------------------------------------------------------------

describe('StatusService — getInstalledCoinsAndNetworks()', function () {

    it('returns coins and networks filtered by known Coin/Network values', async function () {
        // getStatus will call loadInstalledModules which calls db.getAllModuleContainers
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
                    { module: 'xchain-encoder', coin: 'bitcoin',  network: 'mainnet', container_id: 'jjj' },
                    { module: 'xchain-encoder', coin: 'dogecoin', network: 'testnet', container_id: 'kkk' }
                ])
            }
        })

        const containerStatus = makeContainerStatus('running')
        const ss = loadStatusService(state, {
            getStatusFromContainer: sinon.stub().resolves(containerStatus)
        })
        const result = await ss.getInstalledCoinsAndNetworks()

        expect(result).to.have.property('bitcoin')
        expect(result.bitcoin).to.include('mainnet')
        expect(result).to.have.property('dogecoin')
        expect(result.dogecoin).to.include('testnet')
        // Unknown coins should be absent
        expect(result.ethereum).to.be.undefined
    })

    it('ignores coins that are not in the Coin enum', async function () {
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
                    { module: 'xchain-encoder', coin: 'ethereum', network: 'mainnet', container_id: 'lll' }
                ])
            }
        })

        const containerStatus = makeContainerStatus('running')
        const ss = loadStatusService(state, {
            getStatusFromContainer: sinon.stub().resolves(containerStatus)
        })
        const result = await ss.getInstalledCoinsAndNetworks()
        expect(result).to.not.have.property('ethereum')
    })

    it('returns empty object when no modules are installed', async function () {
        const state = makeStateStub({
            isStatusUpdated: sinon.stub().returns(false),
            getInstalledModules: sinon.stub().returns({}),
            resetInstalledModules: sinon.stub(),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([])
            }
        })

        const ss = loadStatusService(state)
        const result = await ss.getInstalledCoinsAndNetworks()
        expect(result).to.deep.equal({})
    })
})

// ---------------------------------------------------------------------------
// loadInstalledModules()
// ---------------------------------------------------------------------------

describe('StatusService — loadInstalledModules()', function () {

    it('populates installedModules from db.getAllModuleContainers', async function () {
        const installedModulesObj = {}
        const state = makeStateStub({
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'mmm' }
                ])
            }
        })

        const ss = loadStatusService(state)
        await ss.loadInstalledModules('bitcoin', 'mainnet', false)

        expect(installedModulesObj.bitcoin.mainnet['xchain-encoder'].container_id).to.equal('mmm')
    })

    it('calls checkRemoteNodeVersion when checkVersions=true', async function () {
        const checkRemote = sinon.stub().resolves()
        const state = makeStateStub({
            getInstalledModules: sinon.stub().returns({}),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([])
            }
        })

        const ss = loadStatusService(state, { checkRemoteNodeVersion: checkRemote })
        await ss.loadInstalledModules('bitcoin', 'mainnet', true)
        expect(checkRemote.calledWith('bitcoin', 'mainnet')).to.be.true
    })

    it('handles multiple modules for same coin/network', async function () {
        const installedModulesObj = {}
        const state = makeStateStub({
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'nnn' },
                    { module: 'xchain-decoder', coin: 'bitcoin', network: 'mainnet', container_id: 'ooo' }
                ])
            }
        })

        const ss = loadStatusService(state)
        await ss.loadInstalledModules('bitcoin', 'mainnet', false)

        expect(installedModulesObj.bitcoin.mainnet['xchain-encoder']).to.exist
        expect(installedModulesObj.bitcoin.mainnet['xchain-decoder']).to.exist
    })
})

// ---------------------------------------------------------------------------
// getStatus() — non-master branch display
// ---------------------------------------------------------------------------

describe('StatusService — getStatus() branch column', function () {

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
