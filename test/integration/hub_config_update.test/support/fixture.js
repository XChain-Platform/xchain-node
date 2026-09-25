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

const proxyquire = require('proxyquire').noCallThru()

const TestEnv     = require('../../helpers/test-env')
const HttpCapture = require('../../helpers/http-capture')

/**
 * Create HubService with stubbed dependencies:
 * - DockerService (network ops)
 * - Axios via HubConnector/ExplorerConnector
 * - Real ConfigService, and the registry via env
 */
function makeHubService(httpCapture, options = {}) {
    const axiosStub = httpCapture.createAxiosStub()

    // Hub connector using our HTTP capture
    const HubConnector = proxyquire('../../../../src/services/hub_connector', {
        'axios': axiosStub
    })

    const ExplorerConnector = proxyquire('../../../../src/services/explorer_connector', {
        'axios': axiosStub
    })

    // Status service that returns data from the registry
    const statusState = require('../../../../src/state')

    const HubService = proxyquire('../../../../src/services/hub_service', {
        './hub_connector.js': HubConnector,
        './docker_service': {
            addContainerToNetwork: async () => true,
            getStatusFromContainer: async (id) => ({
                State: { Status: 'running' },
                NetworkSettings: { Ports: {}, Networks: {} }
            }),
            stringToDockerContainerFile: async () => true
        },
        './module_service': {
            cloneGit: async () => true,
            buildAndUp: async () => TestEnv.fakeContainerId('h')
        },
        '../utils/helpers': {
            sleep: async () => {},
            redactSecrets: require('../../../../src/utils/helpers').redactSecrets
        }
    })

    return { HubService, HubConnector, ExplorerConnector }
}

function hubConfigSuite(title, registerTests) {
    describe('Integration: Hub/Explorer Config Update', function () {
        this.timeout(15000)

        let env, httpCapture

        beforeEach(async function () {
            env = new TestEnv()
            await env.setup()
            env.patchConstants()
            httpCapture = new HttpCapture()
        })

        afterEach(async function () {
            await env.teardown()
        })

        describe(title, function () {
            registerTests(() => ({
                env,
                httpCapture,
                makeHubService: (options) => makeHubService(httpCapture, options),
                TestEnv
            }))
        })
    })
}

module.exports = { hubConfigSuite }
