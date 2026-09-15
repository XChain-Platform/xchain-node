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

const {
    sinon, configStub, expect, proxyquire, modulesUrls, XChainService,
    DEFAULT_NODE_PREFIX, DEPENDENCY_HEALTH_START_PERIOD, makeStubs,
    loadModuleService, stubDockerCreate, runArgsOf, inspectMemoryBytes,
    captureConsole, proxyquireCallThru, moduleSuite
} = require('./support/helpers')

function loadWithExistingCheckout(execFileFake) {
            const fsStub = {
                existsSync: sinon.stub().returns(true),
                rmSync: sinon.stub(),
                mkdirSync: sinon.stub(),
                renameSync: sinon.stub()
            }
            const execFileStub = sinon.stub().callsFake(execFileFake)
            const removeModuleDir = sinon.stub()
            const ms = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: execFileStub },
                'fs': fsStub,
                '../state': { db: { setModuleContainer: sinon.stub().resolves(true) }, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(true),
                    checkIfModuleExists: sinon.stub().returns(true),
                    removeModuleDir,
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub(),
                    getDockerNetwork: sinon.stub(),
                    validatePort: () => true,
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './status_service': { statusChanged: sinon.stub().resolves(), getStatus: sinon.stub().resolves({}) },
                './docker_service': { killContainer: sinon.stub().resolves(), removeContainer: sinon.stub().resolves(), forceRemoveContainerByName: sinon.stub().resolves(), getPublishedHostPorts: sinon.stub().resolves(new Map()) },
                './database_service': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() }
            })
            return { ms, fs: fsStub, execFile: execFileStub, removeModuleDir }
        }

const MODULE = 'xchain-encoder'
const DEST   = '/modules/' + MODULE

// Loads ModuleService with a real-ish fs surface (spies) and an
// existing module checkout, where replacement must protect the live
// directory.
function callbackOf(rest) {
    return typeof rest[0] === 'function' ? rest[0] : rest[1]
}

moduleSuite('cloneGit() rewrite over an existing checkout', function () {
        it('clones into a staging dir, never over the live checkout', async function () {
            let destArg = null
            const { ms, fs } = loadWithExistingCheckout((cmd, args, ...rest) => {
                // The clone's destination, not the last git call's last argument: the
                // source-identity reads that follow a clone are git calls too.
                if (args[0] === 'clone') destArg = args[args.length - 1]
                callbackOf(rest)(null)
            })
            await ms.cloneGit(MODULE, true)
            expect(destArg).to.not.equal(DEST)
            expect(destArg).to.have.string(DEST)
            // Swap order: live checkout aside first, staged clone in second.
            expect(fs.renameSync.callCount).to.equal(2)
            expect(fs.renameSync.firstCall.args[0]).to.equal(DEST)
            expect(fs.renameSync.secondCall.args[0]).to.equal(destArg)
            expect(fs.renameSync.secondCall.args[1]).to.equal(DEST)
        })

        it('leaves the checkout in place when the branch is missing from the remote', async function () {
            // A requested branch may exist only in the deploy checkout. A remote
            // miss must leave that whole module directory intact.
            const { ms, fs, removeModuleDir } = loadWithExistingCheckout((cmd, args, ...rest) => {
                callbackOf(rest)(new Error('Remote branch not found'), '', 'Remote branch xc952-mainnet-hotfix not found in upstream origin')
            })
            let threw = null
            try {
                await ms.cloneGit(MODULE, true, false, 'xc952-mainnet-hotfix')
            } catch (err) { threw = err }
            expect(threw).to.include('not found')
            expect(removeModuleDir.called).to.be.false
            expect(fs.renameSync.called).to.be.false
            // Only the staging dir is cleaned up, never the destination itself.
            for (const call of fs.rmSync.getCalls()) {
                expect(call.args[0]).to.not.equal(DEST)
            }
        })

        it('points a missing branch at the real mechanism (remote clone / local-path override)', async function () {
            const { ms } = loadWithExistingCheckout((cmd, args, ...rest) => {
                callbackOf(rest)(new Error('not found'), '', 'Remote branch not found in upstream origin')
            })
            let threw = null
            try {
                await ms.cloneGit(MODULE, true, false, 'local-only')
            } catch (err) { threw = err }
            expect(threw).to.include('XCHAIN_NODE_MODULES_URLS_OVERRIDE')
            expect(threw).to.include("remote")
        })

        })

moduleSuite('cloneGit() rewrite over an existing checkout', function () {
        it('leaves the checkout in place when the clone fails for any other reason', async function () {
            const { ms, fs, removeModuleDir } = loadWithExistingCheckout((cmd, args, ...rest) => {
                callbackOf(rest)(new Error('fatal: could not read from remote repository'))
            })
            let threw = null
            try {
                await ms.cloneGit(MODULE, true)
            } catch (err) { threw = err }
            expect(threw).to.include('Error cloning')
            expect(removeModuleDir.called).to.be.false
            expect(fs.renameSync.called).to.be.false
        })

        it('restores the original checkout when the swap-in rename fails', async function () {
            const { ms, fs } = loadWithExistingCheckout((cmd, args, ...rest) => {
                callbackOf(rest)(null)
            })
            fs.renameSync.onSecondCall().throws(new Error('EPERM: operation not permitted'))
            let threw = null
            try {
                await ms.cloneGit(MODULE, true)
            } catch (err) { threw = err }
            expect(threw).to.include('Error replacing module checkout')
            // Third rename is the restore of the set-aside original.
            expect(fs.renameSync.callCount).to.equal(3)
            expect(fs.renameSync.thirdCall.args[1]).to.equal(DEST)
        })

        it('rejects an invalid branch name before touching the filesystem', async function () {
            const { ms, fs, execFile, removeModuleDir } = loadWithExistingCheckout(() => {})
            let threw = null
            try {
                await ms.cloneGit(MODULE, true, false, 'bad branch!')
            } catch (err) { threw = err }
            expect(threw).to.include('Invalid branch name')
            expect(execFile.called).to.be.false
            expect(removeModuleDir.called).to.be.false
            expect(fs.rmSync.called).to.be.false
            expect(fs.renameSync.called).to.be.false
        })

        it('rejects an unknown module before touching the filesystem', async function () {
            const { ms, fs, removeModuleDir } = loadWithExistingCheckout(() => {})
            let threw = null
            try {
                await ms.cloneGit('not-a-module', true)
            } catch (err) { threw = err }
            expect(threw).to.include("doesn't have an url")
            expect(removeModuleDir.called).to.be.false
            expect(fs.rmSync.called).to.be.false
            expect(fs.renameSync.called).to.be.false
        })
    })

    // buildAndUp: hub consensus-env drift guard wiring. The guard itself
    // (drift detection, warn/refuse text) is pure-function tested in
    // HubConsensusEnvGuard.test.js; this only proves buildAndUp actually calls it
    // for the hub, passes it the generated env, propagates a refusal, and does
    // NOT call it for an unrelated module.
moduleSuite('buildAndUp(): hub consensus-env drift guard wiring', function () {

        it('calls assertNoHubConsensusEnvDrift with the generated hub env', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null)
                else if (args[0] === 'run') cb(null, 'a'.repeat(64) + '\n')
                else cb(null)
            })
            const assertNoHubConsensusEnvDrift = sinon.stub().resolves([])
            const ms = loadModuleService(stubs, null, {
                './hub_consensus_env_guard': { assertNoHubConsensusEnvDrift }
            })

            await ms.buildAndUp('xchain-hub', null, null)

            expect(assertNoHubConsensusEnvDrift.calledOnce).to.equal(true)
            expect(assertNoHubConsensusEnvDrift.firstCall.args[0]).to.deep.equal({
                'NETWORK': 'bitcoin-mainnet', 'NODE_URL': 'node', 'NODE_PORT': 8332,
                'DECODER_PORT': 3002, 'DECODER_API_PORT': 3002,
                'DECODER_BOOTSTRAP_VOLUME': '/data/bitcoin/mainnet/xchain-decoder/bootstrap/',
                'ENCODER_PORT': 3003, 'ENCODER_API_PORT': 3003,
                'UTXO_TRACKER_PORT': 3001, 'UTXO_TRACKER_API_PORT': 3001,
                'UTXO_TRACKER_BOOTSTRAP_VOLUME': '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/',
                'INDEXER_PORT': 3004, 'INDEXER_API_PORT': 3004,
                'REGTEST_MINER_PORT': 3005, 'REGTEST_MINER_API_PORT': 3005,
                'HUB_PORT': 10000, 'EXPLORER_PORT_HTTP': 18080, 'EXPLORER_API_PORT_HTTP': 8080,
                'EXPLORER_PORT_HTTPS': 18081, 'EXPLORER_API_PORT_HTTPS': 8081,
                'SYNC_PORT': 3006, 'SYNC_API_PORT': 3006
            })
        })

        it('propagates a refusal from the guard instead of building the hub', async function () {
            const stubs = makeStubs()
            const refusal = new Error('hub consensus env drift')
            refusal.code = 'HUB_CONSENSUS_ENV_DRIFT'
            const assertNoHubConsensusEnvDrift = sinon.stub().rejects(refusal)
            const ms = loadModuleService(stubs, null, {
                './hub_consensus_env_guard': { assertNoHubConsensusEnvDrift }
            })

            let thrown = null
            try {
                await ms.buildAndUp('xchain-hub', null, null)
            } catch (err) { thrown = err }

            expect(thrown).to.equal(refusal)
            // The refusal fires before any build/create work runs.
            expect(stubs.execFile.called).to.equal(false)
        })

        })

moduleSuite('buildAndUp(): hub consensus-env drift guard wiring', function () {it('does not call the hub guard for an unrelated module', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null)
                else if (args[0] === 'run') cb(null, 'a'.repeat(64) + '\n')
                else cb(null)
            })
            const assertNoHubConsensusEnvDrift = sinon.stub().resolves([])
            const ms = loadModuleService(stubs, null, {
                './hub_consensus_env_guard': { assertNoHubConsensusEnvDrift }
            })

            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')

            expect(assertNoHubConsensusEnvDrift.called).to.equal(false)
        })

        it('does not reach the real guard from a default harness load (venue independence)', async function () {
            // Regression guard for the CI failure this row closed: a hub buildAndUp
            // test that did not stub HubConsensusEnvGuard ran the real one, which
            // inspects the HOST's hub container. It passed on a laptop with no hub
            // and failed on the venue that had one. The file-level before() hook
            // makes the real guard throw, so this passes only while loadModuleService
            // supplies the stub by default.
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null)
                else if (args[0] === 'run') cb(null, 'a'.repeat(64) + '\n')
                else cb(null)
            })
            const ms = loadModuleService(stubs)

            await ms.buildAndUp('xchain-hub', null, null)

            // The real guard would have thrown; reaching here means the stub answered.
            expect(stubs.execFile.called).to.equal(true)
        })
    })

    // -----------------------------------------------------------------------
    // Log retention and observability environment
    // -----------------------------------------------------------------------
moduleSuite('resolveObservabilityEnv()', function () {
        const ms = require('../../../src/services/module_service')

        it('names exactly the four shim controls', function () {
            expect(ms.OBSERVABILITY_ENV_KEYS).to.deep.equal(
                ['LOG_LEVEL', 'LOG_FORMAT', 'METRICS_ENABLED', 'XCHAIN_LOG_PATCH'])
        })

        it('carries a deploy-host value into the container env', function () {
            const overlay = ms.resolveObservabilityEnv({}, { LOG_LEVEL: 'debug', LOG_FORMAT: 'json' })
            expect(overlay).to.deep.equal({ LOG_LEVEL: 'debug', LOG_FORMAT: 'json' })
        })

        it('leaves a per-install config-store value alone', function () {
            // The narrower source wins: an operator who pinned LOG_LEVEL for one
            // coin must not have it overwritten by whatever the deploy shell holds.
            const overlay = ms.resolveObservabilityEnv({ LOG_LEVEL: 'warn' }, { LOG_LEVEL: 'debug' })
            expect(overlay).to.not.have.property('LOG_LEVEL')
        })

        it('fabricates nothing when neither source sets a name', function () {
            expect(ms.resolveObservabilityEnv({ NETWORK: 'bitcoin-mainnet' }, {})).to.deep.equal({})
        })

        it('treats an empty host value as unset', function () {
            expect(ms.resolveObservabilityEnv({}, { LOG_LEVEL: '' })).to.deep.equal({})
        })

        it('never carries a name that is not one of the four', function () {
            const overlay = ms.resolveObservabilityEnv({}, { HUB_DB_PASS: 'x', LOG_LEVEL: 'debug' })
            expect(Object.keys(overlay)).to.deep.equal(['LOG_LEVEL'])
        })
    })

moduleSuite('buildAndUp(): log retention and observability env', function () {
        it('caps json-file logs at 50m x 4 so 48 h of history survives', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null)
                else if (args[0] === 'run') { runArgs = args; cb(null, 'a'.repeat(64) + '\n') }
                else cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(runArgs).to.include('max-size=50m')
            expect(runArgs).to.include('max-file=4')
            expect(runArgs).to.not.include('max-size=10m')
            expect(runArgs).to.not.include('max-file=3')
        })

        it('forwards a host-set LOG_LEVEL as a bare --env name, value out of argv', async function () {
            const stubs = makeStubs()
            let runArgs = null
            let runOpts = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; runOpts = opts; cb(null, 'a'.repeat(64) + '\n') }
                else { cb(null) }
            })
            const previous = process.env.LOG_LEVEL
            process.env.LOG_LEVEL = 'debug'
            try {
                const ms = loadModuleService(stubs)
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            } finally {
                if (previous === undefined) delete process.env.LOG_LEVEL
                else process.env.LOG_LEVEL = previous
            }
            expect(runArgs).to.include('LOG_LEVEL')
            expect(runArgs).to.not.include('LOG_LEVEL=debug')
            expect(runOpts.env.LOG_LEVEL).to.equal('debug')
        })

        })

moduleSuite('buildAndUp(): log retention and observability env', function () {it('adds no observability name when the deploy host sets none', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null)
                else if (args[0] === 'run') { runArgs = args; cb(null, 'a'.repeat(64) + '\n') }
                else cb(null)
            })
            const saved = {}
            for (const k of ['LOG_LEVEL', 'LOG_FORMAT', 'METRICS_ENABLED', 'XCHAIN_LOG_PATCH']) {
                saved[k] = process.env[k]
                delete process.env[k]
            }
            try {
                const ms = loadModuleService(stubs)
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            } finally {
                for (const k of Object.keys(saved)) {
                    if (saved[k] !== undefined) process.env[k] = saved[k]
                }
            }
            expect(runArgs).to.not.include('LOG_LEVEL')
            expect(runArgs).to.not.include('LOG_FORMAT')
            expect(runArgs).to.not.include('METRICS_ENABLED')
            expect(runArgs).to.not.include('XCHAIN_LOG_PATCH')
        })
    })
