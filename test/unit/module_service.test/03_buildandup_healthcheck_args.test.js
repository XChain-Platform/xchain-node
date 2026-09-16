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

function captureRunArgs(stubs) {
            let runArgs = null
            // Handle git clone (for modules with LIBRARY_BUNDLES like xchain-indexer)
            // by responding immediately, and handle docker build/run normally.
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (cmd === 'git') { cb(null) }
                else if (args[0] === 'build') { cb(null) }
                else if (args[0] === 'run') { runArgs = args; cb(null, 'e'.repeat(64) + '\n') }
            })
            // Also stub fs.cpSync and fs.rmSync (used by bundled-library staging)
            stubs.fs.cpSync = sinon.stub()
            stubs.fs.rmSync = sinon.stub()
            return () => runArgs
        }

moduleSuite('buildAndUp() healthcheck args', function () {

        it('normalizes a bare-seconds start-period override to a docker duration', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const saved = process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
            process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = '900'
            try {
                const args = ms.buildHealthcheckArgs('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3003' })
                const i = args.indexOf('--health-start-period')
                expect(args[i + 1]).to.equal('900s')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
                else process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = saved
            }
        })

        it('emits a docker-parsable duration for every start-period it returns', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const saved = process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
            try {
                for (const raw of ['900', '900s', '2m', '1h', '1500ms', 'not-a-duration', '']) {
                    if (raw === '') delete process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
                    else process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = raw
                    const args = ms.buildHealthcheckArgs('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3003' })
                    const i = args.indexOf('--health-start-period')
                    expect(args[i + 1], 'override ' + JSON.stringify(raw)).to.match(/^\d+(ms|s|m|h)$/)
                }
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
                else process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = saved
            }
        })

        it('ignores a malformed start-period override and keeps the descriptor default', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const saved = process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
            process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = 'not-a-duration'
            try {
                const args = ms.buildHealthcheckArgs('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3003' })
                const i = args.indexOf('--health-start-period')
                expect(args[i + 1]).to.equal('60s')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
                else process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = saved
            }
        })
    })

moduleSuite('buildAndUp() healthcheck args', function () {

        it('returns [] with no warning for a module that has no healthcheck descriptor', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const logSpy = sinon.spy(console, 'log')
            try {
                const args = ms.buildHealthcheckArgs('xchain-e2e-test', { WHATEVER: '1' })
                expect(args).to.deep.equal([])
                const warned = logSpy.getCalls().map(c => c.args.join(' ')).join('\n')
                expect(warned).to.not.match(/WARNING: no healthcheck/)
            } finally {
                logSpy.restore()
            }
        })

        it('includes --health-interval, --health-timeout, --health-retries, --health-start-period for encoder', async function () {
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            const args = getRunArgs()
            expect(args).to.include('--health-interval')
            expect(args).to.include('--health-timeout')
            expect(args).to.include('--health-retries')
            expect(args).to.include('--health-start-period')
        })

        it('omits healthcheck args for onlyExecution containers', async function () {
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, true)
            const args = getRunArgs()
            expect(args).to.not.include('--health-cmd')
        })
    })

        // A probe that judges a hard dependency's startup must be granted a window at
        // least as long as the step it judges. These three each judge another
        // container: the encoder's GET /status 503s until the utxo-tracker is synced,
        // and the hub's `health` and the explorer's `ping` race a SELECT 1 against
        // MariaDB. Pins that they cannot drift back one service at a time.

moduleSuite('buildAndUp() healthcheck args', function () { describe('dependency-derived healthcheck start periods', function () {
            // '60s' / '900' / '2m' / '1500ms' all reach docker; compare in seconds.
            function startPeriodSeconds(args) {
                const i = args.indexOf('--health-start-period')
                expect(i, 'no --health-start-period in the emitted args').to.be.greaterThan(-1)
                const raw = String(args[i + 1])
                const m = /^(\d+)(ms|s|m|h)?$/.exec(raw)
                expect(m, 'unparsable start period ' + JSON.stringify(raw)).to.not.equal(null)
                const n = parseInt(m[1], 10)
                const unit = m[2] || 's'
                return unit === 'ms' ? n / 1000 : unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n
            }

            // Env overrides are per service and would mask the descriptor defaults
            // these cases are about, so clear the four in play and restore after.
            const overrideKeys = [
                'XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_ENCODER',
                'XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER',
                'XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_HUB',
                'XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_EXPLORER'
            ]
            let savedOverrides = {}
            beforeEach(function () {
                savedOverrides = {}
                for (const key of overrideKeys) {
                    savedOverrides[key] = process.env[key]
                    delete process.env[key]
                }
            })
            afterEach(function () {
                for (const key of overrideKeys) {
                    if (savedOverrides[key] === undefined) delete process.env[key]
                    else process.env[key] = savedOverrides[key]
                }
            })

            it('grants the encoder a window at least as long as the utxo-tracker it probes', function () {
                const ms = loadModuleService(makeStubs())
                const encoder = ms.buildHealthcheckArgs('xchain-encoder', { ENCODER_API_PORT: '3003' })
                const tracker = ms.buildHealthcheckArgs('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3001' })
                expect(startPeriodSeconds(encoder),
                    'the encoder probes GET /status, which 503s until the tracker is synced'
                ).to.be.at.least(startPeriodSeconds(tracker))
            })

            it('grants the hub and the explorer at least the DB start period their probes SELECT 1 against', function () {
                const ms = loadModuleService(makeStubs())
                const dbSeconds = startPeriodSeconds(['--health-start-period', DEPENDENCY_HEALTH_START_PERIOD])
                const hub = ms.buildHealthcheckArgs('xchain-hub', { HUB_PORT: '10000' })
                const explorer = ms.buildHealthcheckArgs('xchain-explorer', { EXPLORER_API_PORT_HTTP: '80' })
                expect(startPeriodSeconds(hub), 'hub `health` 503s while MariaDB is still initializing')
                    .to.be.at.least(dbSeconds)
                expect(startPeriodSeconds(explorer), 'explorer `ping` 503s while MariaDB is still initializing')
                    .to.be.at.least(dbSeconds)
            })
        }) })

    // -------------------------------------------------------------------
    // installModule: singleton guard
    // -------------------------------------------------------------------
moduleSuite('installModule() singleton guard', function () {

        it('skips re-creating a singleton module whose container already exists', async function () {
            // A singleton (hub/sync) has one coin/network-independent container
            // name. Installing it across multiple networks must not re-run
            // `docker run` with a duplicate name. The guard must
            // detect the existing named container and return without rebuilding.
            const stubs = makeStubs()
            const VALID_ID = 'b'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                // `docker inspect <name>` → report the singleton already exists
                if (cmd === 'docker' && args[0] === 'inspect') return cb(null, { stdout: VALID_ID + '\n' })
                cb(null, { stdout: '' })
            })
            const ms = loadModuleService(stubs)
            const result = await ms.installModule('xchain-hub', null, null)
            expect(result).to.be.false
            // Must short-circuit before the build path; no git clone attempted.
            const clonedViaGit = stubs.execFile.getCalls().some(c => c.args[0] === 'git')
            expect(clonedViaGit).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // uninstallModule
    // -------------------------------------------------------------------
moduleSuite('uninstallModule()', function () {

        it('throws when trying to uninstall database', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({})
            const ms = loadModuleService(stubs)
            try {
                await ms.uninstallModule('bitcoin', 'mainnet', 'database')
                expect.fail()
            } catch (err) {
                expect(err).to.include('manually removed')
            }
        })

        it('stops a running container with its budget, never docker kill, before removing', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({
                'bitcoin': {
                    'mainnet': {
                        'xchain-encoder': {
                            container_id: 'enc-123',
                            status: { State: { Status: 'running' } }
                        }
                    }
                }
            })
            const ms = loadModuleService(stubs)
            await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
            expect(stubs.stopContainerByName.calledWith('enc-123', 30)).to.be.true
            expect(stubs.killContainer.called).to.be.false
            expect(stubs.removeContainer.calledWith('enc-123')).to.be.true
        })

        it('skips kill for exited containers', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({
                'bitcoin': {
                    'mainnet': {
                        'xchain-encoder': {
                            container_id: 'enc-123',
                            status: { State: { Status: 'exited' } }
                        }
                    }
                }
            })
            const ms = loadModuleService(stubs)
            await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
            expect(stubs.stopContainerByName.called).to.be.false
            expect(stubs.removeContainer.calledWith('enc-123')).to.be.true
        })

        })

moduleSuite('uninstallModule()', function () {it('returns true when module is not found (already uninstalled)', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({})
            const ms = loadModuleService(stubs)
            const result = await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
            expect(result).to.be.true
        })

        it('removes stale tracking row when no container in status but row exists in DB', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({})
            stubs.db.getModuleContainer.resolves('stale-cid')
            const ms = loadModuleService(stubs)
            const result = await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
            expect(stubs.db.deleteModuleContainer.calledOnce).to.be.true
            expect(stubs.statusChanged.calledOnce).to.be.true
            expect(result).to.be.true
        })

        it('throws when container kill/remove fails (catch rethrows)', async function () {
            const stubs = makeStubs()
            stubs.getStatus.resolves({
                bitcoin: {
                    mainnet: {
                        'xchain-encoder': {
                            container_id: 'enc-456',
                            status: { State: { Status: 'running' } }
                        }
                    }
                }
            })
            stubs.removeContainer.rejects(new Error('kill failed'))
            const ms = loadModuleService(stubs)
            try {
                await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
                expect.fail()
            } catch (err) {
                // The catch rethrows the original error instead of masking
                // every failure in the block with a fixed "kill" message.
                expect(err.message).to.include('kill failed')
            }
        })
    })

    // -------------------------------------------------------------------
    // cloneGit: branch coverage
    // -------------------------------------------------------------------
moduleSuite('cloneGit() branch handling', function () {

        it('rejects on invalid branch name', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'bad branch!')
                expect.fail()
            } catch (err) {
                expect(err).to.include('Invalid branch name')
            }
        })

        it('clones with -b flag when a valid branch is specified', async function () {
            const stubs = makeStubs()
            let cloneArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                // Only the clone call; the identity reads that follow it are also git.
                if (args[0] === 'clone') cloneArgs = args
                cb(null)
            })
            const ms = loadModuleService(stubs)
            await ms.cloneGit('xchain-encoder', false, false, 'feature/test')
            expect(cloneArgs).to.include('-b')
            expect(cloneArgs).to.include('feature/test')
        })

        it('rejects (no silent fallback) when the requested branch is not found', async function () {
            // uuid:4f649bd0: a typo'd or deleted branch must fail the install
            // rather than silently building the default branch's code.
            const stubs = makeStubs()
            let callCount = 0
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                callCount++
                cb(new Error('git error'), '', 'remote: branch not found on server')
            })
            const ms = loadModuleService(stubs)
            try {
                await ms.cloneGit('xchain-encoder', false, false, 'missing-branch')
                expect.fail()
            } catch (err) {
                expect(err).to.include("branch 'missing-branch' not found")
                expect(callCount).to.equal(1)
            }
        })
    })
