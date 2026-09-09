/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * HubService.updateHub: shared-container network attachment.
 *
 * updateHub() used to catch every addContainerToNetwork failure, discard the
 * error and still return true, so a topology change published module config
 * while the shared hub/sync container was never joined to the new coin
 * network, leaving those endpoints unreachable until an unrelated later
 * mutation happened to retry. These cases pin the replacement contract:
 * one retry, then report the networks that stayed unreachable.
 *
 * The hub and sync loops share attachSharedContainer, so exercising the sync
 * loop (hub registry row absent) covers both without dragging the heavy
 * updateHubOrExplorer config push into a unit test.
 ********************************************************************/

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire')

const { HUB_MODULE_NAME, SYNC_MODULE_NAME } = require('../../src/config/constants')

function loadHubService({ addContainerToNetwork } = {}) {
    const getModuleContainer = sinon.stub()
    getModuleContainer.withArgs(HUB_MODULE_NAME,  '', '').resolves(null)
    getModuleContainer.withArgs(SYNC_MODULE_NAME, '', '').resolves('sync1234sync1234')

    const attach = addContainerToNetwork || sinon.stub().resolves(true)

    const svc = proxyquire('../../src/services/HubService', {
        '../state':          { db: { getModuleContainer } },
        './StatusService':   { getInstalledCoinsAndNetworks: async () => ({ bitcoin: ['mainnet'] }) },
        './DockerService':   { addContainerToNetwork: attach },
        '../utils/helpers':  { sleep: async () => {} },
    })

    return { svc, attach }
}

describe('HubService.updateHub network attachment', function () {

    it('returns true when every shared-container attach succeeds', async function () {
        const { svc, attach } = loadHubService()
        expect(await svc.updateHub()).to.be.true
        sinon.assert.calledWith(attach, 'sync1234sync1234', 'xchain-node-bitcoin-mainnet')
    })

    it('retries a failed attach once and succeeds on the second try', async function () {
        const attach = sinon.stub()
        attach.onFirstCall().rejects(new Error('docker race'))
        attach.onSecondCall().resolves(true)
        const { svc } = loadHubService({ addContainerToNetwork: attach })
        expect(await svc.updateHub()).to.be.true
        expect(attach.callCount).to.equal(2)
    })

    it('rejects naming the unreachable network instead of reporting success', async function () {
        const attach = sinon.stub().rejects(new Error('network xchain-node-bitcoin-mainnet not found'))
        const { svc } = loadHubService({ addContainerToNetwork: attach })
        let threw = null
        try {
            await svc.updateHub()
        } catch (err) {
            threw = err
        }
        expect(threw).to.be.an('error')
        expect(threw.message).to.match(/xchain-sync -> bitcoin\/mainnet/)
        expect(attach.callCount).to.equal(2)
    })
})

// A hub that is crash-looping answers nothing, so the config push spends ten
// attempts on connection refusals and then aborts whatever command asked for it.
// `skipConfigPush` lets a caller that has already established the hub is down
// keep the half that still works: the shared containers are attached to their
// coin networks (a docker operation, which does not need the hub serving) while
// the HTTP push, which cannot succeed, is not attempted at all.
describe('HubService.updateHub skipConfigPush', function () {

    // A hub row IS present here, unlike the attachment harness above, so the
    // config push is genuinely on the path. isStatusUpdated false makes
    // updateHubOrExplorer throw the moment it is entered, which is what tells
    // these two cases apart.
    function loadWithHubRow() {
        const getModuleContainer = sinon.stub()
        getModuleContainer.withArgs(HUB_MODULE_NAME,  '', '').resolves('hub1234hub1234')
        getModuleContainer.withArgs(SYNC_MODULE_NAME, '', '').resolves(null)
        const attach = sinon.stub().resolves(true)

        const svc = proxyquire('../../src/services/HubService', {
            '../state': {
                db: { getModuleContainer },
                isStatusUpdated: () => false,
                getLastStatus:   () => ({}),
                isVerbose:       () => false
            },
            './StatusService': {
                getInstalledCoinsAndNetworks: async () => ({ bitcoin: ['regtest'] }),
                getStatus: async () => {}
            },
            './DockerService':  { addContainerToNetwork: attach },
            './ConfigService':  { getDefaultConfig: async () => ({ HUB_PORT: 10000 }) },
            '../utils/helpers': { sleep: async () => {} }
        })
        return { svc, attach }
    }

    it('attaches the shared containers but never reaches the config push', async function () {
        const { svc, attach } = loadWithHubRow()
        expect(await svc.updateHub({ skipConfigPush: true })).to.be.true
        sinon.assert.calledWith(attach, 'hub1234hub1234', 'xchain-node-bitcoin-regtest')
    })

    it('pushes as it always has when not told to skip', async function () {
        const { svc } = loadWithHubRow()
        let threw = null
        try {
            await svc.updateHub({ skipConfigPush: false })
        } catch (err) { threw = err }
        expect(String(threw)).to.contain('The status is not updated')
    })

    it('defaults to pushing, so no existing caller changes behaviour', async function () {
        const { svc } = loadWithHubRow()
        let threw = null
        try {
            await svc.updateHub()
        } catch (err) { threw = err }
        expect(String(threw)).to.contain('The status is not updated')
    })
})

// Only a request to the hub's API can tell a crash-looping container from a
// healthy one: it is registered, has an id and reports a docker status either way.
describe('HubService.isHubAnswering', function () {

    function loadWithPing(ping) {
        return proxyquire('../../src/services/HubService', {
            './ConfigService': { getDefaultConfig: async () => ({ HUB_PORT: 10000 }) },
            '../HubConnector.js': class { constructor() { this.ping = ping } }
        })
    }

    it('is true when the hub answers a ping', async function () {
        const svc = loadWithPing(sinon.stub().resolves(true))
        expect(await svc.isHubAnswering()).to.be.true
    })

    it('is false when nothing answers', async function () {
        const svc = loadWithPing(sinon.stub().resolves(false))
        expect(await svc.isHubAnswering()).to.be.false
    })

    it('asks once, with no retry loop of its own', async function () {
        const ping = sinon.stub().resolves(false)
        const svc = loadWithPing(ping)
        await svc.isHubAnswering()
        expect(ping.callCount).to.equal(1)
    })
})

// The self_sync flag and the hub URL the explorer's mirror writer follows ship
// together, from one condition. Delivered by separate conditions (this block over
// the hub config push, HUB_API_URL as a container env written at install time), an
// explorer is told to self-sync with no hub to sync from: it warns once and serves
// the frozen mirror indefinitely.
describe('HubService.buildCheckpointConfig hub endpoint', function () {

    const COIN_CONFIG = {
        INDEXER_DB_HOST: 'mariadb',
        INDEXER_DB_PORT: 3306,
        INDEXER_DB_USER: 'xchain_indexer_bitcoin_regtest',
        INDEXER_DB_PASS: 'secret',
        INDEXER_DB_NAME: 'XChain_BTC_regtest',
        HUB_PORT:        10000
    }

    let savedHubUrl

    beforeEach(function () {
        savedHubUrl = process.env.HUB_API_URL
        delete process.env.HUB_API_URL
    })

    afterEach(function () {
        if (savedHubUrl === undefined) delete process.env.HUB_API_URL
        else process.env.HUB_API_URL = savedHubUrl
    })

    it('emits a hub_url alongside every self_sync it advertises', function () {
        const { svc } = loadHubService()
        const cfg = svc.buildCheckpointConfig(COIN_CONFIG)
        expect(cfg.self_sync).to.be.true
        expect(cfg.hub_url).to.be.a('string').and.to.have.length.above(0)
    })

    it('defaults the endpoint to the hub container on the docker network', function () {
        const { svc } = loadHubService()
        expect(svc.buildCheckpointConfig(COIN_CONFIG).hub_url).to.equal('http://xchain-node-xchain-hub:10000')
    })

    it('honours an operator HUB_API_URL from the host env', function () {
        process.env.HUB_API_URL = 'http://hub.internal:10000'
        const { svc } = loadHubService()
        expect(svc.buildCheckpointConfig(COIN_CONFIG).hub_url).to.equal('http://hub.internal:10000')
    })

    it('keeps the mirror schema and indexer credentials it already carried', function () {
        const { svc } = loadHubService()
        const cfg = svc.buildCheckpointConfig(COIN_CONFIG)
        expect(cfg.name).to.equal('XChain_BTC_regtest_HubMirror')
        expect(cfg.db_host).to.equal('mariadb')
        expect(cfg.db_port).to.equal(3306)
        expect(cfg.user).to.equal('xchain_indexer_bitcoin_regtest')
    })
})

// The opt-in that decides whether a coin gets a checkpoint block at all. Read bare
// off process.env, a push run from a shell that never exported the env emits no
// block - and because both config stores are upsert-only, the coins installed
// earlier keep theirs while the one installed later has none. The explorer
// then 500s that one coin's hub-mirrored routes (price_snapshots, oracle_prices,
// state_checkpoints) while every sibling coin answers normally.
describe('HubService.isCheckpointSelfSyncEnabled', function () {

    const EXPLORER_CONTAINER = 'xchain-node-xchain-explorer'

    it('is opted in when the host env carries the flag', async function () {
        const { svc } = loadHubService()
        const enabled = await svc.isCheckpointSelfSyncEnabled({
            env: { EXPLORER_CHECKPOINT_SELF_SYNC: '1' },
            readContainerEnv: async () => { throw new Error('must not need docker when the env says yes') }
        })
        expect(enabled).to.be.true
    })

    it('stays opted in when the env is gone but the explorer container remembers', async function () {
        const { svc } = loadHubService()
        const seen = []
        const enabled = await svc.isCheckpointSelfSyncEnabled({
            env: {},
            readContainerEnv: async (name) => {
                seen.push(name)
                return { HUB_API_URL: 'http://xchain-node-xchain-hub:10000', SOMETHING_ELSE: 'x' }
            }
        })
        expect(enabled).to.be.true
        expect(seen).to.deep.equal([EXPLORER_CONTAINER])
    })

    it('reads the flag itself off the container when it is there', async function () {
        const { svc } = loadHubService()
        const enabled = await svc.isCheckpointSelfSyncEnabled({
            env: {},
            readContainerEnv: async () => ({ EXPLORER_CHECKPOINT_SELF_SYNC: '1' })
        })
        expect(enabled).to.be.true
    })

    it('is not opted in when neither the env nor the container says so', async function () {
        const { svc } = loadHubService()
        const enabled = await svc.isCheckpointSelfSyncEnabled({
            env: {},
            readContainerEnv: async () => ({ EXPLORER_PORT: '18080' })
        })
        expect(enabled).to.be.false
    })

    it('treats an empty env value as unset rather than as an opt-in', async function () {
        const { svc } = loadHubService()
        const enabled = await svc.isCheckpointSelfSyncEnabled({
            env: { EXPLORER_CHECKPOINT_SELF_SYNC: '' },
            readContainerEnv: async () => ({ HUB_API_URL: '' })
        })
        expect(enabled).to.be.false
    })

    it('is not opted in when there is no explorer container to ask', async function () {
        const { svc } = loadHubService()
        const enabled = await svc.isCheckpointSelfSyncEnabled({
            env: {},
            readContainerEnv: async () => null
        })
        expect(enabled).to.be.false
    })
})
