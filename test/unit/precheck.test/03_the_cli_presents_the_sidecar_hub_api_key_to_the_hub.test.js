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

// `validator init` stores HUB_API_KEY in config/hub.local while HubConnector
// sends process.env.HUB_API_KEY. Precheck bridges the sidecar key into the
// process environment before installing the hub or pushing its config.
describe('preCheck: the CLI presents the sidecar HUB_API_KEY to the hub @regression', function () {

    const saved = process.env.HUB_API_KEY
    afterEach(function () {
        if (saved === undefined) delete process.env.HUB_API_KEY
        else process.env.HUB_API_KEY = saved
    })

    it('hydrates process.env from the sidecar before the hub is installed or pushed to', async function () {
        delete process.env.HUB_API_KEY
        const applyHubApiKeyFromSidecar = sinon.stub().callsFake(async (target) => {
            target.HUB_API_KEY = 'sidecar-key'
        })
        const installHubModule = sinon.stub().callsFake(async () => {
            expect(process.env.HUB_API_KEY).to.equal('sidecar-key')
        })
        const updateHub = sinon.stub().callsFake(async () => {
            expect(process.env.HUB_API_KEY).to.equal('sidecar-key')
        })
        const { precheck } = loadPrecheck({ applyHubApiKeyFromSidecar, installHubModule, updateHub })

        await precheck.preCheck(false, true)

        expect(applyHubApiKeyFromSidecar.calledOnce).to.be.true
        expect(applyHubApiKeyFromSidecar.firstCall.args[0]).to.equal(process.env)
        expect(installHubModule.calledOnce).to.be.true
        expect(updateHub.calledOnce).to.be.true
        expect(applyHubApiKeyFromSidecar.calledBefore(installHubModule)).to.be.true
    })

    it('runs the hydration through the real sidecar reader with a host-env key left untouched', async function () {
        // Host environment values take priority, while a missing sidecar leaves
        // an unset key unset.
        const cs = require('../../../src/services/config_service')
        process.env.HUB_API_KEY = 'host-env-key'
        await cs.applyHubApiKeyFromSidecar(process.env)
        expect(process.env.HUB_API_KEY).to.equal('host-env-key')
    })

    it('is a no-op on a host with no sidecar (a standalone install stays keyless)', async function () {
        delete process.env.HUB_API_KEY
        const { precheck, stubs } = loadPrecheck({})
        await precheck.preCheck(false, true)
        expect(stubs.applyHubApiKeyFromSidecar.calledOnce).to.be.true
        expect(process.env.HUB_API_KEY).to.equal(undefined)
    })
})
