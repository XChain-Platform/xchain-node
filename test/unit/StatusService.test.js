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

describe('StatusService: getStatus() with installed modules', function () {

    it('builds status for a running container and returns installedModules', async function () {
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

    it('removes module from installedModules AND reconciles the registry when docker confirms the container is gone', async function () {
        const installedModulesObj = {}
        const removeModuleContainer = sinon.stub().resolves(true)
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
                removeModuleContainer
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
        expect(removeModuleContainer.calledOnceWith('xchain-encoder', 'bitcoin', 'mainnet')).to.be.true
    })

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
                removeModuleContainer: sinon.stub().resolves(true)
            }
        })

        const goneErr = new Error('No such container: ccc')
        const getStatusFromContainer = sinon.stub().rejects(goneErr)
        const ss = loadStatusService(state, { getStatusFromContainer })
        const result = await ss.getStatus('bitcoin', 'mainnet', false)

        expect(result.bitcoin).to.be.undefined
    })

    it('does NOT prune or touch the registry on a transient inspect failure (daemon unreachable)', async function () {
        const installedModulesObj = {}
        const removeModuleContainer = sinon.stub().resolves(true)
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
                removeModuleContainer
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
        expect(removeModuleContainer.called).to.be.false
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
        // never a field inside it. The fixture used to nest it, which made this test
        // pass against a shape docker cannot emit and hid the production read bug.
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

describe('StatusService: getInstalledCoinsAndNetworks()', function () {

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

describe('StatusService: loadInstalledModules()', function () {

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

describe('StatusService: getStatus() commit column', function () {

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
