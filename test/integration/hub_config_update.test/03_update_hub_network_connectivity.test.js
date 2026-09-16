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

hubConfigSuite('updateHub network connectivity', function (fixture) {

    it('connects hub container to all installed coin/network Docker networks', async function () {
        const { env, httpCapture, TestEnv } = fixture()
        const state = require('../../../src/state')

        const hubId = TestEnv.fakeContainerId('h')
        const encId = TestEnv.fakeContainerId('e')
        const decId = TestEnv.fakeContainerId('d')

        await env.insertModule('xchain-hub', '', '', hubId)
        await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', encId)
        await env.insertModule('xchain-decoder', 'dogecoin', 'testnet', decId)

        env.writeConfigFile('bitcoin-mainnet', '')
        env.writeConfigFile('dogecoin-testnet', '')

        state.setStatusUpdated(true)
        state.setLastStatus({
            'bitcoin': { 'mainnet': { 'xchain-encoder': { container_id: encId, status: { State: { Status: 'running' } } } } },
            'dogecoin': { 'testnet': { 'xchain-decoder': { container_id: decId, status: { State: { Status: 'running' } } } } },
            '': { '': { 'xchain-hub': { container_id: hubId, status: { State: { Status: 'running' } } } } }
        })

        const networkConnections = []
        httpCapture.when('127.0.0.1:10000').returns({ data: { result: true } })

        const HubService = proxyquire('../../../src/services/hub_service', {
            './hub_connector.js': proxyquire('../../../src/services/hub_connector', {
                'axios': httpCapture.createAxiosStub()
            }),
            './docker_service': {
                addContainerToNetwork: async (containerId, network) => {
                    networkConnections.push({ containerId, network })
                    return true
                },
                getStatusFromContainer: async () => ({
                    State: { Status: 'running' },
                    NetworkSettings: { Ports: {}, Networks: {} }
                }),
                stringToDockerContainerFile: async () => true
            },
            './module_service': {
                cloneGit: async () => true,
                buildAndUp: async () => hubId
            },
            '../utils/helpers': {
                sleep: async () => {}
            }
        })

        await HubService.updateHub()

        const hubConnections = networkConnections.filter(c => c.containerId === hubId)
        const networks = hubConnections.map(c => c.network)
        expect(networks).to.include('xchain-node-bitcoin-mainnet')
        expect(networks).to.include('xchain-node-dogecoin-testnet')
    })
})
