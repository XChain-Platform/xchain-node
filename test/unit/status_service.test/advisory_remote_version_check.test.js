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

// The shape the GitHub client actually throws on a rate limit.
function rateLimited() {
    const err = new Error('GitHub API rate limit exceeded (HTTP 403); resets at 17:07Z')
    err.status = 403
    return err
}

function stateWithCoins(rows) {
    const installedModulesObj = {}
    return makeStateStub({
        isStatusUpdated: sinon.stub().returns(false),
        getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
        resetInstalledModules: sinon.stub().callsFake(() => {
            for (const k of Object.keys(installedModulesObj)) delete installedModulesObj[k]
        }),
        db: {
            isReady: sinon.stub().returns(true),
            getAllModuleContainers: sinon.stub().resolves(rows)
        }
    })
}

// The remote node version is advisory: it fills one column. It is fetched from
// the GitHub releases API, which answers 403 once an unauthenticated host
// crosses its rate limit (measured on a validator host 2026-09-12). A rejection
// escaping either checkRemoteNodeVersion call site reaches precheck, which
// aborts the command outright: `update` refuses to deploy and `status` refuses
// to print the table it already has every other column for.
describe('StatusService: the advisory remote-version check never aborts the command', function () {

    it('loadInstalledModules still registers containers when the version check is rate-limited', async function () {
        const installedModulesObj = {}
        const state = makeStateStub({
            getInstalledModules: sinon.stub().callsFake(() => installedModulesObj),
            db: {
                isReady: sinon.stub().returns(true),
                getAllModuleContainers: sinon.stub().resolves([
                    { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'ppp' }
                ])
            }
        })
        const log = sinon.stub(console, 'log')
        let threw = null
        try {
            const ss = loadStatusService(state, {
                checkRemoteNodeVersion: sinon.stub().rejects(rateLimited())
            })
            await ss.loadInstalledModules('bitcoin', 'mainnet', true)
        } catch (err) { threw = err } finally { log.restore() }

        expect(threw).to.equal(null)
        // The work the caller actually asked for still happened.
        expect(installedModulesObj.bitcoin.mainnet['xchain-encoder'].container_id).to.equal('ppp')
        const lines = log.getCalls().map(c => String(c.args[0])).join('\n')
        expect(lines).to.contain('continuing without version check')
    })
})

describe('StatusService: the advisory remote-version check never aborts the command', function () {

    it('getStatus completes and returns the table when the per-coin version check is rate-limited', async function () {
        const state = stateWithCoins([
            { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', container_id: 'qqq' }
        ])
        const log = sinon.stub(console, 'log')
        let threw = null
        let result = null
        try {
            const ss = loadStatusService(state, {
                checkRemoteNodeVersion: sinon.stub().rejects(rateLimited()),
                getStatusFromContainer: sinon.stub().resolves(makeContainerStatus('running'))
            })
            result = await ss.getStatus(null, null, false, true)
        } catch (err) { threw = err } finally { log.restore() }

        expect(threw).to.equal(null)
        expect(result).to.have.property('bitcoin')
        expect(result.bitcoin.mainnet['xchain-encoder'].status).to.exist
    })
})

describe('StatusService: the advisory remote-version check never aborts the command', function () {

    // A three-coin host must not print the same GitHub failure three times: the
    // warning is one line per status pass, and every coin is still attempted.
    it('warns once per pass while still attempting every coin', async function () {
        const state = stateWithCoins([
            { module: 'xchain-encoder', coin: 'bitcoin',  network: 'mainnet', container_id: 'r1' },
            { module: 'xchain-encoder', coin: 'dogecoin', network: 'mainnet', container_id: 'r2' },
            { module: 'xchain-encoder', coin: 'litecoin', network: 'mainnet', container_id: 'r3' }
        ])
        const checkRemote = sinon.stub().rejects(rateLimited())
        const log = sinon.stub(console, 'log')
        try {
            const ss = loadStatusService(state, {
                checkRemoteNodeVersion: checkRemote,
                getStatusFromContainer: sinon.stub().resolves(makeContainerStatus('running'))
            })
            await ss.getStatus(null, null, false, true)
        } finally { log.restore() }

        // One pass-level call plus one per coin: nothing was skipped because an
        // earlier coin failed.
        expect(checkRemote.callCount).to.equal(4)
        const warnings = log.getCalls()
            .map(c => String(c.args[0]))
            .filter(l => l.includes('continuing without version check'))
        expect(warnings).to.have.length(1)
    })
})

describe('StatusService: the advisory remote-version check never aborts the command', function () {

    // The degrade must not become a silent swallow of the working case: when
    // GitHub answers, the remote version still reaches the table.
    it('still fills the remote version column when GitHub answers', async function () {
        const state = stateWithCoins([
            { module: 'node', coin: 'bitcoin', network: 'mainnet', container_id: 's1' }
        ])
        state.getRemoteModuleVersions = sinon.stub().returns({ 'node-bitcoin': { tag_name: 'v28.1' } })
        const ss = loadStatusService(state, {
            checkRemoteNodeVersion: sinon.stub().resolves(),
            getStatusFromContainer: sinon.stub().resolves(makeContainerStatus('running'))
        })
        const result = await ss.getStatus(null, null, false, true)
        expect(result.bitcoin.mainnet['node'].remote_version).to.equal('28.1')
    })
})
