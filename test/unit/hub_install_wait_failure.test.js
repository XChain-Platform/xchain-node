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

const assert = require('node:assert/strict')
const sinon = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()
const { redactSecrets } = require('../../src/utils/helpers')

function load({ failures = [], pings = [] } = {}) {
    let pingCalls = 0
    const connector = {
        lastFailures: failures,
        async ping() { return pings[pingCalls++] || false }
    }
    class HubConnector { constructor() { return connector } }
    const releaseManifestService = {
        resolveComponentRef: () => ({ ref: 'develop', commit: null }),
        getActiveTarget: () => null,
        isReleaseRef: () => false,
        clearActiveTarget: () => {}
    }
    const service = proxyquire('../../src/services/hub_service', {
        '../state': {
            db: { getModuleContainer: sinon.stub().resolves(null) },
            getLastStatus: () => ({}),
            isStatusUpdated: () => false,
            isVerbose: () => false
        },
        '../utils/helpers': { sleep: async () => {}, redactSecrets },
        './config_service': {
            getDefaultConfig: async () => ({ HUB_PORT: 10000, HUB_DB_NAME: 'h', HUB_DB_USER: 'u', HUB_DB_PASS: 'p' }),
            getDockerContainerImageName: () => 'xchain-node-xchain-hub',
            getDockerNetwork: () => 'xchain-node'
        },
        './status_service': {
            getStatus: async () => {},
            getInstalledCoinsAndNetworks: async () => ({})
        },
        './docker_service': { addContainerToNetwork: async () => true },
        './module_service': { cloneGit: async () => {}, buildAndUp: async () => 'id' },
        './database_service': {
            addUserPasswordToDatabase: async () => {},
            getExternalDbConfig: async () => ({})
        },
        './db_credential_drift': {
            readContainerEnv: async () => ({}),
            assertNoHubDbCredentialDrift: async () => {}
        },
        './hub_connector.js': HubConnector,
        './release_manifest_service': releaseManifestService
    })
    return { service, connector, pingCalls: () => pingCalls }
}

describe('installHubModule reports the final hub ping failure', function () {
    it('includes every recorded endpoint cause', async function () {
        const failures = ['http://127.0.0.1:1 → timeout', 'http://127.0.0.1:2 → HTTP 401']
        const { service, pingCalls } = load({ failures })

        await assert.rejects(
            service.installHubModule('develop'),
            err => typeof err === 'string' && failures.every(failure => err.includes(failure))
        )
        expect(pingCalls()).to.equal(11)
    })

    it('redacts credentials from the recorded cause', async function () {
        const password = ['fake', 'password'].join('-')
        const { service } = load({ failures: ['http://user:' + password + '@127.0.0.1:1 → refused'] })

        await assert.rejects(
            service.installHubModule('develop'),
            err => String(err).includes('<redacted>') && !String(err).includes(password)
        )
    })

    it('keeps the original message when no cause was recorded', async function () {
        const { service } = load()
        await assert.rejects(service.installHubModule('develop'), err => err === "Couldn't install hub module")
    })

    it('still succeeds when a later ping answers', async function () {
        const { service } = load({ pings: [false, false, true] })
        expect(await service.installHubModule('develop')).to.equal(true)
    })
})
