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

// Hub provisioning runs before commander parses action arguments, so preCheck
// must receive the command ref explicitly. The hub is the config source for the
// remaining services and must use the same release ref.
describe('preCheck: the hub is staged at the ref the command named', function () {

    it('passes the ref through to installHubModule', async function () {
        const installHubModule = sinon.stub().resolves()
        const { precheck } = loadPrecheck({ installHubModule })

        await precheck.preCheck(false, true, 'release/v0.10.0')

        expect(installHubModule.calledOnce).to.be.true
        expect(installHubModule.firstCall.args[0]).to.equal('release/v0.10.0')
    })

    it('passes null when the command named no ref, preserving the old behaviour', async function () {
        const installHubModule = sinon.stub().resolves()
        const { precheck } = loadPrecheck({ installHubModule })

        await precheck.preCheck(false, true)

        expect(installHubModule.calledOnce).to.be.true
        expect(installHubModule.firstCall.args[0]).to.equal(null)
    })
})
