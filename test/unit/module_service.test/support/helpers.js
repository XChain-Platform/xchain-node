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

const sinon      = require('sinon')
const path = require('path')
const { configStub } = require('../../../helpers/config_stub');
const { expect } = require('chai')
const proxyquireLibrary = require('proxyquire').noCallThru()

const { modulesUrls, XChainService, DEFAULT_NODE_PREFIX, DEPENDENCY_HEALTH_START_PERIOD } = require('../../../../src/config')

function proxyquire(request, stubs) {
    return proxyquireLibrary(resolveProxyquireRequest(request), stubs)
}

function resolveProxyquireRequest(request) {
    const sourceIndex = request.indexOf('src/')
    if (sourceIndex === -1) return request
    return path.resolve(__dirname, '../../../..', request.slice(sourceIndex))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubs() {
    return {
        execFile: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(true),
            rmSync: sinon.stub(),
            mkdirSync: sinon.stub(),
            readFileSync: sinon.stub()
        },
        db: {
            setModuleContainer: sinon.stub().resolves(true),
            getModuleContainer: sinon.stub().resolves('old-container-id'),
            deleteModuleContainer: sinon.stub().resolves('removed-id')
        },
        statusChanged: sinon.stub().resolves(),
        getStatus: sinon.stub().resolves({}),
        killContainer: sinon.stub().resolves(true),
        stopContainerByName: sinon.stub().resolves({ stopped: true, seconds: 1, killed: false }),
        removeContainer: sinon.stub().resolves(true),
        forceRemoveContainerByName: sinon.stub().resolves(true),
        getStatusFromContainer: sinon.stub().resolves({ State: { Status: 'running' } }),
        // No published host ports by default → buildAndUp's pre-flight conflict
        // check is a no-op. Conflict tests override this with a populated Map.
        getPublishedHostPorts: sinon.stub().resolves(new Map()),
        // buildx present by default → buildAndUp's BuildKit probe passes. The
        // legacy-builder tests override this with a rejection.
        checkBuildKitAvailable: sinon.stub().resolves(true)
    }
}

function makeConfigServiceStub(constantsOverride) {
    return {
        getModuleDir: (mod) => '/modules/' + mod,
        getModuleTmpDir: (mod) => '/tmp/' + mod,
        moduleDirExists: sinon.stub().returns(false),
        checkIfModuleExists: sinon.stub().returns(true),
        removeModuleDir: sinon.stub(),
        removeModuleTmpDir: sinon.stub(),
        createModuleTmpDir: sinon.stub(),
        getDockerContainerImageName: (mod, coin, net) => {
            if (mod === 'database' || mod === 'xchain-hub' || mod === 'xchain-explorer' || mod === 'xchain-sync') {
                return 'xchain-node-' + mod
            }
            return 'xchain-node-' + coin + '-' + net + '-' + mod
        },
        getDockerNetwork: (coin, net) => 'xchain-node' + (coin ? '-' + coin : '') + (net ? '-' + net : ''),
        // Mirrors ConfigService.getUtxoTrackerVolumeName's real NODE_PREFIX
        // handling (see the F11 test below): the legacy exemption for the
        // default prefix, and a prefixed name otherwise.
        getUtxoTrackerVolumeName: (coin, net) => {
            const nodePrefix = (constantsOverride && constantsOverride.NODE_PREFIX) || DEFAULT_NODE_PREFIX
            const prefix = nodePrefix === DEFAULT_NODE_PREFIX ? '' : `${nodePrefix}-`
            return `${prefix}xchain-utxo-tracker-${coin}-${net}-data`
        },
        validatePort: (v) => { if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 65535; if (typeof v === 'string' && /^\d+$/.test(v)) { const p = parseInt(v, 10); return p >= 1 && p <= 65535 } return false },
        getDefaultConfig: sinon.stub().resolves({
            'NETWORK': 'bitcoin-mainnet',
            'NODE_URL': 'node',
            'NODE_PORT': 8332,
            'DECODER_PORT': 3002,
            'DECODER_API_PORT': 3002,
            'DECODER_BOOTSTRAP_VOLUME': '/data/bitcoin/mainnet/xchain-decoder/bootstrap/',
            'ENCODER_PORT': 3003,
            'ENCODER_API_PORT': 3003,
            'UTXO_TRACKER_PORT': 3001,
            'UTXO_TRACKER_API_PORT': 3001,
            'UTXO_TRACKER_BOOTSTRAP_VOLUME': '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/',
            'INDEXER_PORT': 3004,
            'INDEXER_API_PORT': 3004,
            'REGTEST_MINER_PORT': 3005,
            'REGTEST_MINER_API_PORT': 3005,
            'HUB_PORT': 10000,
            'EXPLORER_PORT_HTTP': 18080,
            'EXPLORER_API_PORT_HTTP': 8080,
            'EXPLORER_PORT_HTTPS': 18081,
            'EXPLORER_API_PORT_HTTPS': 8081,
            'SYNC_PORT': 3006,
            'SYNC_API_PORT': 3006,
            // A BTC mainnet indexer deploys only with its DOGE read wired (the
            // ROLLCALL wiring guard refuses one without it); the buildAndUp
            // suites here exercise the deploy, not the refusal.
            'DOGE_INDEXER_API_URL': 'http://xchain-node-dogecoin-mainnet-xchain-indexer:3004'
        })
    }
}

function makeBaseProxies(stubs, configServiceStub) {
    return {
        'child_process': { execFile: stubs.execFile },
        'fs': stubs.fs,
        '../state': {
            db: stubs.db,
            getRemoteModuleVersions: () => ({}),
            getLastStatus: () => null
        },
        './config_service': configServiceStub,
        './status_service': {
            statusChanged: stubs.statusChanged,
            getStatus: stubs.getStatus
        },
        './docker_service': {
            killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName,
            removeContainer: stubs.removeContainer,
            forceRemoveContainerByName: stubs.forceRemoveContainerByName,
            getStatusFromContainer: stubs.getStatusFromContainer,
            getPublishedHostPorts: stubs.getPublishedHostPorts,
            checkBuildKitAvailable: stubs.checkBuildKitAvailable
        },
        './database_service': {
            setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves()
        }
    }
}

// installModule lazily requires these; stub so they load under test
// (the real VersionService pulls in state.js, which needs a live DB).
function makeLazyProxies() {
    return {
        './version_service': {
            getLocalNodeVersion: sinon.stub().resolves(null),
            getLocalModuleVersion: sinon.stub().resolves(null),
            checkRemoteNodeVersion: sinon.stub().resolves()
        },
        './node_service': {
            buildCryptoNode: sinon.stub().resolves(true),
            getCryptoNode: sinon.stub().resolves()
        },
        './explorer_service': {
            installExplorerModule: sinon.stub().resolves(true)
        },
        // Venue independence: buildAndUp('xchain-hub') calls the real guard, which
        // shells out to `docker inspect` on the HOST running the suite. On a box
        // with no hub container it returns null and every hub test passes; on a CI
        // venue that happens to run a regtest hub it reads that container's live
        // consensus env, finds the fixture env does not carry HUB_NETWORK or
        // ORACLE_MIN_SUBMISSIONS, and refuses the deploy - failing hub tests that
        // are about ports, health probes and capability mounts. Stub it here so the
        // default answer is the clean one everywhere. Tests that assert ON the
        // guard's wiring override this through extraProxies.
        './hub_consensus_env_guard': {
            assertNoHubConsensusEnvDrift: sinon.stub().resolves([]),
            isHubConsensusEnvDriftError: () => false
        },
        // installModule's decoder/indexer and hub branches lazily require this
        // for a pre-write drift check. Unstubbed it shells out for real via
        // listRunningContainerNames (`docker ps --format {{.Names}}`), which
        // passes fast on a box with no docker (ENOENT) but spawns a real
        // process and can run past 10s on a CI venue under load.
        // Stub it here so every ModuleService test is docker-free by default;
        // tests that assert ON drift behavior override this through extraProxies.
        './db_credential_drift': {
            assertNoDbCredentialDrift: sinon.stub().resolves([]),
            assertNoHubDbCredentialDrift: sinon.stub().resolves([])
        }
    }
}

function loadModuleService(stubs, constantsOverride, extraProxies) {
    const configServiceStub = makeConfigServiceStub(constantsOverride)
    const proxies = {
        ...makeBaseProxies(stubs, configServiceStub),
        ...makeLazyProxies()
    }
    if (constantsOverride) {
        proxies['../config'] = configStub(constantsOverride)
    }
    if (extraProxies) {
        Object.assign(proxies, extraProxies)
    }
    return proxyquire('../../../../src/services/module_service', proxies)
}

// A docker fake for the whole create path. A tracker create asks for a memory
// limit and buildAndUp reads that limit back off the new container, so a fake
// that knows only build and run leaves the readback pending and the test times
// out. `memoryBytes` is what the readback reports; `runStderr` is what a
// SUCCESSFUL create wrote to stderr. Returns every call made, in order.
function stubDockerCreate(stubs, { memoryBytes = 'requested', runStderr = '' } = {}) {
    const seen = []
    stubs.execFile.callsFake((cmd, args, ...rest) => {
        const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
        seen.push({ cmd, args })
        if (args[0] === 'build') { cb(null) }
        else if (args[0] === 'run') { cb(null, 'a'.repeat(64) + '\n', runStderr) }
        else if (args[0] === 'inspect') { cb(null, String(inspectMemoryBytes(seen, memoryBytes)) + '\n') }
        else { cb(null, '') }
    })
    return seen
}

function runArgsOf(seen) {
    const run = seen.find(c => c.args[0] === 'run')
    return run ? run.args : null
}

// What the readback reports, in bytes. 'requested' echoes the cap the create
// actually asked for, which the service derives from the RAM of whatever host
// runs the suite and so cannot be written as a literal here.
function inspectMemoryBytes(seen, memoryBytes) {
    if (memoryBytes !== 'requested') return memoryBytes
    const runArgs = runArgsOf(seen) || []
    const mb = runArgs[runArgs.indexOf('--memory') + 1]
    return mb ? parseInt(mb, 10) * 1024 * 1024 : 0
}

// The logger writes warn to console.warn and info to console.log, which is what
// an operator reads off a normal run. Call .restore() in an afterEach.
function captureConsole() {
    const lines = { warn: [], log: [] }
    const stubbed = [
        sinon.stub(console, 'warn').callsFake((...a) => lines.warn.push(a.join(' '))),
        sinon.stub(console, 'log').callsFake((...a) => lines.log.push(a.join(' ')))
    ]
    lines.restore = () => stubbed.forEach(s => s.restore())
    return lines
}

// A few tests need call-through (they stub only part of a dependency and want the
// real exports for the rest). `proxyquire` is a process-wide SINGLETON, so calling
// .callThru() on it leaves call-through ON for every later proxyquire in the whole
// mocha run, including other test files. Scope the flip to the single load that
// asked for it.
function proxyquireCallThru(request, stubs) {
    const pq = require('proxyquire')
    pq.callThru()
    try {
        return pq(resolveProxyquireRequest(request), stubs)
    } finally {
        pq.noCallThru()
    }
}


function moduleSuite(title, tests) {
    describe('ModuleService', function () {
        registerVenueHooks()
        describe(title, tests)
    })
}

// Venue independence: under call-through, a DockerService stub that omits
// getPublishedHostPorts silently falls back to the REAL probe, which shells
// out to `docker ps` on the host running the suite. Such a test passes on a
// laptop with no docker and fails on a CI venue that happens to publish the
// port the test asks for (one venue held port 3001 with a live utxo-tracker).
// Replace the real probe for the duration of this file so a missing stub fails
// the same way everywhere instead of depending on what the host is running.
// Same venue independence for the hub consensus-env guard, which buildAndUp
// lazily requires for xchain-hub. Unstubbed it runs `docker inspect` against
// the host's own hub container: null (pass) on a box with no hub, a REFUSAL on
// a CI venue running a regtest hub, because the fixture env carries none of the
// consensus-shaped vars that live container was deployed with. loadModuleService
// The default stub makes a load that forgets fail loudly and
// identically on every box instead of only on the venue that has a hub.
// Same venue independence for the DB-credential-drift pre-flight, which
// installModule's decoder/indexer and hub branches lazily require.
// Unstubbed, listRunningContainerNames shells out to a real
// `docker ps --format {{.Names}}` on the host running the suite: fast
// (ENOENT) on a box with no docker, but a real subprocess spawn that runs
// past a describe's stated budget on a CI venue under load.
// loadModuleService stubs both exports by default; this makes a load
// that forgets (or bypasses loadModuleService via proxyquireCallThru)
// fail loudly and identically on every box instead of only timing out on
// a busy venue.
function registerVenueHooks() {
    const RealDockerService = require('../../../../src/services/docker_service')
    const realGetPublishedHostPorts = RealDockerService.getPublishedHostPorts
    const RealHubConsensusEnvGuard = require('../../../../src/services/hub_consensus_env_guard')
    const realAssertNoHubConsensusEnvDrift = RealHubConsensusEnvGuard.assertNoHubConsensusEnvDrift
    const RealDbCredentialDrift = require('../../../../src/services/db_credential_drift')
    const realAssertNoDbCredentialDrift = RealDbCredentialDrift.assertNoDbCredentialDrift
    const realAssertNoHubDbCredentialDrift = RealDbCredentialDrift.assertNoHubDbCredentialDrift

    before(function () {
        RealDockerService.getPublishedHostPorts = async function () {
            throw new Error('unit test reached the real host-port probe: stub DockerService.getPublishedHostPorts')
        }
        RealHubConsensusEnvGuard.assertNoHubConsensusEnvDrift = async function () {
            throw new Error('unit test reached the real hub consensus-env guard: stub HubConsensusEnvGuard.assertNoHubConsensusEnvDrift')
        }
        RealDbCredentialDrift.assertNoDbCredentialDrift = async function () {
            throw new Error('unit test reached the real DB-credential-drift probe: stub DbCredentialDrift.assertNoDbCredentialDrift')
        }
        RealDbCredentialDrift.assertNoHubDbCredentialDrift = async function () {
            throw new Error('unit test reached the real DB-credential-drift probe: stub DbCredentialDrift.assertNoHubDbCredentialDrift')
        }
    })

    after(function () {
        RealDockerService.getPublishedHostPorts = realGetPublishedHostPorts
        RealHubConsensusEnvGuard.assertNoHubConsensusEnvDrift = realAssertNoHubConsensusEnvDrift
        RealDbCredentialDrift.assertNoDbCredentialDrift = realAssertNoDbCredentialDrift
        RealDbCredentialDrift.assertNoHubDbCredentialDrift = realAssertNoHubDbCredentialDrift
    })
}

module.exports = {
    sinon, configStub, expect, proxyquire, modulesUrls, XChainService,
    DEFAULT_NODE_PREFIX, DEPENDENCY_HEALTH_START_PERIOD, makeStubs, makeConfigServiceStub,
    loadModuleService, stubDockerCreate, runArgsOf, inspectMemoryBytes,
    captureConsole, proxyquireCallThru, moduleSuite
}
