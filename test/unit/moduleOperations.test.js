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
            removeModuleContainer: sinon.stub().resolves(true),
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
                require('../../src/services/BootstrapRepublishLedger').reindexAffectedModules),
            recordReindex: sinon.stub().callsFake((modules, coin, network) =>
                (modules || []).map(m => `${m}:${coin}:${network}`))
        }
    }
}

// `constantsOverrides` swaps individual config/constants values (EXTERNAL_DB is
// the one that matters here) without touching the rest of the module.
function loadOperations(stubs, constantsOverrides = null) {
    return proxyquire('../../src/operations/moduleOperations', {
        '../config/constants': constantsOverrides
            ? Object.assign({}, require('../../src/config/constants'), constantsOverrides)
            : require('../../src/config/constants'),
        '../state': {
            db: stubs.db,
            // Read lazily by the coin-node "already current" check under
            // `update all`; empty by default so every other test rebuilds.
            getLastStatus: stubs.getLastStatus || (() => null),
            getRemoteModuleVersions: stubs.getRemoteModuleVersions || (() => ({}))
        },
        '../services/ConfigService': {
            getDockerContainerImageName: (mod, coin, net) => `${coin}-${net}-${mod}`,
            getUtxoTrackerVolumeName: (coin, net) => `xchain-utxo-tracker-${coin}-${net}-data`,
            filterCommandParameters: require('../../src/services/ConfigService').filterCommandParameters,
            getDockerNetwork: (coin, net) => 'xchain-node-' + coin + '-' + net
        },
        '../services/DockerService': {
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
        '../services/DatabaseService': {
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
        '../services/ModuleService': {
            cloneGit: stubs.cloneGit,
            getModuleBranch: stubs.getModuleBranch,
            buildAndUp: stubs.buildAndUp,
            installModule: stubs.installModule,
            uninstallModule: stubs.uninstallModule
        },
        '../services/ExplorerService': {
            waitForExplorerReady: stubs.waitForExplorerReady,
            updateExplorer: stubs.updateExplorer
        },
        '../services/HubService': {
            updateHub: stubs.updateHub
        },
        '../services/SkewGuardService': {
            assertHubNotBehind: stubs.assertHubNotBehind
        },
        '../services/MigrationPreconditionService': {
            assertRequiredMigrationsApplied: stubs.assertRequiredMigrationsApplied
        },
        '../services/StatusService': {
            statusChanged: stubs.statusChanged
        },
        '../services/BootstrapService': stubs.bootstrapService,
        '../services/BootstrapRepublishLedger': {
            reindexAffectedModules: stubs.republishLedger.reindexAffectedModules,
            recordReindex:          stubs.republishLedger.recordReindex
        },
        'child_process': { execFile: stubs.execFile },
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

describe('moduleOperations', function () {

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
        const releaseManifest = require('../../src/services/ReleaseManifestService')
        resolveInstallTargetStub = sinon.stub(releaseManifest, 'resolveInstallTarget').resolves({
            kind: 'release',
            ref: 'v0.11.0',
            tag: 'v0.11.0',
            manifest: { platform_version: '0.11.0', components: {} },
            resolvedFrom: 'latest published release'
        })
        const installTarget = require('../../src/services/InstallTargetService')
        recordInstallTargetStub = sinon.stub(installTarget, 'recordInstallTarget').returns(true)
        resolveUpdateTargetStub = sinon.stub(installTarget, 'resolveUpdateTarget').resolves({
            kind: 'release', ref: null, tag: null, inferred: true
        })
        delete process.env.XCHAIN_NODE_UPDATE_TARGET
    })
    afterEach(function () {
        resolveInstallTargetStub.restore()
        recordInstallTargetStub.restore()
        resolveUpdateTargetStub.restore()
        delete process.env.XCHAIN_NODE_UPDATE_TARGET
    })

    // -------------------------------------------------------------------
    // installModules
    // -------------------------------------------------------------------

    describe('installModules()', function () {

        it('creates Docker network for each coin/network pair', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { bitcoin: { mainnet: ['xchain-encoder'] } }
            await ops.installModules(servicesList)
            expect(stubs.createDockerNetwork.calledOnce).to.be.true
        })

        it('builds database before installing modules', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { bitcoin: { mainnet: ['xchain-encoder'] } }
            await ops.installModules(servicesList)
            expect(stubs.buildDatabaseModule.calledBefore(stubs.installModule)).to.be.true
        })

        it('calls installModule for each module in the list', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } }
            await ops.installModules(servicesList)
            expect(stubs.installModule.callCount).to.equal(2)
        })

        it('handles multiple coins and networks', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = {
                bitcoin: { mainnet: ['xchain-encoder'], testnet: ['xchain-encoder'] },
                dogecoin: { mainnet: ['xchain-encoder'] }
            }
            await ops.installModules(servicesList)
            expect(stubs.installModule.callCount).to.equal(3)
            expect(stubs.createDockerNetwork.callCount).to.equal(3)
        })

        it('skips network creation and database for shared services (empty coin/network)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const servicesList = { '': { '': ['xchain-explorer'] } }
            await ops.installModules(servicesList)
            expect(stubs.createDockerNetwork.called).to.be.false
            expect(stubs.buildDatabaseModule.called).to.be.false
            expect(stubs.installModule.calledOnce).to.be.true
        })

        it('reports what it installed on success', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.installModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result.installed).to.deep.equal([{ module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet' }])
            expect(result.skipped).to.deep.equal([])
        })

        // installModule returns false for a module it declined to touch. Counting
        // that as installed is how "built nothing" and "built the stack" printed
        // the same. A no-op install is still not a failure (install is idempotent).
        it('reports a module installModule declined as skipped, not installed', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves(false)
            const ops = loadOperations(stubs)
            const result = await ops.installModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result.installed).to.deep.equal([])
            expect(result.skipped).to.deep.equal([
                { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', reason: 'already-installed' }
            ])
        })

        // A failed install is exactly where the summary earns its place: it
        // leaves some services restored and some facing days of resync, and
        // the error alone does not say which.
        it('reports the bootstrap outcomes even when the install throws', async function () {
            const stubs = makeStubs()
            stubs.installModule.rejects(new Error("Couldn't download the bitcoin node"))
            const ops = loadOperations(stubs)

            let threw = null
            try {
                await ops.installModules({ bitcoin: { mainnet: ['node'] } })
            } catch (err) { threw = err }

            expect(threw).to.be.an('error')
            expect(stubs.bootstrapService.reportBootstrapOutcomes.calledOnce).to.be.true
            // The failure still surfaces: the summary is added to it, not
            // substituted for it.
            expect(threw.message).to.contain("Couldn't download the bitcoin node")
        })

        it('still reports the bootstrap outcomes on a clean install', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.installModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.bootstrapService.resetBootstrapOutcomes.calledOnce).to.be.true
            expect(stubs.bootstrapService.reportBootstrapOutcomes.calledOnce).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // updateModules
    // -------------------------------------------------------------------

    describe('updateModules()', function () {

        // A gated migration the target DB never applied is a startup
        // crash-loop. The refusal is worth nothing unless it lands BEFORE
        // the working container is torn down.
        it('checks the migration precondition BEFORE the container is rebuilt', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-indexer'] } })
            expect(stubs.assertRequiredMigrationsApplied.calledBefore(stubs.installModule)).to.be.true
            expect(stubs.assertRequiredMigrationsApplied.calledWith('xchain-indexer', 'bitcoin', 'mainnet')).to.be.true
        })

        it('aborts the update, leaving the running container untouched, when the guard refuses', async function () {
            const stubs = makeStubs()
            stubs.assertRequiredMigrationsApplied.rejects(
                new Error('update refused: 2026-07-24-pubkeys-widen-uncompressed.sql has not been applied'))
            const ops = loadOperations(stubs)
            let err = null
            try {
                await ops.updateModules({ bitcoin: { mainnet: ['xchain-indexer'] } })
            } catch (e) { err = e }
            expect(err, 'the refusal must propagate out of updateModules').to.not.equal(null)
            expect(err.message).to.contain('2026-07-24-pubkeys-widen-uncompressed.sql')
            expect(stubs.installModule.called, 'nothing may be rebuilt after a refusal').to.be.false
        })

        it('fetches existing container ID before updating', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.db.getModuleContainer.calledWith('xchain-encoder', 'bitcoin', 'mainnet')).to.be.true
        })

        it('rebuilds non-node modules via installModule (which re-clones internally)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.installModule.calledWith('xchain-encoder', 'bitcoin', 'mainnet', true)).to.be.true
        })

        it('handles the node module via installModule (built from releases, not git-cloned)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.be.true
        })

        // installModule returns false when it decided not to rebuild. The loop used
        // to push every module onto `updated` regardless of that return value, so a
        // run that rebuilt nothing reported a landed deploy and the CLI exited 0.
        it('records a module installModule declined as a no-op, not as updated', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves(false)
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            let result
            try {
                result = await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            } finally { warn.restore() }
            expect(result.updated).to.deep.equal([])
            expect(result.skipped).to.deep.equal([
                { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', reason: 'no-op' }
            ])
        })

        it('records a declined NODE rebuild as a no-op too', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves(false)
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            let result
            try {
                result = await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            } finally { warn.restore() }
            expect(result.updated).to.deep.equal([])
            expect(result.skipped.map(s => s.reason)).to.deep.equal(['no-op'])
        })

        it('passes container ID to installModule for replacement', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            const installCall = stubs.installModule.firstCall
            expect(installCall.args[4]).to.equal('container-id-123') // overwriteContainerId
        })

        it('rebuilds the image, unlike recreate', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.buildAndUp.called).to.be.false
        })

        it('leaves the running node container to buildCryptoNode instead of force-removing it up front', async function () {
            // Regression: an up-front `docker rm -f` is SIGKILL, so the daemon
            // restarted at its last flushed block index (16 regtest blocks lost,
            // 2026-09-03). buildCryptoNode stops it gracefully and removes the
            // stopped carcass itself, right before its `docker run`.
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            expect(stubs.forceRemoveContainerByName.called).to.be.false
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true, null)).to.be.true
        })

        it('recreates the node even when its container is missing (no silent no-op)', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null) // node container crashed/removed
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true, null)).to.be.true
        })

        it('still skips a NON-node module whose container is missing', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            try {
                await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            } finally { warn.restore() }
            expect(stubs.installModule.called).to.be.false
        })

        // A run that changed nothing must be distinguishable from a run that
        // rebuilt containers: the caller turns an empty `updated` list into a
        // non-zero exit, which is the whole defence against a silent no-op
        // redeploy reading as success.
        it('reports what it updated so a no-op run is not indistinguishable from success', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const outcome = await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(outcome.updated).to.deep.equal([{ module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet' }])
            expect(outcome.skipped).to.deep.equal([])
        })

        it('reports an uninstalled module as SKIPPED (empty updated list), and warns about it', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            let outcome
            try {
                outcome = await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            } finally { warn.restore() }
            expect(outcome.updated).to.deep.equal([])
            expect(outcome.skipped).to.deep.equal([
                { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', reason: 'not-installed' }
            ])
            expect(warn.calledWithMatch(/no registered container/)).to.be.true
        })

        it('counts a rebuilt node as updated', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const outcome = await ops.updateModules({ bitcoin: { mainnet: ['node'] } })
            expect(outcome.updated).to.deep.equal([{ module: 'node', coin: 'bitcoin', network: 'mainnet' }])
        })

        // The database container is built from a pinned image, not from module
        // source, and its existing-container path changes nothing. Counting it as
        // updated is how `update database` exited 0 over an untouched container.
        it('refuses the database instead of reporting an untouched container as updated', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            let outcome
            try {
                outcome = await ops.updateModules({ '': { '': ['database'] } })
            } finally { warn.restore() }
            expect(outcome.updated).to.deep.equal([])
            expect(outcome.skipped).to.deep.equal([
                { module: 'database', coin: '', network: '', reason: 'not-updatable' }
            ])
            // Refused BEFORE any rebuild machinery runs, so nothing is torn down.
            expect(stubs.installModule.called).to.be.false
            expect(stubs.db.getModuleContainer.called).to.be.false
            expect(warn.calledWithMatch(/removed manually and reinstalled/)).to.be.true
        })

        it('still updates the other requested modules when the request also names the database', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            let outcome
            try {
                outcome = await ops.updateModules({ bitcoin: { mainnet: ['database', 'xchain-encoder'] } })
            } finally { warn.restore() }
            expect(outcome.updated).to.deep.equal([{ module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet' }])
            expect(outcome.skipped.map(s => s.module)).to.deep.equal(['database'])
        })
    })

    // -------------------------------------------------------------------
    // recreateModules
    // -------------------------------------------------------------------

    // A container freezes its env at `docker run`, so correcting a value it
    // carries means recreating it. Doing that through `update` also re-clones from
    // GitHub, which turns a credential repair into a version change on a live venue.
    describe('recreateModules()', function () {

        it('recreates from the current config while reusing the existing image', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(result.recreated).to.deep.equal([{ module: 'xchain-indexer', coin: 'dogecoin', network: 'regtest' }])
            expect(stubs.buildAndUp.calledOnce).to.be.true
            const args = stubs.buildAndUp.firstCall.args
            expect(args.slice(0, 3)).to.deep.equal(['xchain-indexer', 'dogecoin', 'regtest'])
            expect(args[3]).to.equal('container-id-123')  // overwriteContainerId
            expect(args[6]).to.deep.equal({ reuseImage: true })
        })

        it('never re-clones or rebuilds through installModule', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(stubs.installModule.called).to.be.false
            expect(stubs.cloneGit.called).to.be.false
        })

        it('provisions the DB accounts only after every container is back on config values', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-decoder', 'xchain-indexer'] } })
            expect(stubs.setDatabaseParameters.calledOnce).to.be.true
            expect(stubs.buildAndUp.calledTwice).to.be.true
            expect(stubs.buildAndUp.secondCall.calledBefore(stubs.setDatabaseParameters.firstCall)).to.be.true
        })

        it('skips DB provisioning for a service that owns no DB account', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-encoder'] } })
            expect(stubs.buildAndUp.calledOnce).to.be.true
            expect(stubs.setDatabaseParameters.called).to.be.false
            expect(stubs.setHubDatabaseParameters.called).to.be.false
        })

        // The recreated hub starts on the config store's HUB_DB_PASS. Without
        // rotating the live shared hub account to match, the verb that exists to
        // REPAIR credentials is the one that locks the hub out (ER_ACCESS_DENIED).
        it('rotates the shared hub DB account after recreating the hub', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.recreateModules({ '': { '': ['xchain-hub'] } })
            expect(result.recreated).to.deep.equal([{ module: 'xchain-hub', coin: '', network: '' }])
            expect(stubs.setHubDatabaseParameters.calledOnce).to.be.true
            expect(stubs.buildAndUp.firstCall.calledBefore(stubs.setHubDatabaseParameters.firstCall)).to.be.true
            // The per-coin decoder/indexer provisioning is a different account set
            // and must not be dragged in by a hub-only recreate.
            expect(stubs.setDatabaseParameters.called).to.be.false
        })

        it('does not rotate the hub account when the hub was not recreated', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(stubs.setHubDatabaseParameters.called).to.be.false
        })

        // Registry DRIFT: the row is gone but the container is still on the host.
        // Recreating is right here, and is why the not-installed guard keys off a
        // positive docker probe rather than off the missing row alone.
        it('recreates a container the registry has lost rather than skipping it', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            stubs.probeContainerPresenceByName.resolves('exists')
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(stubs.buildAndUp.calledOnce).to.be.true
            expect(stubs.buildAndUp.firstCall.args[3]).to.equal(null)
        })

        // UNINSTALLED: no row and docker positively reports no container. Recreating
        // here hands back a service the operator tore down, built from the image tag
        // `uninstall` leaves behind, and then rotates the shared DB accounts for it.
        it('refuses to recreate a module docker positively reports gone', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            stubs.probeContainerPresenceByName.resolves('gone')
            const warn = sinon.stub(console, 'warn')
            let result
            try {
                result = await loadOperations(stubs).recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            } finally { warn.restore() }
            expect(stubs.buildAndUp.called).to.be.false
            expect(result.recreated).to.deep.equal([])
            expect(result.skipped).to.deep.equal([
                { module: 'xchain-indexer', coin: 'dogecoin', network: 'regtest', reason: 'not-installed' }
            ])
            expect(stubs.setDatabaseParameters.called).to.be.false
            expect(stubs.probeContainerPresenceByName.calledWith('dogecoin-regtest-xchain-indexer')).to.be.true
        })

        // 'unknown' is a daemon hiccup, not an absence. Refusing on it would turn a
        // docker blip into a refusal to repair a live container's credentials.
        it('still recreates when the presence probe is inconclusive', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            stubs.probeContainerPresenceByName.resolves('unknown')
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(stubs.buildAndUp.calledOnce).to.be.true
            expect(stubs.buildAndUp.firstCall.args[3]).to.equal(null)
        })

        // A registered container never reaches the probe: one `docker inspect` per
        // venue on `recreate all` is worth paying only where the row is missing.
        it('does not probe docker when the registry has a container id', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
            expect(stubs.probeContainerPresenceByName.called).to.be.false
        })

        // `recreate all` fans out over every coin x network x service, so one bad
        // venue must not abort the sweep: the rest would go untouched behind a flat
        // "recreate failed" that hides which venues were already recreated.
        it('finishes the sweep past a failing venue and names every failure', async function () {
            const stubs = makeStubs()
            stubs.buildAndUp.onFirstCall().rejects(new Error('No local image tagged x to reuse'))
            const err = sinon.stub(console, 'error')
            try {
                await loadOperations(stubs).recreateModules({ dogecoin: { regtest: ['xchain-encoder', 'xchain-indexer'] } })
                expect.fail('a sweep with a failed venue must not resolve')
            } catch (e) {
                expect(e.message).to.match(/xchain-encoder \(dogecoin regtest\)/)
                expect(e.message).to.match(/No local image tagged/)
            } finally { err.restore() }
            expect(stubs.buildAndUp.calledTwice).to.be.true
            expect(stubs.buildAndUp.secondCall.args.slice(0, 3))
                .to.deep.equal(['xchain-indexer', 'dogecoin', 'regtest'])
        })

        // The venues that DID come back start on the config store's password, so
        // they still need their accounts rotated before the run reports failure.
        it('provisions the venues that came back before failing the run', async function () {
            const stubs = makeStubs()
            stubs.buildAndUp.onFirstCall().rejects(new Error('boom'))
            const err = sinon.stub(console, 'error')
            try {
                await loadOperations(stubs).recreateModules({ dogecoin: { regtest: ['xchain-encoder', 'xchain-indexer'] } })
                expect.fail('a sweep with a failed venue must not resolve')
            } catch { /* asserted above */ } finally { err.restore() }
            expect(stubs.setDatabaseParameters.calledOnce).to.be.true
        })

        it('refuses the modules whose containers are not built from the config map', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.recreateModules({ dogecoin: { regtest: ['node', 'database'] } })
            expect(stubs.buildAndUp.called).to.be.false
            // Refusing every requested module must be REPORTED, not just printed:
            // the CLI turns an empty `recreated` list into a non-zero exit. It used
            // to log the refusal, return true and exit 0.
            expect(result.recreated).to.deep.equal([])
            expect(result.skipped.map(s => s.module)).to.deep.equal(['node', 'database'])
            expect(result.skipped.every(s => s.reason === 'not-recreatable')).to.be.true
        })

        it('still recreates the supported modules when the request also names an unsupported one', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.recreateModules({ dogecoin: { regtest: ['node', 'xchain-indexer'] } })
            expect(stubs.buildAndUp.calledOnce).to.be.true
            expect(result.recreated.map(r => r.module)).to.deep.equal(['xchain-indexer'])
            expect(result.skipped.map(s => s.module)).to.deep.equal(['node'])
        })

        it('propagates a failure instead of reporting success', async function () {
            const stubs = makeStubs()
            stubs.buildAndUp.rejects(new Error('No local image tagged x to reuse'))
            const ops = loadOperations(stubs)
            try {
                await ops.recreateModules({ dogecoin: { regtest: ['xchain-indexer'] } })
                expect.fail('a failed recreate must not resolve')
            } catch (err) {
                expect(err.message).to.match(/No local image tagged/)
            }
            expect(stubs.setDatabaseParameters.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // uninstallModules
    // -------------------------------------------------------------------

    describe('uninstallModules()', function () {

        it('calls uninstallModule for each module', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(stubs.uninstallModule.callCount).to.equal(2)
        })

        // Continuing past a failed module is deliberate: an operator tearing a
        // stack down wants the rest gone. Reporting SUCCESS afterwards is not:
        // `uninstall all` printed a clean teardown with containers still running.
        it('continues on error for individual modules, then fails the batch', async function () {
            const stubs = makeStubs()
            stubs.uninstallModule.onFirstCall().rejects(new Error('fail'))
            stubs.uninstallModule.onSecondCall().resolves(true)
            const ops = loadOperations(stubs)
            let thrown = null
            try {
                await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            } catch (err) { thrown = err }
            expect(thrown, 'a failed uninstall must not resolve').to.not.equal(null)
            expect(thrown.message).to.match(/uninstall failed for 1 module: xchain-encoder/)
            expect(stubs.uninstallModule.callCount).to.equal(2)
            expect(thrown.uninstalled.map(u => u.module)).to.deep.equal(['xchain-decoder'])
        })

        it('rejects when all modules fail, naming every one of them', async function () {
            const stubs = makeStubs()
            stubs.uninstallModule.rejects(new Error('fail'))
            const ops = loadOperations(stubs)
            let thrown = null
            try {
                await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            } catch (err) { thrown = err }
            expect(thrown).to.not.equal(null)
            expect(thrown.message).to.match(/uninstall failed for 2 modules/)
            expect(thrown.message).to.include('xchain-encoder')
            expect(thrown.message).to.include('xchain-decoder')
            expect(thrown.failures).to.have.lengthOf(2)
        })

        it('reports what it removed when every module succeeds', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result.uninstalled).to.deep.equal([{ module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet' }])
        })
    })

    // -------------------------------------------------------------------
    // startModules
    // -------------------------------------------------------------------

    describe('startModules()', function () {

        it('looks up container ID and calls startContainer', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.startModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.db.getModuleContainer.calledOnce).to.be.true
            expect(stubs.startContainer.calledWith('container-id-123')).to.be.true
        })

        it('skips module when container ID is not found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.startModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.startContainer.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // stopModules
    // -------------------------------------------------------------------

    describe('stopModules()', function () {

        it('looks up the container id and stops it with the service budget, not a bare docker stop', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.stopContainerByName.calledWith('container-id-123', 30)).to.be.true
            expect(stubs.stopContainer.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // restartModules
    // -------------------------------------------------------------------

    describe('restartModules()', function () {

        it('calls restartContainer and statusChanged', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.restartModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.restartContainer.calledWith('container-id-123')).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // execModules
    // -------------------------------------------------------------------

    describe('execModules()', function () {

        it('passes command to execContainer', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.execModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'ls -la')
            expect(stubs.execContainer.calledWith('container-id-123', ['ls', '-la'])).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // clearDecoderReorgHalt
    // -------------------------------------------------------------------

    describe('clearDecoderReorgHalt()', function () {
        const REASON = 'BTC mainnet decoder, no dispensers exist yet, block range intact'

        it('runs the decoder\'s own clear script inside the decoder container with the reason', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const ok = await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, { reason: REASON })
            expect(ok).to.be.true
            expect(stubs.db.getModuleContainer.calledWith('xchain-decoder', 'bitcoin', 'mainnet')).to.be.true
            expect(stubs.execContainer.calledWith('container-id-123',
                ['node', 'src/clear-reorg-halt.js', '--reason', REASON])).to.be.true
        })

        it('passes --force and --dry-run through', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, { reason: REASON, force: true, dryRun: true })
            expect(stubs.execContainer.firstCall.args[1]).to.deep.equal(
                ['node', 'src/clear-reorg-halt.js', '--reason', REASON, '--force', '--dry-run'])
        })

        it('refuses a trivial reason without touching any container', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            expect(await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, { reason: 'short' })).to.be.false
            expect(stubs.execContainer.called).to.be.false
        })

        it('reports false when the script refuses (non-zero exit) and prints its text', async function () {
            const stubs = makeStubs()
            stubs.execContainer.rejects(Object.assign(new Error('exit 4'), { stderr: 'clear-reorg-halt: REFUSED. dispenser state' }))
            const ops = loadOperations(stubs)
            const logged = []
            const orig = console.log
            console.log = (l) => logged.push(String(l))
            let ok
            try { ok = await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, { reason: REASON }) }
            finally { console.log = orig }
            expect(ok).to.be.false
            expect(logged.some(l => /REFUSED/.test(l))).to.be.true
        })

        it('reports false when no decoder container is installed for the target', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            expect(await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-decoder'] } }, { reason: REASON })).to.be.false
            expect(stubs.execContainer.called).to.be.false
        })

        it('ignores non-decoder modules in the list', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            expect(await ops.clearDecoderReorgHalt({ bitcoin: { mainnet: ['xchain-encoder'] } }, { reason: REASON })).to.be.false
            expect(stubs.execContainer.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // shellModule
    // -------------------------------------------------------------------

    describe('shellModule()', function () {

        it('calls shellContainer for the first module only', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.shellModule({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(stubs.shellContainer.calledOnce).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // logModules
    // -------------------------------------------------------------------

    describe('logModules()', function () {

        it('calls logContainer with follow=true by default', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.logContainer.calledOnce).to.be.true
            expect(stubs.logContainer.firstCall.args[1]).to.be.true
        })

        it('passes follow=false when specified', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, false)
            expect(stubs.logContainer.firstCall.args[1]).to.be.false
        })

        it('non-follow: dumps every selected service, not just the first', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } }, false)
            expect(stubs.logContainer.calledTwice).to.be.true
        })

        it('follow: only attaches to the first service (single-TTY limit)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } }, true)
            expect(stubs.logContainer.calledOnce).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // monitorModules
    // -------------------------------------------------------------------

    describe('monitorModules()', function () {

        it('collects container IDs and passes to startDockerMonitor', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.monitorModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(stubs.startDockerMonitor.calledOnce).to.be.true
            const containerIds = stubs.startDockerMonitor.firstCall.args[0]
            expect(containerIds).to.have.length(2)
        })
    })

    // -------------------------------------------------------------------
    // shellModule: error path
    // -------------------------------------------------------------------

    describe('shellModule(): error path', function () {

        it('continues after shellContainer error and returns true', async function () {
            const stubs = makeStubs()
            stubs.shellContainer.rejects(new Error('shell failed'))
            const ops = loadOperations(stubs)
            const result = await ops.shellModule({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })

        it('returns true when no container found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.shellModule({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.shellContainer.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // updateModules: branch handling
    // -------------------------------------------------------------------

    describe('updateModules(): branch handling', function () {

        it('skips module when container ID is not found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            let result
            try {
                result = await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            } finally { warn.restore() }
            expect(result.updated).to.deep.equal([])
            expect(stubs.installModule.called).to.be.false
        })

        // The branch must reach installModule (7th arg); installModule re-clones on the
        // remoteUpdate path, so a null branch there clobbers the requested branch with the
        // default. Regression for `update <svc> <chain> <net> <branch>` deploying master.
        it('threads the provided branch through to installModule', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'feature/test')
            expect(stubs.installModule.calledWith(
                'xchain-encoder', 'bitcoin', 'mainnet', true, 'container-id-123', false, 'feature/test'
            )).to.be.true
        })

        it('falls back to getModuleBranch (current branch) when no branch specified', async function () {
            const stubs = makeStubs()
            stubs.getModuleBranch.resolves('feature/existing')
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.getModuleBranch.calledOnce).to.be.true
            expect(stubs.installModule.calledWith(
                'xchain-encoder', 'bitcoin', 'mainnet', true, 'container-id-123', false, 'feature/existing'
            )).to.be.true
        })

        it('proceeds with null branch if getModuleBranch throws', async function () {
            const stubs = makeStubs()
            stubs.getModuleBranch.rejects(new Error('not a git repo'))
            const ops = loadOperations(stubs)
            const result = await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result.updated).to.have.lengthOf(1)
            expect(stubs.installModule.calledWith(
                'xchain-encoder', 'bitcoin', 'mainnet', true, 'container-id-123', false, null
            )).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // updateModules: what a no-ref update means (release node vs branch node)
    // -------------------------------------------------------------------

    describe('updateModules(): no-ref target resolution', function () {

        // The documented upgrade is `xchain-node update all`. A release-installed
        // node is a detached checkout, so the old "same branch, newer commits"
        // reading answered HEAD and failed. Measured on the v0.15.2 fleet roll.
        it('moves a RELEASE node to the latest release, pinned, refusing any branch fallback', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(resolveInstallTargetStub.calledOnce).to.be.true
            const [ref, opts] = resolveInstallTargetStub.firstCall.args
            expect(ref).to.equal(null)
            expect(opts.fallbackToBranch).to.equal(false)
            expect(stubs.installModule.calledWith('xchain-encoder', 'bitcoin', 'mainnet', true)).to.be.true
        })

        it('records what the node is on, so the next no-ref update converges on it', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'v0.11.0')
            // Under a release update the record is written by withInstallTarget
            // from the resolved target.
            expect(recordInstallTargetStub.calledOnce).to.be.true
            expect(recordInstallTargetStub.firstCall.args[0].kind).to.equal('release')
        })

        it('keeps a BRANCH node on its branch and takes newer commits', async function () {
            const stubs = makeStubs()
            resolveUpdateTargetStub.resolves({ kind: 'branch', ref: 'develop', tag: null, inferred: false })
            const ops = loadOperations(stubs)
            const log = sinon.stub(console, 'log')
            try {
                await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            } finally { log.restore() }
            expect(resolveInstallTargetStub.called, 'a branch node must not resolve a release').to.be.false
            expect(stubs.installModule.calledWith(
                'xchain-encoder', 'bitcoin', 'mainnet', true, 'container-id-123', false, 'develop'
            )).to.be.true
            expect(recordInstallTargetStub.calledWith(sinon.match({ kind: 'branch', ref: 'develop' }))).to.be.true
        })

        it('treats an explicitly named branch as a decision and records it', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'feature/x')
            expect(resolveInstallTargetStub.called).to.be.false
            expect(recordInstallTargetStub.calledWith(sinon.match({ kind: 'branch', ref: 'feature/x' }))).to.be.true
        })

        it('stops with nothing changed when the latest release cannot be resolved', async function () {
            const stubs = makeStubs()
            resolveInstallTargetStub.rejects(new Error('Could not resolve the latest xchain-node release (ENOTFOUND). Nothing was changed.'))
            const ops = loadOperations(stubs)
            let err = null
            try { await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }) } catch (e) { err = e }
            expect(err).to.not.equal(null)
            expect(err.message).to.match(/Nothing was changed/)
            expect(stubs.installModule.called).to.be.false
        })

        // The re-executed child of a CLI self-update is handed the tag its parent
        // resolved and verified; resolving it again would be a second API call
        // and a second chance to disagree.
        it('uses the tag a self-update already resolved instead of looking it up again', async function () {
            const stubs = makeStubs()
            process.env.XCHAIN_NODE_UPDATE_TARGET = 'v0.11.0'
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(resolveUpdateTargetStub.called, 'the record is not consulted when the target is known').to.be.false
            expect(resolveInstallTargetStub.firstCall.args[0]).to.equal('v0.11.0')
        })

        it('clones the default branch, never "HEAD", for a detached module the manifest does not carry', async function () {
            const stubs = makeStubs()
            stubs.getModuleBranch.resolves('HEAD')
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(stubs.installModule.calledWith(
                'xchain-encoder', 'bitcoin', 'mainnet', true, 'container-id-123', false, null
            )).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // updateModules: `all` includes the shared services, hub first
    // -------------------------------------------------------------------

    describe('updateModules(): the `all` expansion', function () {

        function servicesFromAll() {
            return require('../../src/services/ConfigService').filterCommandParameters(null, 'all', 'bitcoin', 'mainnet')
        }

        it('updates the hub, then sync, then the explorer, before any coin stack', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            try {
                await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { warn.restore() }
            const order = stubs.installModule.getCalls().map(c => c.args[0])
            expect(order[0]).to.equal('xchain-hub')
            expect(order[1]).to.equal('xchain-sync')
            expect(order[2]).to.equal('xchain-explorer')
            expect(order.indexOf('xchain-indexer')).to.be.greaterThan(2)
            // Shared services are addressed under the empty coin/network key.
            expect(stubs.installModule.firstCall.args.slice(1, 3)).to.deep.equal(['', ''])
        })

        it('re-runs the validator repair before rebuilding the hub on an initialized validator', async function () {
            const stubs = makeStubs()
            const validator = require('../../src/services/ValidatorService')
            const isInitialized = sinon.stub(validator, 'isInitialized').returns(true)
            const initValidator = sinon.stub(validator, 'initValidator').resolves({ pubkey: 'ab' })
            const ops = loadOperations(stubs)
            const log = sinon.stub(console, 'log')
            const warn = sinon.stub(console, 'warn')
            try {
                await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { log.restore(); warn.restore(); isInitialized.restore(); initValidator.restore() }
            expect(initValidator.calledOnce).to.equal(true)
            expect(initValidator.firstCall.args[0]).to.deep.equal({})
            expect(initValidator.calledBefore(stubs.installModule)).to.equal(true)
        })

        it('does not touch validator config on a node that is not a validator, or when the hub is out of scope', async function () {
            const stubs = makeStubs()
            const validator = require('../../src/services/ValidatorService')
            const isInitialized = sinon.stub(validator, 'isInitialized').returns(false)
            const initValidator = sinon.stub(validator, 'initValidator').resolves()
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            try {
                await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
                isInitialized.returns(true)
                await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'v0.11.0')
            } finally { warn.restore(); isInitialized.restore(); initValidator.restore() }
            expect(initValidator.called).to.equal(false)
        })

        it('continues the hub update when the validator repair fails, and says so', async function () {
            const stubs = makeStubs()
            const validator = require('../../src/services/ValidatorService')
            const isInitialized = sinon.stub(validator, 'isInitialized').returns(true)
            const initValidator = sinon.stub(validator, 'initValidator').rejects(new Error('wallets.env unreadable'))
            const ops = loadOperations(stubs)
            const log = sinon.stub(console, 'log')
            const warn = sinon.stub(console, 'warn')
            let result
            try {
                result = await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { log.restore(); warn.restore(); isInitialized.restore(); initValidator.restore() }
            expect(warn.calledWithMatch(/wallets\.env unreadable/)).to.equal(true)
            expect(result.updated.map(u => u.module)).to.include('xchain-hub')
        })

        it('leaves the hub and sync out of a targeted update, as before', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'v0.11.0')
            expect(stubs.installModule.getCalls().map(c => c.args[0])).to.deep.equal(['xchain-encoder'])
        })

        it('reports a shared service that is not installed as skipped, not as a failure', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.callsFake(async (module) => module === 'xchain-sync' ? null : 'container-id-123')
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            const log = sinon.stub(console, 'log')
            let result
            try {
                result = await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { warn.restore(); log.restore() }
            expect(result.skipped.find(s => s.module === 'xchain-sync').reason).to.equal('not-installed')
            expect(result.updated.map(u => u.module)).to.include('xchain-hub')
        })

        // A validator is a hub and nothing else; `all` still expands to every
        // coin service, and one warning per absent service buried the two lines
        // that mattered.
        it('collapses the absent services into one line under `all`, and keeps the per-service warning for a targeted update', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.callsFake(async (module) => module === 'xchain-hub' ? 'container-id-123' : null)
            const ops = loadOperations(stubs)
            const warn = sinon.stub(console, 'warn')
            const log = sinon.stub(console, 'log')
            let result
            try {
                result = await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { warn.restore(); log.restore() }
            const absent = result.skipped.filter(s => s.reason === 'not-installed').length
            expect(absent).to.be.greaterThan(1)
            expect(warn.getCalls().filter(c => /no registered container/.test(c.args[0]))).to.have.lengthOf(0)
            expect(log.getCalls().filter(c => new RegExp(`skipped ${absent} services not installed`).test(c.args[0]))).to.have.lengthOf(1)

            const warn2 = sinon.stub(console, 'warn')
            try {
                await ops.updateModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'v0.11.0')
            } finally { warn2.restore() }
            expect(warn2.calledWithMatch(/xchain-encoder \(bitcoin mainnet\) has no registered container/)).to.equal(true)
        })

        // A rebuild of a coin node that was already at the pinned daemon
        // version restarted a healthy daemon and broke a relocated datadir's mounts.
        it('leaves a coin node running when it already carries the pinned daemon version', async function () {
            const stubs = makeStubs()
            stubs.getLastStatus = () => ({ bitcoin: { mainnet: { node: { container_version: '28.1\n' } } } })
            stubs.getRemoteModuleVersions = () => ({ 'node-bitcoin': { tag_name: 'v28.1' } })
            const ops = loadOperations(stubs)
            const log = sinon.stub(console, 'log')
            let result
            try {
                result = await ops.updateModules({ bitcoin: { mainnet: ['node', 'xchain-encoder'] } }, 'v0.11.0', { all: true })
            } finally { log.restore() }
            expect(stubs.installModule.calledWith('node')).to.be.false
            expect(result.skipped).to.deep.include({ module: 'node', coin: 'bitcoin', network: 'mainnet', reason: 'current' })
            expect(result.updated.map(u => u.module)).to.include('xchain-encoder')
            expect(result.updated.map(u => u.module)).to.not.include('node')
        })

        it('still rebuilds a coin node that is behind the pinned daemon version', async function () {
            const stubs = makeStubs()
            stubs.getLastStatus = () => ({ bitcoin: { mainnet: { node: { container_version: '27.0' } } } })
            stubs.getRemoteModuleVersions = () => ({ 'node-bitcoin': { tag_name: 'v28.1' } })
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } }, 'v0.11.0', { all: true })
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.be.true
        })

        it('rebuilds a coin node whose pinned version it cannot determine', async function () {
            // Any doubt answers "rebuild": the operator could always get one.
            const stubs = makeStubs()
            stubs.getLastStatus = () => ({ bitcoin: { mainnet: { node: { container_version: '28.1' } } } })
            const versions = require('../../src/services/VersionService')
            const check = sinon.stub(versions, 'checkRemoteNodeVersion').rejects(new Error('rate limited'))
            const ops = loadOperations(stubs)
            try {
                await ops.updateModules({ bitcoin: { mainnet: ['node'] } }, 'v0.11.0', { all: true })
            } finally { check.restore() }
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.be.true
        })

        it('does not install a coin node that is absent under `all`, but still recreates one on a targeted update', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.callsFake(async (module) => module === 'xchain-hub' ? 'container-id-123' : null)
            const ops = loadOperations(stubs)
            const log = sinon.stub(console, 'log')
            const warn = sinon.stub(console, 'warn')
            let result
            try {
                result = await ops.updateModules(servicesFromAll(), 'v0.11.0', { all: true })
            } finally { log.restore(); warn.restore() }
            expect(stubs.installModule.calledWith('node')).to.equal(false)
            expect(result.skipped).to.deep.include({ module: 'node', coin: 'bitcoin', network: 'mainnet', reason: 'not-installed' })

            await ops.updateModules({ bitcoin: { mainnet: ['node'] } }, 'v0.11.0')
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.equal(true)
        })

        it('rebuilds a coin node on a TARGETED update whatever version it runs', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.updateModules({ bitcoin: { mainnet: ['node'] } }, 'v0.11.0')
            expect(stubs.installModule.calledWith('node', 'bitcoin', 'mainnet', true)).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // uninstallModules: includeShared=true
    // -------------------------------------------------------------------

    describe('uninstallModules(): includeShared', function () {

        it('skips shared modules by default', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['database', 'xchain-encoder'] } })
            // database is in sharedModules → skipped
            // xchain-encoder is uninstalled
            expect(stubs.uninstallModule.callCount).to.equal(1)
            expect(stubs.uninstallModule.firstCall.args[2]).to.equal('xchain-encoder')
        })

        it('includes shared modules when includeShared=true', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['database', 'xchain-encoder'] } }, true)
            expect(stubs.uninstallModule.callCount).to.equal(2)
        })

        it('skips xchain-sync by default (shared singleton, same guard as database/hub/explorer)', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-sync', 'xchain-encoder'] } })
            // xchain-sync is shared -> skipped; only xchain-encoder is uninstalled
            expect(stubs.uninstallModule.callCount).to.equal(1)
            expect(stubs.uninstallModule.firstCall.args[2]).to.equal('xchain-encoder')
        })

        it('includes xchain-sync when includeShared=true', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-sync', 'xchain-encoder'] } }, true)
            expect(stubs.uninstallModule.callCount).to.equal(2)
        })

        // A shared service (explorer/hub/database/sync) is installed once and serves
        // every coin/network on the box. `--include-shared` asked for it to come down
        // with the coin being removed, which took the explorer away from every OTHER
        // coin still installed.
        it('keeps a shared module when another coin/network is still installed', async function () {
            const stubs = makeStubs()
            stubs.db.getAllModuleContainers.resolves([
                { module: 'xchain-indexer', coin: 'dogecoin', network: 'mainnet', container_id: 'c1' },
                { module: 'xchain-explorer', coin: '', network: '', container_id: 'c2' }
            ])
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-explorer', 'xchain-encoder'] } }, true)

            expect(stubs.uninstallModule.callCount).to.equal(1)
            expect(stubs.uninstallModule.firstCall.args[2]).to.equal('xchain-encoder')
            const kept = result.skipped.find(s => s.module === 'xchain-explorer')
            expect(kept, 'the explorer must be reported as kept, not silently dropped').to.exist
            expect(kept.reason).to.contain('dogecoin mainnet')
        })

        it('still removes shared modules once the last coin/network is gone', async function () {
            const stubs = makeStubs()
            // Only the shared services themselves remain registered (coin '').
            stubs.db.getAllModuleContainers.resolves([
                { module: 'xchain-explorer', coin: '', network: '', container_id: 'c2' }
            ])
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-explorer', 'xchain-encoder'] } }, true)
            expect(stubs.uninstallModule.callCount).to.equal(2)
        })

        it('orders the shared pass LAST, so a full teardown still reaches it', async function () {
            const stubs = makeStubs()
            const ops = loadOperations(stubs)
            await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-explorer', 'xchain-encoder'] } }, true)
            expect(stubs.uninstallModule.callCount).to.equal(2)
            expect(stubs.uninstallModule.firstCall.args[2]).to.equal('xchain-encoder')
            expect(stubs.uninstallModule.secondCall.args[2]).to.equal('xchain-explorer')
        })

        it('refuses the shared removal rather than guessing when the registry is unreadable', async function () {
            const stubs = makeStubs()
            stubs.db.getAllModuleContainers.rejects(new Error('modules table gone'))
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-explorer'] } }, true)
            expect(stubs.uninstallModule.callCount).to.equal(0)
            expect(result.skipped[0].reason).to.contain('modules table gone')
        })

        it('skips module when container ID is null', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.uninstallModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result.uninstalled).to.deep.equal([])
            expect(result.skipped).to.deep.equal([
                { module: 'xchain-encoder', coin: 'bitcoin', network: 'mainnet', reason: 'not-installed' }
            ])
            expect(stubs.uninstallModule.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // runE2ETest
    // -------------------------------------------------------------------

    describe('runE2ETest()', function () {

        it('installs e2e module, waits, saves logs, removes container', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            stubs.waitContainer.resolves(0)
            const ops = loadOperations(stubs)
            const result = await ops.runE2ETest('bitcoin', 'mainnet')
            expect(stubs.installModule.calledOnce).to.be.true
            expect(stubs.waitContainer.calledWith('e2e-container-id')).to.be.true
            expect(stubs.saveContainerLogs.calledWith('e2e-container-id')).to.be.true
            expect(stubs.removeContainer.calledWith('e2e-container-id')).to.be.true
            expect(result.exitCode).to.equal(0)
            expect(result.logFile).to.be.a('string')
        })

        it('builds mocha docker args when testName is provided', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet', 'myTest', null)
            const installArgs = stubs.installModule.firstCall.args
            const dockerCmdArgs = installArgs[7]
            expect(dockerCmdArgs).to.include('mocha')
            expect(dockerCmdArgs.some(a => a.includes('myTest'))).to.be.true
        })

        it('includes --grep when grep is provided with testName', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet', 'myTest', 'my grep pattern')
            const dockerCmdArgs = stubs.installModule.firstCall.args[7]
            expect(dockerCmdArgs).to.include('--grep')
            expect(dockerCmdArgs).to.include('my grep pattern')
        })

        it('uses npm run script when script is provided', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet', null, null, 'test:sdk')
            const dockerCmdArgs = stubs.installModule.firstCall.args[7]
            expect(dockerCmdArgs).to.deep.equal(['npm', 'run', 'test:sdk'])
        })

        it('passes null dockerCmdArgs when no testName or script', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'mainnet')
            const dockerCmdArgs = stubs.installModule.firstCall.args[7]
            expect(dockerCmdArgs).to.be.null
        })

        // The suite is code and is cloned like any other module, so it took
        // xchain-e2e-test's default branch regardless of the ref the stack under
        // it was installed at. On the ceremony's freeze gate that is master's
        // suites grading a release stack: a suite corrected on the release branch
        // never runs, and one deleted there runs anyway.
        it('clones the suite at the ref it was given', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'regtest', null, null, 'test:security', 'release/v0.10.0')
            expect(stubs.installModule.firstCall.args[6]).to.equal('release/v0.10.0')
        })

        it('passes null when no ref was given, keeping the default-branch behaviour', async function () {
            const stubs = makeStubs()
            stubs.installModule.resolves('e2e-container-id')
            const ops = loadOperations(stubs)
            await ops.runE2ETest('bitcoin', 'regtest')
            expect(stubs.installModule.firstCall.args[6]).to.equal(null)
        })
    })

    // -------------------------------------------------------------------
    // resetModules
    // -------------------------------------------------------------------

    describe('resetModules()', function () {

        it('resets all services when service=all', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('all', 'bitcoin', 'mainnet', true)
            await clock.tickAsync(6000) // advance past 5000ms bounce delay
            clock.restore()
            const result = await promise
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.true
            expect(stubs.startContainer.called).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
        })

        it('only resets node data when service=node', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.true
            // No bounce candidates for node-only reset
        })

        // The node datadir came from XCHAIN_NODE_DATA_DIR, and the wipe
        // was guarded on fs.existsSync of that path. A reset run from a shell
        // that never sourced the operator's profile therefore resolved a path
        // the stack has never used, the guard went silently false, and the run
        // wiped the decoder/indexer DBs, left the chain in place, and exited 0.
        // The missing "Clearing node data" line was the only tell.
        describe('node datadir resolution', function () {

            // The host side of every `docker run --rm -v <host>:/data` this
            // reset issued: what was actually wiped, in host paths.
            function wipedHostPaths(execFileStub) {
                return execFileStub.getCalls()
                    .filter(c => c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
                    .map(c => c.args[1][c.args[1].indexOf('-v') + 1])
            }

            it('wipes the path the node container reports, not the env-derived one', async function () {
                const stubs = makeStubs()
                // Nothing at the env-derived path: the old guard's silent skip.
                stubs.fs.existsSync.returns(false)
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
                expect(result).to.be.true
                expect(wipedHostPaths(stubs.execFile))
                    .to.include('/srv/xchain/data/node/bitcoin/mainnet:/data')
            })

            it('falls back to the configured datadir when the container reports no mount', async function () {
                const stubs = makeStubs()
                stubs.getContainerBindMounts.resolves([])
                stubs.fs.existsSync.returns(true)
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
                expect(result).to.be.true
                const wiped = wipedHostPaths(stubs.execFile)
                expect(wiped.some(p => p.endsWith('/node/bitcoin/mainnet:/data'))).to.be.true
            })

            it('refuses the whole reset when the datadir resolves to nothing', async function () {
                const stubs = makeStubs()
                stubs.getContainerBindMounts.resolves([])
                stubs.fs.existsSync.returns(false)
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                expect(result).to.be.false
                // Fails closed BEFORE anything is stopped or wiped: the whole
                // point is that the DBs must not go without the chain.
                expect(stubs.stopContainer.called).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                expect(wipedHostPaths(stubs.execFile)).to.be.empty
            })

            it('names the container, the configured path and the env var in the refusal', async function () {
                const stubs = makeStubs()
                stubs.getContainerBindMounts.resolves([])
                stubs.fs.existsSync.returns(false)
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...args) => lines.push(args.join(' ')))
                try {
                    await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                const output = lines.join('\n')
                expect(output).to.include('Aborted: cannot resolve the bitcoin mainnet node datadir')
                expect(output).to.include('No data was touched.')
                expect(output).to.include('bitcoin-mainnet-node')
                expect(output).to.include('XCHAIN_NODE_DATA_DIR')
            })

            it('skips the node wipe out loud, and completes, when no node is installed', async function () {
                const stubs = makeStubs()
                stubs.getContainerBindMounts.resolves([])
                stubs.fs.existsSync.returns(false)
                stubs.db.getModuleContainer.withArgs('node', 'bitcoin', 'mainnet').resolves(null)
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...args) => lines.push(args.join(' ')))
                let result
                try {
                    result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.true
                expect(lines.join('\n')).to.include('no node data to clear')
                expect(wipedHostPaths(stubs.execFile)).to.be.empty
            })
        })

        // A pre-wipe MariaDB guard that is docker-mode only lets an
        // EXTERNAL_DB reset reached the database for the first time at
        // resetDatabases: after the stop loop, the datadir wipe and the tracker
        // volume wipe, and before the restart pass. An unreachable host (or a
        // partial XCHAIN_NODE_EXTERNAL_DB_* env) therefore left the operator
        // with the chain destroyed, the databases untouched and every service
        // down (uuid:41887889).
        describe('EXTERNAL_DB pre-wipe reachability guard', function () {

            // Host side of every `docker run --rm -v <host>:/data` this reset issued.
            function wipedPaths(execFileStub) {
                return execFileStub.getCalls()
                    .filter(c => c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
                    .map(c => c.args[1][c.args[1].indexOf('-v') + 1])
            }

            it('aborts before anything is stopped or wiped when the external DB is unreachable', async function () {
                const stubs = makeStubs()
                stubs.pingExternalDatabase.resolves({
                    ok: false, host: 'db.example', port: 3306, error: 'connect ECONNREFUSED'
                })
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs, { EXTERNAL_DB: true })
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...args) => lines.push(args.join(' ')))
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.stopContainer.called).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                expect(wipedPaths(stubs.execFile)).to.be.empty
                const output = lines.join('\n')
                expect(output).to.include('cannot reach the external MariaDB at db.example:3306')
                expect(output).to.include('connect ECONNREFUSED')
                expect(output).to.include('No data was touched.')
            })

            it('aborts the same way when the external config cannot be resolved', async function () {
                const stubs = makeStubs()
                // getExternalDbConfig throws on a partial env with no TTY; the
                // probe reports that instead of unwinding past the restart pass.
                stubs.pingExternalDatabase.resolves({
                    ok: false, host: null, port: null, error: 'External-DB connection details are needed'
                })
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs, { EXTERNAL_DB: true })
                const logStub = sinon.stub(console, 'log')
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.stopContainer.called).to.be.false
                expect(wipedPaths(stubs.execFile)).to.be.empty
            })

            it('proceeds to the reset when the external DB answers', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs, { EXTERNAL_DB: true })
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('all', 'bitcoin', 'mainnet', true)
                await clock.tickAsync(6000)
                clock.restore()
                const result = await promise
                expect(result).to.be.true
                expect(stubs.pingExternalDatabase.calledOnce).to.be.true
                expect(stubs.resetDatabases.called).to.be.true
                // The container lookup is the docker-mode branch and must not run here.
                expect(stubs.getDatabaseContainerId.called).to.be.false
            })

            it('does not probe the external DB when no database is being reset', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs, { EXTERNAL_DB: true })
                const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
                expect(result).to.be.true
                expect(stubs.pingExternalDatabase.called).to.be.false
            })
        })

        it('stops and resets utxo-tracker when service=xchain-utxo-tracker', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.true
        })

        // A reset rebuilds a store on a NEW lineage, so every bootstrap
        // already published for that combo describes the old one and restoring
        // it puts a fresh install on a chain this box no longer agrees with.
        // Nothing forced a republish, and no age check caught it because the
        // wrong archive was hours old. The reset itself has to arm the marker.
        describe('marks the reindexed combos for a forced bootstrap republish', function () {

            it('marks the tracker combo when the tracker volume is wiped', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                expect(await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'testnet', true)).to.be.true

                expect(stubs.republishLedger.recordReindex.calledOnce).to.be.true
                const [modules, coin, network, opts] = stubs.republishLedger.recordReindex.firstCall.args
                expect(modules).to.deep.equal(['xchain-utxo-tracker'])
                expect(coin).to.equal('bitcoin')
                expect(network).to.equal('testnet')
                expect(opts.reason).to.include('reset xchain-utxo-tracker')
            })

            // A re-genesis is run as `reset all`, and that is where all three
            // derived archives really do go stale.
            it('marks all three on a reset all', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('all', 'bitcoin', 'testnet', true)
                await clock.tickAsync(6000)   // past the decoder/indexer bounce delay
                clock.restore()
                expect(await promise).to.be.true

                expect(stubs.republishLedger.recordReindex.calledOnce).to.be.true
                expect(stubs.republishLedger.recordReindex.firstCall.args[0])
                    .to.deep.equal(['xchain-utxo-tracker', 'xchain-decoder', 'xchain-indexer'])
            })

            // A node-only reset resyncs the same chain and leaves every derived
            // store untouched, so warning about three combos there would be
            // noise on an ordinary resync.
            it('marks nothing for a node-only reset', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                expect(await ops.resetModules('node', 'bitcoin', 'testnet', true)).to.be.true
                expect(stubs.republishLedger.recordReindex.called).to.be.false
            })

            // Nothing was wiped on an aborted reset, so the published archives
            // are still the right lineage: arming here would force a pointless
            // tracker republish (which costs downtime) on every refused reset.
            it('marks nothing when the reset aborts before any wipe', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                // The decoder/indexer pair is only coherent when both move
                // together, so a decoder-only reset with the indexer installed
                // is refused before anything is touched.
                const ops = loadOperations(stubs)
                expect(await ops.resetModules('xchain-decoder', 'bitcoin', 'testnet', true)).to.be.false
                expect(stubs.republishLedger.recordReindex.called).to.be.false
            })

            // The wipes already happened by the time this runs, so a ledger
            // failure must never abort the restart pass and leave the stack down.
            it('does not abort the reset when the ledger cannot be written', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.republishLedger.recordReindex.throws(new Error('read-only home'))
                const ops = loadOperations(stubs)
                expect(await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'testnet', true)).to.be.true
                expect(stubs.startContainer.called).to.be.true
            })
        })

        it('resets decoder: stops, resets DB, and bounces', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true, true)
            await clock.tickAsync(6000)
            clock.restore()
            const result = await promise
            expect(result).to.be.true
            expect(stubs.resetDatabases.calledOnce).to.be.true
            expect(stubs.restartContainer.called).to.be.true // bounce
        })

        // Wiping the indexer DB restarts its push_generations at 0, which the
        // hub's price ingest fence silently drops. The reset owns clearing the fence.
        // uuid:bb190060: the MariaDB probe used to run after the stop loop, so this
        // abort reported "No data was touched" while every service it had already
        // stopped stayed down (the restart pass sits past the early return).
        it('aborts a missing-MariaDB reset without stopping anything', async function () {
            const stubs = makeStubs()
            stubs.getDatabaseContainerId.resolves(null)
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
            expect(result).to.be.false
            expect(stubs.stopContainer.called).to.be.false
            expect(stubs.resetDatabases.called).to.be.false
            expect(stubs.startContainer.called).to.be.false
        })

        // uuid:9c88cfe6: the stop loop's bare catch swallowed a real docker stop
        // failure as "not installed", so the wipes below ran while a live daemon
        // still held the store. A real stop error must abort before any wipe and
        // put back whatever was already stopped.
        it('aborts before any wipe when a target fails to stop, and restarts what it stopped', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            // node stops, xchain-utxo-tracker refuses.
            stubs.stopContainer.onCall(1).rejects(
                new Error('Command failed: docker stop x\nError response from daemon: cannot stop container')
            )
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
            expect(result).to.be.false
            expect(stubs.resetDatabases.called).to.be.false
            expect(stubs.execFile.called).to.be.false          // no wipe ran
            expect(stubs.startContainer.calledOnce).to.be.true // node put back
        })

        it('still treats a "no such container" stop as a skip and completes the reset', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            stubs.stopContainer.rejects(
                new Error('Command failed: docker stop x\nError response from daemon: No such container: x')
            )
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
            expect(result).to.be.true
            expect(stubs.execFile.called).to.be.true // the volume wipe still ran
        })

        // stopContainer rejects a bare STRING when docker exits 0 without echoing
        // the id back, which is a real failure carrying no .message to match.
        it('aborts when stopContainer rejects a non-Error value', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            stubs.stopContainer.callsFake(() => Promise.reject('error trying to stop the docker container'))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
            expect(result).to.be.false
            expect(stubs.execFile.called).to.be.false
        })

        // uuid:846cc40d: the stop loop resolved each target through the swallowing
        // getModuleContainer, which answers null for a SQL error as well as for a
        // miss. A registry blip after the reachability precheck therefore made a
        // RUNNING indexer look uninstalled, the loop skipped stopping it, and
        // resetDatabases dropped its database underneath it while the command
        // reported success. A read that FAILED is not evidence of absence.
        describe('the registry read that decides what to stop', function () {

            // Every `docker run --rm -v <host>:/data` this reset issued.
            function wipeRuns(execFileStub) {
                return execFileStub.getCalls()
                    .filter(c => c.args[0] === 'docker' && Array.isArray(c.args[1]) && c.args[1][0] === 'run')
            }

            it('aborts before any wipe when a target row cannot be read', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.db.getModuleContainerStrict.callsFake(async (module) => {
                    if (module === 'xchain-utxo-tracker') throw new Error('ER_LOCK_WAIT_TIMEOUT')
                    return 'container-id-123'
                })
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                expect(wipeRuns(stubs.execFile)).to.be.empty
                const output = lines.join('\n')
                expect(output).to.include('cannot read the xchain-utxo-tracker registry row')
                expect(output).to.include('ER_LOCK_WAIT_TIMEOUT')
                expect(output).to.include('No data was touched.')
            })

            it('reports a module the rollback cannot resolve as still down', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                // node resolves and stops, the tracker read fails, and the
                // rollback's own read fails the same way.
                stubs.db.getModuleContainerStrict.onCall(0).resolves('container-id-123')
                stubs.db.getModuleContainerStrict.rejects(new Error('registry unreachable'))
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.startContainer.called).to.be.false
                expect(lines.join('\n')).to.include('STILL DOWN, start by hand: node')
            })

            // A successful read with no row is still an ordinary "not installed".
            it('still skips a module that is genuinely absent from the registry', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.db.getModuleContainerStrict.callsFake(async (module) =>
                    module === 'xchain-regtest-miner' ? null : 'container-id-123')
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('all', 'bitcoin', 'mainnet', true)
                await clock.tickAsync(6000)
                clock.restore()
                expect(await promise).to.be.true
                expect(stubs.resetDatabases.calledOnce).to.be.true
            })
        })

        // uuid:e24c98d4: the tracker volume wipe swallowed EVERY failure as
        // "the volume may not exist", so a permission error, an unreachable
        // daemon or a failed alpine pull left stale tracker data in place while
        // resetDatabases re-genesised the decoder and indexer around it, and the
        // run returned true.
        describe('the utxo-tracker volume wipe', function () {

            const VOLUME = 'xchain-utxo-tracker-bitcoin-mainnet-data'

            function volumeWipeRan(execFileStub) {
                return execFileStub.getCalls().some(c =>
                    c.args[1][0] === 'run' && c.args[1].join(' ').includes(VOLUME))
            }

            it('refuses the reset when the volume presence cannot be determined', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => {
                    if (args[0] === 'volume') {
                        return cb(new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'))
                    }
                    cb(null, '', '')
                })
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                expect(volumeWipeRan(stubs.execFile)).to.be.false
                const output = lines.join('\n')
                expect(output).to.include(`cannot determine whether the Docker volume ${VOLUME} exists`)
                expect(output).to.include('No data was touched.')
            })

            // Docker SAYING "no such volume" is the only thing that means absent.
            it('treats docker\'s own no-such-volume as absence and completes', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => {
                    if (args[0] === 'volume') return cb(new Error(`Error: No such volume: ${VOLUME}`))
                    cb(null, '', '')
                })
                const ops = loadOperations(stubs)
                const result = await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
                expect(result).to.be.true
                expect(volumeWipeRan(stubs.execFile)).to.be.false
            })

            it('aborts and restores the stack when the wipe fails with nothing else touched', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => {
                    if (args[0] === 'volume') return cb(null, '', '')
                    if (args.join(' ').includes(VOLUME)) return cb(new Error('permission denied'))
                    cb(null, '', '')
                })
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
                let result
                try {
                    result = await ops.resetModules('xchain-utxo-tracker', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                const output = lines.join('\n')
                expect(output).to.include(`clearing the Docker volume ${VOLUME} failed`)
                expect(output).to.include('permission denied')
                expect(output).to.include('No data was touched.')
            })

            // On `reset all` the node datadir is already gone by the time the
            // volume wipe runs, so the abort must not claim otherwise, must not
            // let the decoder/indexer databases go, and must not restart services
            // over a half-reset stack.
            it('refuses to drop the databases after a failed wipe on reset all', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => {
                    if (args[0] === 'volume') return cb(null, '', '')
                    if (args.join(' ').includes(VOLUME)) return cb(new Error('permission denied'))
                    cb(null, '', '')
                })
                const ops = loadOperations(stubs)
                const lines = []
                const logStub = sinon.stub(console, 'log').callsFake((...a) => lines.push(a.join(' ')))
                let result
                try {
                    result = await ops.resetModules('all', 'bitcoin', 'mainnet', true)
                } finally {
                    logStub.restore()
                }
                expect(result).to.be.false
                expect(stubs.resetDatabases.called).to.be.false
                expect(stubs.startContainer.called).to.be.false
                const output = lines.join('\n')
                expect(output).to.include('The node data for this stack WAS already cleared')
                expect(output).to.not.include('No data was touched.')
            })
        })

        it('clears the hub price ingest fence when the indexer DB is reset', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('xchain-indexer', 'bitcoin', 'mainnet', true)
            await clock.tickAsync(6000)
            clock.restore()
            expect(await promise).to.be.true
            expect(stubs.clearHubPriceIngestWatermark.calledOnceWith('bitcoin', 'mainnet')).to.be.true
            // After the wipe and before the indexer is started again, so the first
            // push after the restart is not the one that gets dropped.
            expect(stubs.resetDatabases.calledBefore(stubs.clearHubPriceIngestWatermark)).to.be.true
            expect(stubs.clearHubPriceIngestWatermark.calledBefore(stubs.startContainer)).to.be.true
        })

        // A decoder-only reset is reachable only where no indexer is installed to
        // strand; with one present the pair guard refuses. The fence belongs to the
        // indexer's push generations, so an untouched indexer keeps its fence.
        it('leaves the fence alone on a decoder-only reset (that chain keeps pushing prices)', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            stubs.db.getModuleContainer.callsFake(async (module) =>
                module === 'xchain-indexer' ? null : 'container-id-123')
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true)
            await clock.tickAsync(6000)
            clock.restore()
            expect(await promise).to.be.true
            expect(stubs.clearHubPriceIngestWatermark.called).to.be.false
        })

        // A regtest chain reset is a RE-GENESIS: the datadir goes and the chain
        // comes back from block 0. The hub's cross-chain rows are keyed by
        // `network` and a BTC-anchored snapshot_block and name no chain
        // INSTANCE, so without this purge the mirror hands every fresh indexer
        // the dead chain's finalized matches, which can never settle.
        describe('the regtest re-genesis hub purge', function () {

            it('purges the hub cross-chain rows on a regtest node reset', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                expect(await ops.resetModules('node', 'bitcoin', 'regtest', true)).to.be.true
                expect(stubs.purgeHubCrossChainRows.calledOnceWithExactly('bitcoin', 'regtest')).to.be.true
                // While the stack is still down, so the rebuilt mirror never sees them.
                expect(stubs.purgeHubCrossChainRows.calledBefore(stubs.startContainer)).to.be.true
            })

            it('purges after the price fence on reset all', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('all', 'bitcoin', 'regtest', true)
                await clock.tickAsync(6000)
                clock.restore()
                expect(await promise).to.be.true
                expect(stubs.purgeHubCrossChainRows.calledOnce).to.be.true
                expect(stubs.clearHubPriceIngestWatermark.calledBefore(stubs.purgeHubCrossChainRows)).to.be.true
                expect(stubs.purgeHubCrossChainRows.calledBefore(stubs.startContainer)).to.be.true
            })

            // An indexer-only reset is a REINDEX of a chain that is still there,
            // so its matches are still live and must not be purged.
            it('leaves the hub rows alone when the chain itself is not reset', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('xchain-indexer', 'bitcoin', 'regtest', true)
                await clock.tickAsync(6000)
                clock.restore()
                expect(await promise).to.be.true
                expect(stubs.purgeHubCrossChainRows.called).to.be.false
                // The fence still moves: that one belongs to the wiped indexer DB.
                expect(stubs.clearHubPriceIngestWatermark.called).to.be.true
            })

            it('never purges off regtest, where these rows are live federation history', async function () {
                for (const network of ['mainnet', 'testnet']) {
                    const stubs = makeStubs()
                    stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                    const ops = loadOperations(stubs)
                    expect(await ops.resetModules('node', 'bitcoin', network, true),
                        `expected the ${network} reset to succeed`).to.be.true
                    expect(stubs.purgeHubCrossChainRows.called,
                        `expected no purge on ${network}`).to.be.false
                }
            })

            // The wipe already happened by this point, so a hub that cannot be
            // reached must not leave the stack down.
            it('does not abort the restart pass when the purge throws', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.purgeHubCrossChainRows.rejects(new Error('hub DB unreachable'))
                const ops = loadOperations(stubs)
                const warned = []
                const warn = sinon.stub(console, 'warn').callsFake((...a) => warned.push(a.join(' ')))
                let result
                try { result = await ops.resetModules('node', 'bitcoin', 'regtest', true) }
                finally { warn.restore() }
                expect(result).to.be.true
                expect(stubs.startContainer.called).to.be.true
                const text = warned.join('\n')
                expect(text).to.contain('hub DB unreachable')
                expect(text).to.contain('DELETE FROM cross_chain_matches')
                expect(text).to.contain('xchain-node restart xchain-hub')
            })

            it('names the hub rows in the confirmation for a regtest node reset', async function () {
                const readline = require('readline')
                const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
                Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
                const createInterface = sinon.stub(readline, 'createInterface').returns({
                    question: (_q, cb) => cb('yes'),
                    close() {}
                })
                const warned = []
                const warn = sinon.stub(console, 'warn').callsFake((...a) => warned.push(a.join(' ')))
                try {
                    const stubs = makeStubs()
                    stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                    const ops = loadOperations(stubs)
                    expect(await ops.resetModules('node', 'bitcoin', 'regtest', false)).to.be.true

                    const mainnetStubs = makeStubs()
                    mainnetStubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                    const mainnetOps = loadOperations(mainnetStubs)
                    expect(await mainnetOps.resetModules('node', 'bitcoin', 'mainnet', false)).to.be.true
                } finally {
                    warn.restore()
                    createInterface.restore()
                    if (isTTYDescriptor) Object.defineProperty(process.stdin, 'isTTY', isTTYDescriptor)
                    else delete process.stdin.isTTY
                }
                const [regtestPrompt, mainnetPrompt] = warned
                    .filter(l => l.includes('Affected stores:'))
                expect(regtestPrompt).to.contain('hub cross-chain relic rows for this network')
                expect(regtestPrompt).to.contain('capability_snapshots')
                // Mainnet has no re-genesis path, so the line must not appear there.
                expect(mainnetPrompt).to.not.contain('hub cross-chain relic rows')
            })
        })

        // The indexer tracks reorgs by a decoder event id, and the decoder never
        // deletes those rows, so wiping the decoder alone restarts the ids under a
        // cursor pointing past them and the indexer aborts RE-1. The pair is only
        // coherent when both move together, so a one-sided reset is refused.
        describe('the coupled decoder/indexer pair', function () {

            it('refuses a decoder-only reset while an indexer is installed', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)

                const result = await ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true)

                expect(result).to.be.false
                // Refused BEFORE anything destructive, not partway through.
                expect(stubs.resetDatabases.called).to.be.false
                expect(stubs.stopContainer.called).to.be.false
            })

            it('names the joint form in the refusal, so the remedy is runnable', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const logged = []
                const log = sinon.stub(console, 'log').callsFake((...a) => logged.push(a.join(' ')))
                try {
                    const ops = loadOperations(stubs)
                    await ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true)
                } finally {
                    log.restore()
                }
                const text = logged.join('\n')
                expect(text).to.contain('--with-indexer')
                expect(text).to.contain('bitcoin mainnet')
                expect(text).to.contain('No data was touched')
            })

            it('resets both halves together when the joint form is used', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true, true)
                await clock.tickAsync(6000)
                clock.restore()

                expect(await promise).to.be.true
                const modules = stubs.resetDatabases.firstCall.args[2]
                expect(modules).to.have.members(['xchain-decoder', 'xchain-indexer'])
                // A wiped indexer restarts its push generations, so the hub fence has
                // to be cleared on this path or the chain's price rail dies silently.
                expect(stubs.clearHubPriceIngestWatermark.called).to.be.true
            })

            it('allows a decoder-only reset when no indexer is installed to strand', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                stubs.db.getModuleContainer.callsFake(async (module) =>
                    module === 'xchain-indexer' ? null : 'container-id-123')
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('xchain-decoder', 'bitcoin', 'mainnet', true)
                await clock.tickAsync(6000)
                clock.restore()

                expect(await promise).to.be.true
                expect(stubs.resetDatabases.firstCall.args[2]).to.deep.equal(['xchain-decoder'])
            })

            // Asymmetric by design: the indexer re-derives from an intact decoder,
            // which is an ordinary reindex and must stay available.
            it('still allows an indexer-only reset', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('xchain-indexer', 'bitcoin', 'mainnet', true)
                await clock.tickAsync(6000)
                clock.restore()

                expect(await promise).to.be.true
                expect(stubs.resetDatabases.firstCall.args[2]).to.deep.equal(['xchain-indexer'])
            })

            it('leaves `reset all` alone, which already moves both', async function () {
                const stubs = makeStubs()
                stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
                const ops = loadOperations(stubs)
                const clock = sinon.useFakeTimers()
                const promise = ops.resetModules('all', 'bitcoin', 'mainnet', true)
                await clock.tickAsync(6000)
                clock.restore()

                expect(await promise).to.be.true
                expect(stubs.resetDatabases.firstCall.args[2]).to.have.members(['xchain-decoder', 'xchain-indexer'])
            })
        })

        it('reports a fence-clear failure without aborting the restart pass', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            stubs.clearHubPriceIngestWatermark.rejects(new Error('hub DB unreachable'))
            const warn = sinon.stub(console, 'warn')
            const ops = loadOperations(stubs)
            const clock = sinon.useFakeTimers()
            const promise = ops.resetModules('xchain-indexer', 'bitcoin', 'mainnet', true)
            await clock.tickAsync(6000)
            clock.restore()
            const result = await promise
            const lines = warn.getCalls().map(c => String(c.args[0])).join('\n')
            warn.restore()
            // The wipe already happened: leaving the stack stopped would be worse than
            // an uncleared fence, so this is loud but not fatal.
            expect(result).to.be.true
            expect(stubs.startContainer.called).to.be.true
            expect(lines).to.contain('price_ingest_watermarks')
            expect(lines).to.contain("source_chain = 'BTC'")
        })

        it('resets node data when nodeDataPath exists', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(true) // nodeDataPath exists
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
            expect(result).to.be.true
            // execFile called for docker run --rm to clear data
            expect(stubs.execFile.called).to.be.true
            const call = stubs.execFile.firstCall
            expect(call.args[0]).to.equal('docker')
        })

        // Was 'continues when stopContainer throws', asserting result===true
        // "errors are caught/swallowed". That characterised the uuid:9c88cfe6
        // defect rather than a contract: continuing past a failed stop is what
        // let the wipes run under a live daemon. The contract is now abort.
        it('does not continue past a failed stopContainer', async function () {
            const stubs = makeStubs()
            stubs.stopContainer.rejects(new Error('stop failed'))
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
            expect(result).to.be.false
            expect(stubs.execFile.called).to.be.false
        })

        // #3144: reset must fail loud on bad args rather than reporting success
        // after resetting nothing (an unknown service leaves every flag false).
        it('throws on an unknown service instead of a silent no-op success', async function () {
            const ops = loadOperations(makeStubs())
            let threw = null
            try { await ops.resetModules('xchain-encoder', 'bitcoin', 'mainnet', true) }
            catch (e) { threw = e }
            expect(threw, 'expected a thrown error for an unknown service').to.be.an('error')
            expect(threw.message).to.match(/unknown service/)
        })

        it('throws on an unknown coin', async function () {
            const ops = loadOperations(makeStubs())
            let threw = null
            try { await ops.resetModules('all', 'notacoin', 'mainnet', true) }
            catch (e) { threw = e }
            expect(threw, 'expected a thrown error for an unknown coin').to.be.an('error')
            expect(threw.message).to.match(/unknown coin/)
        })

        it('throws on an unknown network', async function () {
            const ops = loadOperations(makeStubs())
            let threw = null
            try { await ops.resetModules('all', 'bitcoin', 'stagenet', true) }
            catch (e) { threw = e }
            expect(threw, 'expected a thrown error for an unknown network').to.be.an('error')
            expect(threw.message).to.match(/unknown network/)
        })
    })

    // -------------------------------------------------------------------
    // resetModules(): destructive-reset confirmation guard
    // -------------------------------------------------------------------

    describe('resetModules(): confirmation guard', function () {

        it('force=true skips the confirmation prompt entirely', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
            try {
                const result = await ops.resetModules('node', 'bitcoin', 'mainnet', true)
                expect(result).to.be.true
                expect(stubs.stopContainer.called).to.be.true
            } finally {
                if (isTTYDescriptor) Object.defineProperty(process.stdin, 'isTTY', isTTYDescriptor)
                else delete process.stdin.isTTY
            }
        })

        it('refuses to reset on a non-interactive terminal without --yes/force', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, cb) => cb(null, '', ''))
            const ops = loadOperations(stubs)
            const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
            Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
            try {
                let thrown = null
                try {
                    await ops.resetModules('node', 'bitcoin', 'mainnet', false)
                } catch (err) {
                    thrown = err
                }
                expect(thrown).to.not.be.null
                expect(thrown.message).to.match(/--yes/)
                expect(stubs.stopContainer.called).to.be.false
                expect(stubs.execFile.called).to.be.false
            } finally {
                if (isTTYDescriptor) Object.defineProperty(process.stdin, 'isTTY', isTTYDescriptor)
                else delete process.stdin.isTTY
            }
        })
    })

    // -------------------------------------------------------------------
    // logModules: no containers case
    // -------------------------------------------------------------------

    describe('logModules(): no containers', function () {

        it('prints "No service was selected" when no containers found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null) // no containers
            const ops = loadOperations(stubs)
            const result = await ops.logModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.logContainer.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // restartModules: error path
    // -------------------------------------------------------------------

    describe('restartModules(): error path', function () {

        it('continues after restartContainer error', async function () {
            const stubs = makeStubs()
            stubs.restartContainer.rejects(new Error('restart failed'))
            const ops = loadOperations(stubs)
            const result = await ops.restartModules({ bitcoin: { mainnet: ['xchain-encoder', 'xchain-decoder'] } })
            expect(result).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // stopModules/startModules: skip when no container
    // -------------------------------------------------------------------

    describe('stopModules(): skip when no container', function () {

        it('skips when container ID is not found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
            expect(stubs.stopContainer.called).to.be.false
        })

        it('continues after stopContainer error', async function () {
            const stubs = makeStubs()
            stubs.stopContainer.rejects(new Error('stop failed'))
            const ops = loadOperations(stubs)
            const result = await ops.stopModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })
    })

    describe('startModules(): error path', function () {

        it('continues after startContainer error', async function () {
            const stubs = makeStubs()
            stubs.startContainer.rejects(new Error('start failed'))
            const ops = loadOperations(stubs)
            const result = await ops.startModules({ bitcoin: { mainnet: ['xchain-encoder'] } })
            expect(result).to.be.true
        })
    })

    describe('execModules(): error path', function () {

        it('continues after execContainer error', async function () {
            const stubs = makeStubs()
            stubs.execContainer.rejects(new Error('exec failed'))
            const ops = loadOperations(stubs)
            const result = await ops.execModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'ls')
            expect(result).to.be.true
        })

        it('skips when container ID is null', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            const ops = loadOperations(stubs)
            const result = await ops.execModules({ bitcoin: { mainnet: ['xchain-encoder'] } }, 'ls')
            expect(result).to.be.true
            expect(stubs.execContainer.called).to.be.false
        })
    })
})

// A coin installed by THIS run is unknown to the hub and explorer until something
// tells them, and the thing that does (preCheck) fires BEFORE the action. Left
// unsynced, the explorer sits on no network from which the hub is reachable,
// populates no DB pool, and answers 503 to everything: measured on a clean host it
// stayed degraded through a full 150-second readiness wait, which is what ruled out
// the poll-interval race this was first mistaken for.
//
// It lives beside installModules rather than inside it because it reconciles
// against LIVE docker, and installModules is driven directly by suites whose
// container registry is fixture data that such a reconcile purges.
describe('moduleOperations: syncSharedServicesAfterInstall()', function () {

    const coinInstalled = { installed: [{ module: 'xchain-indexer', coin: 'bitcoin', network: 'regtest' }], skipped: [] }
    const sharedOnly    = { installed: [{ module: 'xchain-explorer', coin: '', network: '' }], skipped: [] }

    it('pushes hub config, attaches the explorer, then waits for it to serve', async function () {
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        await ops.syncSharedServicesAfterInstall(coinInstalled)
        expect(stubs.updateHub.calledOnce).to.be.true
        expect(stubs.updateExplorer.calledOnce).to.be.true
        expect(stubs.updateExplorer.calledBefore(stubs.waitForExplorerReady)).to.be.true
    })

    it('does nothing when the run installed no coin stack', async function () {
        // A shared-only install has no new network to join and nothing to serve.
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        await ops.syncSharedServicesAfterInstall(sharedOnly)
        expect(stubs.updateHub.called).to.be.false
        expect(stubs.waitForExplorerReady.called).to.be.false
    })

    it('tolerates a missing outcome rather than throwing at the end of an install', async function () {
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        await ops.syncSharedServicesAfterInstall(undefined)
        expect(stubs.updateHub.called).to.be.false
    })

    it('still waits when the hub push fails, and never fails the command', async function () {
        const stubs = makeStubs()
        stubs.updateHub = sinon.stub().rejects(new Error('hub unreachable'))
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')
        try {
            await ops.syncSharedServicesAfterInstall(coinInstalled)
        } finally {
            warn.restore()
        }
        expect(stubs.waitForExplorerReady.calledOnce).to.be.true
    })

    it('warns, without throwing, when the explorer never converges', async function () {
        const stubs = makeStubs()
        stubs.waitForExplorerReady = sinon.stub().resolves(false)
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')
        try {
            await ops.syncSharedServicesAfterInstall(coinInstalled)
        } finally {
            warn.restore()
        }
        expect(warn.args.some(a => /not serving coin data/.test(String(a[0])))).to.be.true
    })

    it('reports the stack usable when the explorer converges', async function () {
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        expect(await ops.syncSharedServicesAfterInstall(coinInstalled)).to.be.true
    })

    it('reports the stack UNUSABLE when the explorer never converges', async function () {
        // The caller exits non-zero on this, so a gate stops at the boot step
        // instead of at its first read of a 503 explorer.
        const stubs = makeStubs()
        stubs.waitForExplorerReady = sinon.stub().resolves(false)
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')
        try {
            expect(await ops.syncSharedServicesAfterInstall(coinInstalled)).to.be.false
        } finally {
            warn.restore()
        }
    })

    it('honours XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER for install-then-fix flows', async function () {
        const stubs = makeStubs()
        stubs.waitForExplorerReady = sinon.stub().resolves(false)
        const ops = loadOperations(stubs)
        const warn = sinon.stub(console, 'warn')
        const prior = process.env.XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER
        process.env.XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER = '1'
        try {
            expect(await ops.syncSharedServicesAfterInstall(coinInstalled)).to.be.true
        } finally {
            warn.restore()
            if (prior === undefined) delete process.env.XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER
            else process.env.XCHAIN_NODE_ALLOW_DEGRADED_EXPLORER = prior
        }
    })

    it('reports usable when the run installed no coin stack', async function () {
        const stubs = makeStubs()
        const ops = loadOperations(stubs)
        expect(await ops.syncSharedServicesAfterInstall(sharedOnly)).to.be.true
    })
})

// The e2e image stages its siblings from LIBRARY_BUNDLES, and the suites reach
// them at ../../../xchain-<name>. A sibling that is required but not staged does
// not redden: the suite that needs it SKIPS, which is indistinguishable from
// green in the tally. consensusHashConformance is the one that matters most,
// being the only place sync's BlockHasher meets the indexer's committed hashes
// over real stack data, and it skipped silently until sync was added here.
describe('constants: the e2e image stages every sibling its suites require', function () {

    const { LIBRARY_BUNDLES } = require('../../src/config/constants')

    it('bundles sync, so the consensus hash drift-lock can run instead of skipping', function () {
        expect(LIBRARY_BUNDLES['xchain-e2e-test']).to.include('xchain-sync')
    })

    it('keeps the siblings the other suites resolve directly', function () {
        for (const lib of ['xchain-hub', 'xchain-sdk', 'xchain-contracts', 'xchain-indexer']) {
            expect(LIBRARY_BUNDLES['xchain-e2e-test']).to.include(lib)
        }
    })
})
