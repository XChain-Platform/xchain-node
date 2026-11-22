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

// A run that lost XCHAIN_NODE_EXTERNAL_DB on a host recorded as external-DB is refused by
// buildDatabaseModule. preCheck must hand that refusal to the operator as it is: wrapping it in the
// generic "error installing the mariadb container" hides the one thing they need to fix.

const sinon      = require('sinon')
const { configStub } = require('../../helpers/config_stub')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

function loadPrecheck(buildDatabaseModule) {
    return proxyquire('../../../src/precheck.js', {
        'fs': { existsSync: () => true, mkdirSync: () => {} },
        './config': configStub({
            dataDir: '/tmp/x', moduleDir: '/tmp/x', tmpDir: '/tmp/x', containersFilesDir: '/tmp/x', EXTERNAL_DB: false
        }),
        './state': { db: { createDatabase: sinon.stub().resolves() }, isVerbose: () => false },
        './utils/helpers': { redactSecrets: (e) => e },
        './services/docker_service': {
            checkDockerInstalledAndReachable: sinon.stub().resolves(),
            createDockerNetwork:               sinon.stub().resolves(),
            checkContainerdDataRootRelocation: sinon.stub().resolves(null),
            checkMemoryLimitSupport:           sinon.stub().resolves(null)
        },
        './services/config_service':   { getDockerNetwork: () => 'xchain', applyHubApiKeyFromSidecar: sinon.stub().resolves() },
        './services/version_service':  { checkAllRemoteVersions: sinon.stub().resolves() },
        './services/status_service':    { getStatus: sinon.stub().resolves() },
        './services/hub_service':      { installHubModule: sinon.stub().resolves(), updateHub: sinon.stub().resolves(), isHubAnswering: sinon.stub().resolves(true) },
        './services/explorer_service': { updateExplorer: sinon.stub().resolves() },
        './services/database_service': {
            buildDatabaseModule,
            ensureXchainNodeAccess: sinon.stub().resolves({ user: 'u', password: 'p', database: 'xchain_node' }),
            getDatabaseHostPort:    sinon.stub().resolves(13306),
            getExternalDbConfig:    sinon.stub().resolves({})
        },
        './services/discovery_service': { scanAndRegisterModules: sinon.stub().resolves() }
    })
}

describe('preCheck: a lost external-DB flag surfaces its own refusal @regression', function () {

    it('rethrows the EXTERNAL_DB_MODE_LOST refusal unchanged', async function () {
        const refusal = Object.assign(new Error('XCHAIN_NODE_EXTERNAL_DB=1 is not set for this run'), { code: 'EXTERNAL_DB_MODE_LOST' })
        const precheck = loadPrecheck(sinon.stub().rejects(refusal))
        const err = await precheck.preCheck(false, true, null, false).then(() => null, (e) => e)
        expect(err).to.equal(refusal)
    })

    it('still wraps any other install failure in the generic message', async function () {
        const precheck = loadPrecheck(sinon.stub().rejects(new Error('docker run failed')))
        const err = await precheck.preCheck(false, true, null, false).then(() => null, (e) => e)
        expect(err.message).to.equal('There was an error installing the mariadb container')
    })
})
