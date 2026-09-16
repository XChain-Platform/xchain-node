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

const { hubConfigSuite } = require('./hub_config_update.test/support/fixture')

hubConfigSuite('updateHubOrExplorer payload for hub', function (fixture) {

    it('builds JSON config with module connection details from installed modules', async function () {
        const { env, httpCapture, makeHubService, TestEnv } = fixture()
        const state = require('../../src/state')

        const encId = TestEnv.fakeContainerId('e')
        const decId = TestEnv.fakeContainerId('d')
        const hubId = TestEnv.fakeContainerId('h')

        await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', encId)
        await env.insertModule('xchain-decoder', 'bitcoin', 'mainnet', decId)
        await env.insertModule('xchain-hub', '', '', hubId)

        // Set up status so updateHubOrExplorer can read it
        env.writeConfigFile('bitcoin-mainnet', '')
        state.setStatusUpdated(true)
        state.setLastStatus({
            'bitcoin': {
                'mainnet': {
                    'xchain-encoder': { container_id: encId, status: { State: { Status: 'running' } } },
                    'xchain-decoder': { container_id: decId, status: { State: { Status: 'running' } } }
                }
            }
        })

        httpCapture.when('127.0.0.1:10000').returns({ data: { result: true } })

        const { HubService } = makeHubService()
        await HubService.updateHubOrExplorer('xchain-hub')

        // Verify hub received a config payload
        const payloads = httpCapture.getPayloads('127.0.0.1:10000')
        expect(payloads.length).to.be.greaterThan(0)

        const lastPayload = payloads[payloads.length - 1]
        expect(lastPayload.method).to.equal('updateconfig')
        expect(lastPayload.params).to.have.property('config')

        const config = lastPayload.params.config
        expect(config).to.have.property('bitcoin')
        expect(config['bitcoin']).to.have.property('mainnet')

        const encoderConfig = config['bitcoin']['mainnet']['xchain-encoder']
        expect(encoderConfig).to.exist
        expect(encoderConfig.port).to.equal(3003)

        const decoderConfig = config['bitcoin']['mainnet']['xchain-decoder']
        expect(decoderConfig).to.exist
        expect(decoderConfig.port).to.equal(3002)
        expect(decoderConfig.db_host).to.equal('mariadb')
        expect(decoderConfig.name).to.equal('XChain_BTC_Mainnet_Decoder')
    })
})

hubConfigSuite('updateHubOrExplorer payload for hub', function (fixture) {

    it('includes node config with correct ports and credentials', async function () {
        const { env, httpCapture, makeHubService, TestEnv } = fixture()
        const state = require('../../src/state')

        const nodeId = TestEnv.fakeContainerId('n')
        const hubId = TestEnv.fakeContainerId('h')
        await env.insertModule('node', 'bitcoin', 'mainnet', nodeId)
        await env.insertModule('xchain-hub', '', '', hubId)

        // Since a2f1919 (2026-07-17), ConfigService generates a random
        // NODE_USER/NODE_PASSWORD per install whenever the config file
        // doesn't already carry them, rather than falling through to the
        // static "rpc"/"rpc" default (a well-known credential left on a
        // live stack). Seed both here so this test still asserts a known,
        // fixed value instead of a per-run random one.
        env.writeConfigFile('bitcoin-mainnet', 'NODE_USER=rpc\nNODE_PASSWORD=rpc\n')
        state.setStatusUpdated(true)
        state.setLastStatus({
            'bitcoin': {
                'mainnet': {
                    'node': { container_id: nodeId, status: { State: { Status: 'running' } } }
                }
            }
        })

        httpCapture.when('127.0.0.1:10000').returns({ data: { result: true } })

        const { HubService } = makeHubService()
        await HubService.updateHubOrExplorer('xchain-hub')

        const payloads = httpCapture.getPayloads('127.0.0.1:10000')
        const config = payloads[payloads.length - 1].params.config

        const nodeConfig = config['bitcoin']['mainnet']['node']
        expect(nodeConfig).to.exist
        expect(nodeConfig.host).to.equal('node')
        expect(nodeConfig.port).to.equal(8332)
        expect(nodeConfig.user).to.equal('rpc')
        expect(nodeConfig.pass).to.equal('rpc')
    })
})

hubConfigSuite('updateHubOrExplorer payload for hub', function (fixture) {

    it('includes multiple coin/network stacks', async function () {
        const { env, httpCapture, makeHubService, TestEnv } = fixture()
        const state = require('../../src/state')

        const id1 = TestEnv.fakeContainerId('1')
        const id2 = TestEnv.fakeContainerId('2')
        const hubId = TestEnv.fakeContainerId('h')

        await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', id1)
        await env.insertModule('xchain-encoder', 'dogecoin', 'testnet', id2)
        await env.insertModule('xchain-hub', '', '', hubId)

        env.writeConfigFile('bitcoin-mainnet', '')
        env.writeConfigFile('dogecoin-testnet', '')
        state.setStatusUpdated(true)
        state.setLastStatus({
            'bitcoin': {
                'mainnet': {
                    'xchain-encoder': { container_id: id1, status: { State: { Status: 'running' } } }
                }
            },
            'dogecoin': {
                'testnet': {
                    'xchain-encoder': { container_id: id2, status: { State: { Status: 'running' } } }
                }
            }
        })

        httpCapture.when('127.0.0.1:10000').returns({ data: { result: true } })

        const { HubService } = makeHubService()
        await HubService.updateHubOrExplorer('xchain-hub')

        const payloads = httpCapture.getPayloads('127.0.0.1:10000')
        const config = payloads[payloads.length - 1].params.config

        expect(config).to.have.property('bitcoin')
        expect(config).to.have.property('dogecoin')
        expect(config['bitcoin']['mainnet']['xchain-encoder'].port).to.equal(3003)
        expect(config['dogecoin']['testnet']['xchain-encoder'].port).to.equal(3003)
    })
})
