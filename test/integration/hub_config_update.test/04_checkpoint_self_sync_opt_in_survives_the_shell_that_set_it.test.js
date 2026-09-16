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

async function pushWithContainerEnv(fixture, containerEnv) {
    const { env, httpCapture, TestEnv } = fixture()
    const state = require('../../../src/state')

    const hubId = TestEnv.fakeContainerId('h')
    const btcId = TestEnv.fakeContainerId('b')
    const ltcId = TestEnv.fakeContainerId('l')

    await env.insertModule('xchain-hub', '', '', hubId)
    await env.insertModule('xchain-indexer', 'bitcoin',  'regtest', btcId)
    await env.insertModule('xchain-indexer', 'litecoin', 'regtest', ltcId)

    env.writeConfigFile('bitcoin-regtest', '')
    env.writeConfigFile('litecoin-regtest', '')

    state.setStatusUpdated(true)
    state.setLastStatus({
        'bitcoin':  { 'regtest': { 'xchain-indexer': { container_id: btcId, status: { State: { Status: 'running' } } } } },
        'litecoin': { 'regtest': { 'xchain-indexer': { container_id: ltcId, status: { State: { Status: 'running' } } } } }
    })

    httpCapture.when('127.0.0.1:10000').returns({ data: { result: true } })

    const HubService = proxyquire('../../../src/services/hub_service', {
        './hub_connector.js': proxyquire('../../../src/services/hub_connector', {
            'axios': httpCapture.createAxiosStub()
        }),
        './db_credential_drift': {
            readContainerEnv: async () => containerEnv
        },
        './docker_service': {
            addContainerToNetwork: async () => true,
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

    await HubService.updateHubOrExplorer('xchain-hub')

    const payloads = httpCapture.getPayloads('127.0.0.1:10000')
    return payloads[payloads.length - 1].params.config
}

function checkpointSuite(registerTests) {
    hubConfigSuite('checkpoint self-sync opt-in survives the shell that set it', function (fixture) {
        let savedOptIn

        beforeEach(function () {
            savedOptIn = process.env.EXPLORER_CHECKPOINT_SELF_SYNC
            delete process.env.EXPLORER_CHECKPOINT_SELF_SYNC
        })

        afterEach(function () {
            if (savedOptIn === undefined) delete process.env.EXPLORER_CHECKPOINT_SELF_SYNC
            else process.env.EXPLORER_CHECKPOINT_SELF_SYNC = savedOptIn
        })

        registerTests(fixture)
    })
}

// The explorer hard-requires a checkpoint block per serving coin, and the push is
// what generates it. While the opt-in was read only from the host env at command
// time, a coin installed from a shell that never exported it got no block, both
// config stores being upsert-only kept the earlier coins' blocks, and the explorer
// served that one coin's hub-mirrored routes as a 500 while its siblings answered.
checkpointSuite(function (fixture) {

    it('emits a checkpoint block for EVERY installed coin when only the explorer container remembers the opt-in', async function () {
        const config = await pushWithContainerEnv(fixture, { HUB_API_URL: 'http://xchain-node-xchain-hub:10000' })

        for (const coin of ['bitcoin', 'litecoin']) {
            const checkpoint = config[coin]['regtest'].checkpoint
            expect(checkpoint, coin + ' checkpoint block').to.exist
            expect(checkpoint.self_sync, coin + ' self_sync').to.be.true
            expect(checkpoint.hub_url, coin + ' hub_url').to.be.a('string').and.to.have.length.above(0)
            expect(checkpoint.name, coin + ' mirror schema').to.match(/_HubMirror$/)
        }
    })
})

checkpointSuite(function (fixture) {

    it('emits none when neither the env nor the explorer container was ever opted in', async function () {
        const config = await pushWithContainerEnv(fixture, { EXPLORER_PORT: '18080' })

        expect(config['bitcoin']['regtest'].checkpoint).to.be.undefined
        expect(config['litecoin']['regtest'].checkpoint).to.be.undefined
    })
})
