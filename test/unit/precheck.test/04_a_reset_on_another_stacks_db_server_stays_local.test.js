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

// `reset --db-container` resets a stack this CLI did not install. Its preCheck stops after the docker and
// directory checks: provisioning the bundled DB, scanning containers into the registry, installing the hub and
// pushing config would all act on this CLI's own stack, and the push would overwrite the hub's and explorer's
// view of the other stack with this CLI's DB hosts.

const sinon      = require('sinon')
const { configStub } = require('../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function loadPrecheck() {
    const stubs = {
        checkDockerInstalledAndReachable: sinon.stub().resolves(),
        createDatabase:          sinon.stub().resolves(),
        buildDatabaseModule:     sinon.stub().resolves(),
        ensureXchainNodeAccess:  sinon.stub().resolves({ user: 'u', password: 'p', database: 'xchain_node' }),
        scanAndRegisterModules:  sinon.stub().resolves(),
        getStatus:               sinon.stub().resolves(),
        installHubModule:        sinon.stub().resolves(),
        updateHub:               sinon.stub().resolves(),
        updateExplorer:          sinon.stub().resolves()
    }
    const precheck = proxyquire('../../../src/precheck.js', {
        'fs': { existsSync: () => true, mkdirSync: () => {} },
        './config': configStub({
            dataDir: '/tmp/x', moduleDir: '/tmp/x', tmpDir: '/tmp/x', containersFilesDir: '/tmp/x', EXTERNAL_DB: false
        }),
        './state': { db: { createDatabase: stubs.createDatabase }, isVerbose: () => false },
        './utils/helpers': { redactSecrets: (e) => e },
        './services/docker_service': {
            checkDockerInstalledAndReachable: stubs.checkDockerInstalledAndReachable,
            createDockerNetwork:               sinon.stub().resolves(),
            checkContainerdDataRootRelocation: sinon.stub().resolves(null),
            checkMemoryLimitSupport:           sinon.stub().resolves(null)
        },
        './services/config_service':   { getDockerNetwork: () => 'xchain', applyHubApiKeyFromSidecar: sinon.stub().resolves() },
        './services/version_service':  { checkAllRemoteVersions: sinon.stub().resolves() },
        './services/status_service':   { getStatus: stubs.getStatus },
        './services/hub_service':      { installHubModule: stubs.installHubModule, updateHub: stubs.updateHub, isHubAnswering: sinon.stub().resolves(true) },
        './services/explorer_service': { updateExplorer: stubs.updateExplorer },
        './services/database_service': {
            buildDatabaseModule:    stubs.buildDatabaseModule,
            ensureXchainNodeAccess: stubs.ensureXchainNodeAccess,
            getDatabaseHostPort:    sinon.stub().resolves(13306),
            getExternalDbConfig:    sinon.stub().resolves({})
        },
        './services/discovery_service': { scanAndRegisterModules: stubs.scanAndRegisterModules }
    })
    return { precheck, stubs }
}

const SHARED_STEPS = ['buildDatabaseModule', 'ensureXchainNodeAccess', 'createDatabase', 'scanAndRegisterModules',
    'getStatus', 'installHubModule', 'updateHub', 'updateExplorer']

describe('preCheck: a reset on another stack\'s DB server stays local @regression', function () {

    it('runs only the docker check, and none of the bundled DB, registry, hub or push steps', async function () {
        const { precheck, stubs } = loadPrecheck()
        expect(await precheck.preCheck(false, true, null, false, { localOnly: true })).to.be.true
        expect(stubs.checkDockerInstalledAndReachable.calledOnce).to.be.true
        for (const step of SHARED_STEPS) expect(stubs[step].called, step).to.be.false
    })

    it('still runs every step when the option is absent', async function () {
        const { precheck, stubs } = loadPrecheck()
        await precheck.preCheck(false, true, null, false)
        for (const step of SHARED_STEPS) expect(stubs[step].calledOnce, step).to.be.true
    })
})
