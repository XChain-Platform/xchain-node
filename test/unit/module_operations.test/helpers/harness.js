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

const path = require('path')
const { createRequire } = require('module')
const requireFromUnit = createRequire(path.join(__dirname, '..', '..', 'module_operations.test.js'))

{
const require = requireFromUnit
const sinon      = require('sinon')
const { configStub } = require('../helpers/config_stub');
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubs() {
    return {
        // Converges by default: the tests that care about the wait assert on it
        // directly, and every other install case would otherwise sit through a
        // real poll loop.
        waitForExplorerReady: sinon.stub().resolves(true),
        updateExplorer: sinon.stub().resolves(true),
        updateHub: sinon.stub().resolves(true),
        db: {
            getModuleContainer: sinon.stub().resolves('container-id-123'),
            // The non-swallowing read the destructive reset paths use: a registry
            // failure throws here instead of answering "not installed".
            getModuleContainerStrict: sinon.stub().resolves('container-id-123'),
            deleteModuleContainer: sinon.stub().resolves(true),
            // Registry contents AFTER the per-coin uninstall pass. Empty by default =
            // nothing left for a shared service to serve, which is the full-teardown
            // case; tests that need a surviving coin override this.
            getAllModuleContainers: sinon.stub().resolves([])
        },
        createDockerNetwork: sinon.stub().resolves(true),
        killContainer: sinon.stub().resolves(true),
        removeContainer: sinon.stub().resolves(true),
        forceRemoveContainerByName: sinon.stub().resolves(true),
        // Default 'exists' keeps the presence probe out of the way of every test
        // that is not about presence: the recreate guard refuses only on a
        // POSITIVE 'gone', so this default preserves pre-guard behaviour.
        probeContainerPresenceByName: sinon.stub().resolves('exists'),
        stopContainer: sinon.stub().resolves(true),
        stopContainerByName: sinon.stub().resolves({ stopped: true, seconds: 1, killed: false }),
        startContainer: sinon.stub().resolves(true),
        restartContainer: sinon.stub().resolves(true),
        execContainer: sinon.stub().resolves('exec-output'),
        shellContainer: sinon.stub().resolves(true),
        logContainer: sinon.stub().resolves(true),
        startDockerMonitor: sinon.stub().resolves(true),
        waitContainer: sinon.stub().resolves(0),
        // The node container answers where its datadir really lives.
        // Default: a host path that is NOT the env-derived one, which is the
        // ordinary case on a stack whose datadir was relocated.
        getContainerBindMounts: sinon.stub().resolves([
            { source: '/srv/xchain/data/node/bitcoin/mainnet', destination: '/root/.bitcoin' }
        ]),
        saveContainerLogs: sinon.stub().resolves(true),
        buildDatabaseModule: sinon.stub().resolves(true),
        resetDatabases: sinon.stub().resolves(true),
        clearHubPriceIngestWatermark: sinon.stub().resolves(true),
        // The regtest re-genesis purge of the hub's cross-chain relic rows. The
        // statements helper feeds the never-fatal catch's operator message.
        purgeHubCrossChainRows: sinon.stub().resolves(true),
        manualHubCrossChainPurgeStatements: sinon.stub().returns([
            "DELETE FROM cross_chain_matches WHERE network = 'regtest';"
        ]),
        getDatabaseContainerId: sinon.stub().resolves('mariadb-container-id'),
        // EXTERNAL_DB pre-wipe reachability probe. Reachable by default so it
        // stays out of the way of every test that is not about it.
        pingExternalDatabase: sinon.stub().resolves({ ok: true, host: 'db.example', port: 3306 }),
        cloneGit: sinon.stub().resolves(true),
        getModuleBranch: sinon.stub().resolves('master'),
        buildAndUp: sinon.stub().resolves('b'.repeat(64)),
        setDatabaseParameters: sinon.stub().resolves(true),
        setHubDatabaseParameters: sinon.stub().resolves(true),
        installModule: sinon.stub().resolves('new-container-id'),
        uninstallModule: sinon.stub().resolves(true),
        assertHubNotBehind: sinon.stub().resolves({ checked: false, reason: 'not-hub-dependent' }),
        assertRequiredMigrationsApplied: sinon.stub().resolves({ checked: false, reason: 'no-migrations' }),
        statusChanged: sinon.stub().resolves(),
        readline: {
            createInterface: sinon.stub()
        },
        resolveBlocksDir: sinon.stub().resolves(null),
        execFile: sinon.stub(),
        fs: {
            existsSync: sinon.stub().returns(false)
        },
        bootstrapService: {
            resetBootstrapOutcomes:  sinon.stub(),
            reportBootstrapOutcomes: sinon.stub()
        },
        // The reindex -> forced-republish ledger. Stubbed so a reset in these
        // suites never writes the developer's real ~/.xchain-node; the ledger's
        // own rules live in BootstrapRepublishLedger.test.js.
        republishLedger: {
            reindexAffectedModules: sinon.stub().callsFake(
                require('../../src/services/bootstrap_republish_ledger').reindexAffectedModules),
            recordReindex: sinon.stub().callsFake((modules, coin, network) =>
                (modules || []).map(m => `${m}:${coin}:${network}`))
        }
    }
}

// `constantsOverrides` swaps individual config/constants values (EXTERNAL_DB is
// the one that matters here) without touching the rest of the module.
function loadOperations(stubs, constantsOverrides = null) {
    return proxyquire('../../src/operations/module_operations', {
        '../config/index': constantsOverrides
            ? configStub(constantsOverrides)
            : require('../../src/config'),
        '../state': {
            db: stubs.db,
            // Read lazily by the coin-node "already current" check under
            // `update all`; empty by default so every other test rebuilds.
            getLastStatus: stubs.getLastStatus || (() => null),
            getRemoteModuleVersions: stubs.getRemoteModuleVersions || (() => ({}))
        },
        '../services/config_service': {
            getDockerContainerImageName: (mod, coin, net) => `${coin}-${net}-${mod}`,
            getUtxoTrackerVolumeName: (coin, net) => `xchain-utxo-tracker-${coin}-${net}-data`,
            filterCommandParameters: require('../../src/services/config_service').filterCommandParameters,
            getDockerNetwork: (coin, net) => 'xchain-node-' + coin + '-' + net
        },
        '../services/docker_service': {
            createDockerNetwork: stubs.createDockerNetwork,
            killContainer: stubs.killContainer,
            removeContainer: stubs.removeContainer,
            forceRemoveContainerByName: stubs.forceRemoveContainerByName,
            probeContainerPresenceByName: stubs.probeContainerPresenceByName,
            stopContainer: stubs.stopContainer,
            stopContainerByName: stubs.stopContainerByName,
            startContainer: stubs.startContainer,
            restartContainer: stubs.restartContainer,
            execContainer: stubs.execContainer,
            shellContainer: stubs.shellContainer,
            logContainer: stubs.logContainer,
            startDockerMonitor: stubs.startDockerMonitor,
            waitContainer: stubs.waitContainer,
            saveContainerLogs: stubs.saveContainerLogs,
            getContainerBindMounts: stubs.getContainerBindMounts
        },
        '../services/database_service': {
            buildDatabaseModule: stubs.buildDatabaseModule,
            resetDatabases: stubs.resetDatabases,
            clearHubPriceIngestWatermark: stubs.clearHubPriceIngestWatermark,
            purgeHubCrossChainRows: stubs.purgeHubCrossChainRows,
            manualHubCrossChainPurgeStatements: stubs.manualHubCrossChainPurgeStatements,
            getDatabaseContainerId: stubs.getDatabaseContainerId,
            pingExternalDatabase: stubs.pingExternalDatabase,
            setDatabaseParameters: stubs.setDatabaseParameters,
            setHubDatabaseParameters: stubs.setHubDatabaseParameters
        },
        '../services/module_service': {
            cloneGit: stubs.cloneGit,
            getModuleBranch: stubs.getModuleBranch,
            buildAndUp: stubs.buildAndUp,
            installModule: stubs.installModule,
            uninstallModule: stubs.uninstallModule
        },
        '../services/explorer_service': {
            waitForExplorerReady: stubs.waitForExplorerReady,
            updateExplorer: stubs.updateExplorer
        },
        '../services/hub_service': {
            updateHub: stubs.updateHub
        },
        '../services/skew_guard_service': {
            assertHubNotBehind: stubs.assertHubNotBehind
        },
        '../services/migration_precondition_service': {
            assertRequiredMigrationsApplied: stubs.assertRequiredMigrationsApplied
        },
        '../services/status_service': {
            statusChanged: stubs.statusChanged
        },
        '../services/node_service': {
            resolveBlocksDir: stubs.resolveBlocksDir
        },
        '../services/bootstrap_service': stubs.bootstrapService,
        '../services/bootstrap_republish_ledger': {
            reindexAffectedModules: stubs.republishLedger.reindexAffectedModules,
            recordReindex:          stubs.republishLedger.recordReindex
        },
        'child_process': { execFile: stubs.execFile },
        'readline': stubs.readline,
        'fs': stubs.fs,
        'util': {
            promisify: (fn) => async (...args) => {
                // execFileAsync calls: resolve with empty stdout for docker run --rm
                return new Promise((resolve, reject) => {
                    fn(...args, (err, stdout, stderr) => {
                        if (err) reject(err)
                        else resolve(stdout || '')
                    })
                })
            }
        }
    })
}

function registerLifecycleHooks(assignStubs) {

    // withInstallTarget resolves the operator's ref slot, and with no ref that
    // means the latest release: two live api.github.com calls, one to find the
    // tag and one to fetch and signature-verify its manifest. A unit suite must
    // not depend on the public internet for that. Unauthenticated quota is per
    // runner IP on a shared pool, so this failed on other people's traffic, and
    // the failure surfaced as "expected false to be true" on an unrelated stub
    // assertion, because the fetch threw before the assertion's subject ever
    // ran. The signed-release path has its own suites; here it is a precondition.
    //
    // The stub replaces the module's export rather than riding proxyquire,
    // because withInstallTarget requires the service lazily at call time and a
    // proxyquire map only intercepts requires made while the module loads.
    let resolveInstallTargetStub
    // The install-target record is a real file under the data dir and, absent,
    // a classification of the real module checkouts; neither belongs in a unit
    // run. Same lazy-require reason as above: stubbed on the module's exports.
    let recordInstallTargetStub, resolveUpdateTargetStub
    beforeEach(function () {
        const releaseManifest = require('../../src/services/release_manifest_service')
        resolveInstallTargetStub = sinon.stub(releaseManifest, 'resolveInstallTarget').resolves({
            kind: 'release',
            ref: 'v0.11.0',
            tag: 'v0.11.0',
            manifest: { platform_version: '0.11.0', components: {} },
            resolvedFrom: 'latest published release'
        })
        const installTarget = require('../../src/services/install_target_service')
        recordInstallTargetStub = sinon.stub(installTarget, 'recordInstallTarget').returns(true)
        resolveUpdateTargetStub = sinon.stub(installTarget, 'resolveUpdateTarget').resolves({
            kind: 'release', ref: null, tag: null, inferred: true
        })
        delete process.env.XCHAIN_NODE_UPDATE_TARGET
        assignStubs({ resolveInstallTargetStub, recordInstallTargetStub, resolveUpdateTargetStub })
    })
    afterEach(function () {
        resolveInstallTargetStub.restore()
        recordInstallTargetStub.restore()
        resolveUpdateTargetStub.restore()
        delete process.env.XCHAIN_NODE_UPDATE_TARGET
    })
}

module.exports = { sinon, expect, makeStubs, loadOperations, registerLifecycleHooks, requireFromUnit }
}
