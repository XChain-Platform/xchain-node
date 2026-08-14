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

// Guards the table-driven SERVICE_REGISTRY that replaced the
// hand-maintained per-service switch/case blocks in ModuleService.buildAndUp()
// and HubService.updateHubOrExplorer(). The point of the table is that a
// forgotten service surfaces as a missing entry HERE (a failing test) instead
// of a silently omitted install branch, so these tests assert coverage parity
// against the canonical service enums and the exact docker/hub-config output.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const {
    SERVICE_REGISTRY, XChainService,
    NODE_MODULE_NAME, DB_MODULE_NAME, HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME
} = require('../../src/config/constants')

// buildHubModuleConfig is not exported, so it is exercised indirectly: the
// docker builder via ModuleService's public buildModuleDockerArgs, and the
// hub descriptor by asserting the SERVICE_REGISTRY shape directly.
function loadModuleService() {
    return proxyquire('../../src/services/ModuleService', {
        // ModuleService only pulls ValidatorService in lazily (hub caps), and
        // its top-level requires resolve fine without a live DB when we don't
        // call installModule. buildModuleDockerArgs itself has no side effects.
        './ConfigService': {
            getModuleDir: (m) => '/modules/' + m,
            getModuleTmpDir: (m) => '/tmp/' + m,
            moduleDirExists: () => false,
            checkIfModuleExists: () => true,
            removeModuleDir: () => {},
            removeModuleTmpDir: () => {},
            createModuleTmpDir: () => {},
            getDockerContainerImageName: () => 'x',
            getUtxoTrackerVolumeName: (coin, net) => `xchain-utxo-tracker-${coin}-${net}-data`,
            getDockerNetwork: () => 'xchain-node',
            getDefaultConfig: async () => ({}),
            validatePort: () => true
        },
        '../state': { db: {}, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
        './StatusService': { statusChanged: async () => {}, getStatus: async () => ({}) },
        './DockerService': {
            killContainer: async () => {}, removeContainer: async () => {},
            forceRemoveContainerByName: async () => {}, getPublishedHostPorts: async () => new Map()
        },
        './DatabaseService': { setDatabaseParameters: async () => {}, setHubDatabaseParameters: async () => {} }
    })
}

describe('SERVICE_REGISTRY', function () {

    describe('coverage parity with canonical service enums', function () {

        it('has a docker facet for every buildAndUp-installed service', function () {
            // Every module that gets a Docker container built + run by buildAndUp
            // (all XChainService entries except the one-shot e2e-test runner, plus
            // the three singleton services) must carry a docker facet.
            const dockerBuilt = [
                XChainService.XCHAIN_ENCODER,
                XChainService.XCHAIN_DECODER,
                XChainService.XCHAIN_UTXO_TRACKER,
                XChainService.XCHAIN_INDEXER,
                XChainService.XCHAIN_REGTEST_MINER,
                HUB_MODULE_NAME,
                EXPLORER_MODULE_NAME,
                SYNC_MODULE_NAME
            ]
            for (const mod of dockerBuilt) {
                expect(SERVICE_REGISTRY[mod], `${mod} registry entry`).to.exist
                expect(SERVICE_REGISTRY[mod].docker, `${mod} docker facet`).to.exist
            }
        })

        it('the one-shot e2e-test runner has no docker facet (no ports/volumes)', function () {
            const entry = SERVICE_REGISTRY[XChainService.XCHAIN_E2E_TEST]
            // Either no entry at all, or an entry without a docker facet: both
            // yield empty run-args, matching the old switch default.
            expect(entry === undefined || entry.docker === undefined).to.be.true
        })

        it('has a hubConfig facet for every module the hub reports on', function () {
            // The old HubService switch produced a config descriptor for exactly
            // these modules; hub/explorer/sync themselves contribute none.
            const hubReported = [
                DB_MODULE_NAME,
                NODE_MODULE_NAME,
                XChainService.XCHAIN_DECODER,
                XChainService.XCHAIN_ENCODER,
                XChainService.XCHAIN_INDEXER,
                XChainService.XCHAIN_UTXO_TRACKER,
                XChainService.XCHAIN_REGTEST_MINER
            ]
            for (const mod of hubReported) {
                expect(SERVICE_REGISTRY[mod], `${mod} registry entry`).to.exist
                expect(SERVICE_REGISTRY[mod].hubConfig, `${mod} hubConfig facet`).to.exist
            }
        })

        it('the singleton services contribute no hub config', function () {
            for (const mod of [HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME]) {
                const entry = SERVICE_REGISTRY[mod]
                expect(entry && entry.hubConfig, `${mod} hubConfig`).to.not.exist
            }
        })

        it('marks exactly hub/explorer/sync as singletons', function () {
            for (const mod of [HUB_MODULE_NAME, EXPLORER_MODULE_NAME, SYNC_MODULE_NAME]) {
                expect(SERVICE_REGISTRY[mod].docker.singleton, `${mod} singleton`).to.equal(true)
            }
            for (const mod of [
                XChainService.XCHAIN_ENCODER, XChainService.XCHAIN_DECODER,
                XChainService.XCHAIN_UTXO_TRACKER, XChainService.XCHAIN_INDEXER,
                XChainService.XCHAIN_REGTEST_MINER
            ]) {
                expect(!!SERVICE_REGISTRY[mod].docker.singleton, `${mod} not singleton`).to.equal(false)
            }
        })
    })

    describe('buildModuleDockerArgs()', function () {

        const ENV = {
            DECODER_PORT: 3002, DECODER_API_PORT: 3002, DECODER_BOOTSTRAP_VOLUME: '/b/dec',
            ENCODER_PORT: 3003, ENCODER_API_PORT: 3003,
            UTXO_TRACKER_PORT: 3001, UTXO_TRACKER_API_PORT: 3001, UTXO_TRACKER_BOOTSTRAP_VOLUME: '/b/utxo',
            INDEXER_PORT: 3004, INDEXER_API_PORT: 3004,
            REGTEST_MINER_PORT: 3005, REGTEST_MINER_API_PORT: 3005,
            HUB_PORT: 10000,
            EXPLORER_PORT_HTTP: 18080, EXPLORER_API_PORT_HTTP: 8080,
            EXPLORER_PORT_HTTPS: 18081, EXPLORER_API_PORT_HTTPS: 8081,
            SYNC_PORT: 3006, SYNC_API_PORT: 3006
        }

        let ms
        beforeEach(function () { ms = loadModuleService() })

        it('decoder: conditional port + unconditional bootstrap volume', function () {
            const r = ms.buildModuleDockerArgs(XChainService.XCHAIN_DECODER, ENV, 'bitcoin', 'mainnet')
            expect(r.portArgs).to.deep.equal(['-p', '3002:3002'])
            expect(r.volumeArgs).to.deep.equal(['-v', '/b/dec:/bootstrap/xchain-decoder'])
            expect(r.ulimitArgs).to.deep.equal([])
            expect(r.singleton).to.equal(false)
        })

        it('encoder: port only, no volume', function () {
            const r = ms.buildModuleDockerArgs(XChainService.XCHAIN_ENCODER, ENV, 'bitcoin', 'mainnet')
            expect(r.portArgs).to.deep.equal(['-p', '3003:3003'])
            expect(r.volumeArgs).to.deep.equal([])
        })

        it('utxo-tracker: port + dynamic data volume + bootstrap volume + nofile ulimit', function () {
            const r = ms.buildModuleDockerArgs(XChainService.XCHAIN_UTXO_TRACKER, ENV, 'litecoin', 'regtest')
            expect(r.portArgs).to.deep.equal(['-p', '3001:3001'])
            expect(r.volumeArgs).to.deep.equal([
                '-v', 'xchain-utxo-tracker-litecoin-regtest-data:/data/xchain-utxo-tracker',
                '-v', '/b/utxo:/bootstrap/xchain-utxo-tracker'
            ])
            expect(r.ulimitArgs).to.deep.equal(['--ulimit', 'nofile=2048:2048'])
        })

        it('hub: singleton, unconditional single port, no static volumes when unconfigured', function () {
            const r = ms.buildModuleDockerArgs(HUB_MODULE_NAME, ENV, 'bitcoin', 'mainnet')
            expect(r.singleton).to.equal(true)
            expect(r.portArgs).to.deep.equal(['-p', '10000:10000'])
            // No HUB_CAPABILITY_CONFIG in env and no signer dir env => no volumes.
            expect(r.volumeArgs).to.deep.equal([])
        })

        // The DIRECTORY holding capabilities.json is mounted, never the file:
        // a single-file bind mount makes `docker cp` against this container fail
        // for every path with "mkdirat validator/capabilities.json: file exists".
        it('hub: mounts the capability config DIRECTORY (ro) when HUB_CAPABILITY_CONFIG is present', function () {
            const ms2 = proxyquire('../../src/services/ModuleService', {
                './ConfigService': {
                    getUtxoTrackerVolumeName: () => 'v', getModuleDir: (m) => '/m/' + m,
                    checkIfModuleExists: () => true, moduleDirExists: () => false,
                    getDockerContainerImageName: () => 'x', getDockerNetwork: () => 'n',
                    getDefaultConfig: async () => ({}), validatePort: () => true
                },
                './ValidatorService': {
                    getCapabilityConfigMountDir: () => '/host/validator/hub-caps',
                    CAPS_CONTAINER_DIR: '/validator'
                },
                '../state': { db: {}, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                './StatusService': { statusChanged: async () => {}, getStatus: async () => ({}) },
                './DockerService': { getPublishedHostPorts: async () => new Map() },
                './DatabaseService': { setDatabaseParameters: async () => {}, setHubDatabaseParameters: async () => {} }
            })
            const r = ms2.buildModuleDockerArgs(HUB_MODULE_NAME, { HUB_PORT: 10000, HUB_CAPABILITY_CONFIG: '/validator/capabilities.json' }, '', '')
            expect(r.volumeArgs).to.deep.equal(['-v', '/host/validator/hub-caps:/validator:ro'])
            // No mount arg may end in a file name: that is the shape that breaks docker cp.
            expect(r.volumeArgs.some(a => /capabilities\.json:/.test(a))).to.be.false
        })

        it('hub: a mount refusal from ValidatorService fails the build instead of silently dropping the config', function () {
            const ms2 = proxyquire('../../src/services/ModuleService', {
                './ConfigService': {
                    getUtxoTrackerVolumeName: () => 'v', getModuleDir: (m) => '/m/' + m,
                    checkIfModuleExists: () => true, moduleDirExists: () => false,
                    getDockerContainerImageName: () => 'x', getDockerNetwork: () => 'n',
                    getDefaultConfig: async () => ({}), validatePort: () => true
                },
                './ValidatorService': {
                    getCapabilityConfigMountDir: () => {
                        throw new Error('refusing to mount /host/validator/hub-caps into the hub container')
                    },
                    CAPS_CONTAINER_DIR: '/validator'
                },
                '../state': { db: {}, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                './StatusService': { statusChanged: async () => {}, getStatus: async () => ({}) },
                './DockerService': { getPublishedHostPorts: async () => new Map() },
                './DatabaseService': { setDatabaseParameters: async () => {}, setHubDatabaseParameters: async () => {} }
            })
            expect(() => ms2.buildModuleDockerArgs(
                HUB_MODULE_NAME, { HUB_PORT: 10000, HUB_CAPABILITY_CONFIG: '/validator/capabilities.json' }, '', ''
            )).to.throw(/refusing to mount/)
        })

        it('explorer: singleton with two unconditional port mappings', function () {
            const r = ms.buildModuleDockerArgs(EXPLORER_MODULE_NAME, ENV, '', '')
            expect(r.singleton).to.equal(true)
            expect(r.portArgs).to.deep.equal(['-p', '18080:8080', '-p', '18081:8081'])
        })

        it('sync: singleton, conditional port present', function () {
            const r = ms.buildModuleDockerArgs(SYNC_MODULE_NAME, ENV, '', '')
            expect(r.singleton).to.equal(true)
            expect(r.portArgs).to.deep.equal(['-p', '3006:3006'])
        })

        it('conditional port omitted when a key is missing', function () {
            const partial = { INDEXER_PORT: 3004 } // no INDEXER_API_PORT
            const r = ms.buildModuleDockerArgs(XChainService.XCHAIN_INDEXER, partial, 'bitcoin', 'mainnet')
            expect(r.portArgs).to.deep.equal([])
        })

        it('unknown / docker-less module yields empty args (e2e-test, node, database)', function () {
            for (const mod of [XChainService.XCHAIN_E2E_TEST, NODE_MODULE_NAME, DB_MODULE_NAME, 'not-a-service']) {
                const r = ms.buildModuleDockerArgs(mod, ENV, 'bitcoin', 'mainnet')
                expect(r.portArgs, `${mod} ports`).to.deep.equal([])
                expect(r.volumeArgs, `${mod} volumes`).to.deep.equal([])
                expect(r.ulimitArgs, `${mod} ulimits`).to.deep.equal([])
                expect(r.singleton, `${mod} singleton`).to.equal(false)
            }
        })
    })
})
