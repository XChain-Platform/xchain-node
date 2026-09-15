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

function loadPrecheck(overrides) {
    const stubs = Object.assign({
        externalDb:          false,
        getExternalDbConfig: sinon.stub().resolves({}),
        getDatabaseHostPort: sinon.stub().resolves(13306),
        createDatabase:      sinon.stub().resolves(),
        checkAllRemoteVersions: sinon.stub().resolves(),
        getStatus:              sinon.stub().resolves(),
        checkContainerdDataRootRelocation: sinon.stub().resolves(null),
        checkMemoryLimitSupport: sinon.stub().resolves(null),
        updateHub:              sinon.stub().resolves(),
        updateExplorer:         sinon.stub().resolves(),
        installHubModule:       sinon.stub().resolves(),
        // The default hub answers so each test can select the branch it exercises.
        isHubAnswering:         sinon.stub().resolves(true),
        applyHubApiKeyFromSidecar: sinon.stub().resolves()
    }, overrides)

    const precheck = proxyquire('../../../src/precheck.js', {
        'fs': { existsSync: () => true, mkdirSync: () => {} },
        './config': configStub({
            dataDir: '/tmp/x', moduleDir: '/tmp/x', tmpDir: '/tmp/x', containersFilesDir: '/tmp/x',
            EXTERNAL_DB: stubs.externalDb
        }),
        './state': { db: { createDatabase: stubs.createDatabase }, isVerbose: () => false },
        './utils/helpers': { redactSecrets: (e) => e },
        './services/docker_service': {
            checkDockerInstalledAndReachable: sinon.stub().resolves(),
            createDockerNetwork:              sinon.stub().resolves(),
            checkContainerdDataRootRelocation: stubs.checkContainerdDataRootRelocation,
            checkMemoryLimitSupport:           stubs.checkMemoryLimitSupport
        },
        './services/config_service':    {
            getDockerNetwork:          () => 'xchain',
            applyHubApiKeyFromSidecar: stubs.applyHubApiKeyFromSidecar
        },
        './services/version_service':   { checkAllRemoteVersions: stubs.checkAllRemoteVersions },
        './services/status_service':    { getStatus: stubs.getStatus },
        './services/hub_service':       {
            installHubModule: stubs.installHubModule,
            updateHub:        stubs.updateHub,
            isHubAnswering:   stubs.isHubAnswering
        },
        './services/explorer_service':  { updateExplorer: stubs.updateExplorer },
        './services/database_service': {
            buildDatabaseModule:   sinon.stub().resolves(),
            ensureXchainNodeAccess: sinon.stub().resolves({ user: 'u', password: 'p', database: 'xchain_node' }),
            getDatabaseHostPort:   stubs.getDatabaseHostPort,
            getExternalDbConfig:   stubs.getExternalDbConfig
        },
        './services/discovery_service': { scanAndRegisterModules: sinon.stub().resolves() }
    })
    return { precheck, stubs }
}

// A crash-looping hub answers no liveness probes. Repairing commands skip the
// config push so they can rebuild the hub; other commands retain normal failure
// behavior.
const refused = () => sinon.stub().rejects(
    new Error('There was a problem trying to update a config in the xchain-hub module (connect ECONNREFUSED)'))

describe('preCheck(): a hub that is not answering does not wedge its own repair @regression', function () {
    it('lets a repairing command through on a warning, skipping the push', async function () {
        const updateHub = sinon.stub().resolves()
        const { precheck, stubs } = loadPrecheck({
            isHubAnswering: sinon.stub().resolves(false),
            updateHub
        })
        const log = sinon.stub(console, 'log')
        let result = null
        try {
            result = await precheck.preCheck(false, true, null, true)
        } finally {
            log.restore()
        }

        expect(result).to.be.true
        // Skipping the push avoids ten retries spaced three seconds apart.
        expect(updateHub.calledOnce).to.be.true
        expect(updateHub.firstCall.args[0]).to.deep.equal({ skipConfigPush: true })
        // The explorer is a separate target and is still pushed to.
        expect(stubs.updateExplorer.calledOnce).to.be.true
        expect(log.args.some(a => String(a[0]).includes('config push was skipped'))).to.be.true
    })

    it('still continues when the skipped push leaves updateHub rejecting anyway', async function () {
        // Network attachments can fail independently; a repairing command must
        // continue so it can rebuild the hub.
        const { precheck } = loadPrecheck({
            isHubAnswering: sinon.stub().resolves(false),
            updateHub: sinon.stub().rejects(new Error('xchain-hub -> bitcoin/regtest unreachable'))
        })
        const log = sinon.stub(console, 'log')
        let result = null
        try {
            result = await precheck.preCheck(false, true, null, true)
        } finally {
            log.restore()
        }
        expect(result).to.be.true
        expect(log.args.some(a => String(a[0]).includes('bitcoin/regtest'))).to.be.true
    })
})

describe('preCheck(): a hub that is not answering does not wedge its own repair @regression', function () {
    it('a NON-repairing command still aborts against a hub that is not answering', async function () {
        const updateHub = refused()
        const { precheck } = loadPrecheck({
            isHubAnswering: sinon.stub().resolves(false),
            updateHub
        })
        const log = sinon.stub(console, 'log')
        let threw = null
        try {
            await precheck.preCheck(false, true, null, false)
        } catch (err) {
            threw = err
        } finally {
            log.restore()
        }

        expect(threw).to.be.an('error')
        // The error names the repair command for the operator.
        expect(threw.message).to.contain('There was an error trying to update the hub module')
        expect(threw.message).to.contain('not answering')
        expect(threw.message).to.contain('update xchain-hub')
        // Commands that require the hub still attempt the push.
        expect(updateHub.firstCall.args[0]).to.deep.equal({ skipConfigPush: false })
    })

    it('a repairing command against a HEALTHY hub still pushes and still fails on a real error', async function () {
        const updateHub = refused()
        const { precheck } = loadPrecheck({
            isHubAnswering: sinon.stub().resolves(true),
            updateHub
        })
        const log = sinon.stub(console, 'log')
        let threw = null
        try {
            await precheck.preCheck(false, true, null, true)
        } catch (err) {
            threw = err
        } finally {
            log.restore()
        }

        expect(threw).to.be.an('error')
        // A hub that answers gets the generic message without a repair hint.
        expect(threw.message).to.equal('There was an error trying to update the hub module')
        expect(updateHub.firstCall.args[0]).to.deep.equal({ skipConfigPush: false })
    })
})

describe('preCheck(): a hub that is not answering does not wedge its own repair @regression', function () {
    it('treats a liveness probe that throws as "not answering"', async function () {
        const { precheck } = loadPrecheck({
            isHubAnswering: sinon.stub().rejects(new Error('no hub config on this host')),
            updateHub: sinon.stub().resolves()
        })
        const log = sinon.stub(console, 'log')
        let result = null
        try {
            result = await precheck.preCheck(false, true, null, true)
        } finally {
            log.restore()
        }
        expect(result).to.be.true
        expect(log.args.some(a => String(a[0]).includes('config push was skipped'))).to.be.true
    })

    it('is not consulted at all for a read-only command that skips the push', async function () {
        const { precheck, stubs } = loadPrecheck({})
        await precheck.preCheck(false, false, null, true)
        expect(stubs.isHubAnswering.called).to.be.false
        expect(stubs.updateHub.called).to.be.false
    })

    // Hydrate the sidecar key before any hub request, including the liveness probe.
    it('hydrates the sidecar key before the liveness probe on the unhealthy path', async function () {
        const saved = process.env.HUB_API_KEY
        delete process.env.HUB_API_KEY
        const applyHubApiKeyFromSidecar = sinon.stub().callsFake(async (target) => {
            target.HUB_API_KEY = 'sidecar-key'
        })
        const isHubAnswering = sinon.stub().callsFake(async () => {
            expect(process.env.HUB_API_KEY).to.equal('sidecar-key')
            return false
        })
        const { precheck } = loadPrecheck({
            applyHubApiKeyFromSidecar, isHubAnswering, updateHub: sinon.stub().resolves()
        })
        const log = sinon.stub(console, 'log')
        try {
            await precheck.preCheck(false, true, null, true)
        } finally {
            log.restore()
            if (saved === undefined) delete process.env.HUB_API_KEY
            else process.env.HUB_API_KEY = saved
        }
        expect(applyHubApiKeyFromSidecar.calledOnce).to.be.true
        expect(isHubAnswering.calledOnce).to.be.true
        expect(applyHubApiKeyFromSidecar.calledBefore(isHubAnswering)).to.be.true
    })
})
