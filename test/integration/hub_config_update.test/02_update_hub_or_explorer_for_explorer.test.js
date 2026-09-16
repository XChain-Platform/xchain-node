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

const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { hubConfigSuite } = require('./support/fixture')

hubConfigSuite('updateHubOrExplorer for explorer', function (fixture) {

    it('writes config.json to explorer container via docker exec', async function () {
        const { env, TestEnv } = fixture()
        const state = require('../../../src/state')

        const explorerId = TestEnv.fakeContainerId('x')
        const encId = TestEnv.fakeContainerId('e')
        await env.insertModule('xchain-explorer', '', '', explorerId)
        await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', encId)

        env.writeConfigFile('bitcoin-mainnet', '')
        state.setStatusUpdated(true)
        state.setLastStatus({
            'bitcoin': {
                'mainnet': {
                    'xchain-encoder': { container_id: encId, status: { State: { Status: 'running' } } }
                }
            }
        })

        let writtenData = null
        let writtenPath = null

        const HubService = proxyquire('../../../src/services/hub_service', {
            './hub_connector.js': function () { return { ping: async () => true, updateConfig: async () => true } },
            './docker_service': {
                addContainerToNetwork: async () => true,
                getStatusFromContainer: async () => ({ State: { Status: 'running' }, NetworkSettings: { Ports: {}, Networks: {} } }),
                stringToDockerContainerFile: async (containerId, data, filePath) => {
                    writtenData = data
                    writtenPath = filePath
                    return true
                }
            },
            './module_service': {
                cloneGit: async () => true,
                buildAndUp: async () => explorerId
            },
            '../utils/helpers': {
                sleep: async () => {}
            }
        })

        await HubService.updateHubOrExplorer('xchain-explorer')

        expect(writtenPath).to.equal('/XChainExplorer/src/config.json')
        expect(writtenData).to.be.a('string')

        const parsed = JSON.parse(writtenData)
        expect(parsed).to.be.an('array')
        expect(parsed.length).to.be.greaterThan(0)
        expect(parsed[0].coin).to.equal('bitcoin')
        expect(parsed[0].network).to.equal('mainnet')
        expect(parsed[0]['xchain-encoder']).to.exist
    })
})
