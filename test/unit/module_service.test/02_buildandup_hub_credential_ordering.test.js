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

function hubStubs() {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                if (args[0] === 'build') cb(null)
                else if (args[0] === 'run') cb(null, 'f'.repeat(64) + '\n')
                else cb(null, '')
            })
            return stubs
        }
function withDbStub(stubs, setHubDatabaseParameters) {
            return loadModuleService(stubs, null, {
                './database_service': {
                    setDatabaseParameters: sinon.stub().resolves(),
                    setHubDatabaseParameters
                }
            })
        }

function dockerStub(stubs, { imageExists = true } = {}) {
            const seen = []
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
                seen.push({ cmd, args })
                if (args[0] === 'image') {
                    if (imageExists) cb(null, 'sha256:abc\n')
                    else cb(new Error('No such image'))
                } else if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, 'e'.repeat(64) + '\n')
                } else {
                    cb(null, '')
                }
            })
            return seen
        }

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

    // -------------------------------------------------------------------
    // buildAndUp: the hub grant is rotated before the health-dependent push
    // -------------------------------------------------------------------
    // statusChanged() pushes config over the hub's HTTP API and rethrows on failure.
    // A hub restarted on a rotated HUB_DB_PASS that MariaDB never received cannot
    // authenticate, so it cannot serve that push, so buildAndUp rejects and the
    // rotation its callers run AFTER buildAndUp resolves is never reached: the
    // operator is left with a crash-looping hub (uuid:c466af19).
moduleSuite('buildAndUp() hub credential ordering', function () {

        it('rotates the hub grant BEFORE the config push that needs the hub to answer', async function () {
            const stubs = hubStubs()
            const setHub = sinon.stub().resolves()
            const ms = withDbStub(stubs, setHub)
            await ms.buildAndUp('xchain-hub', null, null)
            expect(setHub.calledOnce).to.be.true
            expect(setHub.firstCall.calledBefore(stubs.statusChanged.firstCall)).to.be.true
        })

        it('rotates the grant even when the config push then fails', async function () {
            const stubs = hubStubs()
            stubs.statusChanged.rejects(new Error('hub did not answer the config push'))
            const setHub = sinon.stub().resolves()
            const ms = withDbStub(stubs, setHub)
            let threw = false
            try {
                await ms.buildAndUp('xchain-hub', null, null)
            } catch (err) {
                threw = true
                expect(String((err && err.message) || err)).to.contain('config push')
            }
            expect(threw, 'the push failure must still reach the caller').to.be.true
            // The point of the fix: the account is already correct even though the
            // command failed, so the restarting hub authenticates instead of
            // crash-looping on ER_ACCESS_DENIED with no way back.
            expect(setHub.calledOnce).to.be.true
        })

        })

moduleSuite('buildAndUp() hub credential ordering', function () {

        it('does not touch the hub account for any other module', async function () {
            const stubs = hubStubs()
            const setHub = sinon.stub().resolves()
            const ms = withDbStub(stubs, setHub)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(setHub.called).to.be.false
        })

        it('does not touch the hub account for a one-shot execution container', async function () {
            const stubs = hubStubs()
            const setHub = sinon.stub().resolves()
            const ms = withDbStub(stubs, setHub)
            await ms.buildAndUp('xchain-hub', null, null, null, true)
            expect(setHub.called).to.be.false
            expect(stubs.statusChanged.called).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // buildAndUp: reuseImage
    // -------------------------------------------------------------------
    // A container freezes its config env at `docker run`, so correcting a
    // value it carries means recreating it. The normal path also re-clones the module
    // and its bundled libraries from GitHub, which turns a credential repair into an
    // unreviewed version change on a live venue.
moduleSuite('buildAndUp() reuseImage', function () {

        // `docker image inspect` goes through promisify(execFile); a sinon stub carries
        // no promisify.custom, so it is driven by the trailing callback like the rest.

        it('creates the container without running docker build', async function () {
            const stubs = makeStubs()
            const seen = dockerStub(stubs)
            const ms = loadModuleService(stubs)
            const id = await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, false, null, { reuseImage: true })
            expect(id).to.equal('e'.repeat(64))
            expect(seen.some(c => c.cmd === 'docker' && c.args[0] === 'build')).to.be.false
            const run = seen.find(c => c.args[0] === 'run')
            expect(run.args).to.include('xchain-node-bitcoin-mainnet-xchain-encoder')
        })

        it('verifies the tag exists first, and says so when it does not', async function () {
            const stubs = makeStubs()
            const seen = dockerStub(stubs, { imageExists: false })
            const ms = loadModuleService(stubs)
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', null, false, null, { reuseImage: true })
                expect.fail('a missing image must not fall through to docker run')
            } catch (err) {
                expect(err.message).to.match(/No local image tagged xchain-node-bitcoin-mainnet-xchain-encoder/)
                expect(err.message).to.match(/update xchain-encoder bitcoin mainnet/)
            }
            expect(seen.some(c => c.args[0] === 'run')).to.be.false
        })

        })

moduleSuite('buildAndUp() reuseImage', function () {

        // `docker image inspect` goes through promisify(execFile); a sinon stub carries
        // no promisify.custom, so it is driven by the trailing callback like the rest.

        it('does not re-clone the bundled libraries', async function () {
            const stubs = makeStubs()
            const seen = dockerStub(stubs)
            const ms = loadModuleService(stubs)
            // xchain-indexer bundles xchain-vm, which the build path re-clones every time.
            await ms.buildAndUp('xchain-indexer', 'bitcoin', 'mainnet', null, false, null, { reuseImage: true })
            expect(seen.some(c => c.cmd === 'git')).to.be.false
            expect(stubs.fs.rmSync.called).to.be.false
        })

        it('still tears the old container down and registers the new id', async function () {
            const stubs = makeStubs()
            dockerStub(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', 'old-id-123', false, null, { reuseImage: true })
            expect(stubs.stopContainerByName.calledWith('old-id-123', 30)).to.be.true
            expect(stubs.removeContainer.calledWith('old-id-123')).to.be.true
            expect(stubs.forceRemoveContainerByName.calledWith('xchain-node-bitcoin-mainnet-xchain-encoder')).to.be.true
            expect(stubs.db.setModuleContainer.calledWith('xchain-encoder', 'bitcoin', 'mainnet', 'e'.repeat(64))).to.be.true
        })

        it('leaves the default path building the image', async function () {
            const stubs = makeStubs()
            const seen = dockerStub(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(seen.some(c => c.args[0] === 'build')).to.be.true
            expect(seen.some(c => c.args[0] === 'image')).to.be.false
        })
    })

    // -------------------------------------------------------------------
    // buildAndUp: healthcheck args
    // -------------------------------------------------------------------
moduleSuite('buildAndUp() healthcheck args', function () {

        it('includes --health-cmd for encoder (http_get probe)', async function () {
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('/status')
            expect(args[cmdIdx + 1]).to.include('3003')
        })

        it('includes --health-cmd for decoder (http_get probe on /live, not /status)', async function () {
            // The decoder's /status is process-alive + DB-reachable only, so a block
            // loop retrying one height forever answers 200 while lag grows without
            // bound and autoheal (which reads nothing but Health.Status) never fires.
            // /live is /status plus the stall check, so the probe measures liveness.
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet')
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('/live')
            expect(args[cmdIdx + 1]).to.not.include('/status')
            expect(args[cmdIdx + 1]).to.include('3002')
        })

        })

moduleSuite('buildAndUp() healthcheck args', function () {

        it('includes --health-cmd for indexer (http_get probe)', async function () {
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-indexer', 'bitcoin', 'mainnet')
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('/status')
            expect(args[cmdIdx + 1]).to.include('3004')
        })

        it('probes health (not ping) for hub (jsonrpc_health probe)', async function () {
            // The hub's ping is a bare SELECT 1; its health method 503s on a tripped
            // DB breaker, a stale oracle round, and consensus-input alerting. Probing
            // ping let a hub that had stopped producing consensus data read healthy.
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-hub', null, null)
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('"method":"health"')
            expect(args[cmdIdx + 1]).to.not.include('"method":"ping"')
            expect(args[cmdIdx + 1]).to.include('10000')
        })

        it('includes --health-cmd for explorer (jsonrpc_ping probe)', async function () {
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-explorer', null, null)
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('ping')
            expect(args[cmdIdx + 1]).to.include('8080')
        })

        })

moduleSuite('buildAndUp() healthcheck args', function () {

        it('probes health (not ping) for regtest-miner (jsonrpc_health probe)', async function () {
            // The miner's API is JSON-RPC only (no GET /status route); an http_get
            // probe 500s forever and marks the container permanently unhealthy. Its
            // ping always answers 200 and reports wallet readiness in the body only,
            // so a miner stalled on credential drift stayed healthy; health 503s.
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-regtest-miner', 'bitcoin', 'mainnet')
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('"method":"health"')
            expect(args[cmdIdx + 1]).to.not.include('"method":"ping"')
            expect(args[cmdIdx + 1]).to.not.include('/status')
            expect(args[cmdIdx + 1]).to.include('3005')
        })

        it('probes /health (not /status) for sync (http_get probe)', async function () {
            // Sync's /status runs a SELECT COUNT(*) census over every replicated
            // table; on a heavy multi-chain host that exceeds the 5s healthcheck
            // timeout and marks a correctly-serving container UNHEALTHY.
            // The probe must hit the O(1) /health liveness route instead.
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-sync', null, null)
            const args = getRunArgs()
            expect(args).to.include('--health-cmd')
            const cmdIdx = args.indexOf('--health-cmd')
            expect(args[cmdIdx + 1]).to.include('/health')
            expect(args[cmdIdx + 1]).to.not.include('/status')
            expect(args[cmdIdx + 1]).to.include('3006')
        })

        it('grants sync a start period covering the whole MAX_HUB_WAIT_MS hub wait', async function () {
            // /health answers 503 'starting' until SyncService.start() returns, and
            // start() waits on the hub for MAX_HUB_WAIT_MS (default 300000ms). At the
            // former 45s start period plus 3 retries at 15s, a hub slower than ~90s
            // marked a correctly-starting sync container UNHEALTHY. The window must
            // cover the wait judged by the probe.
            const stubs = makeStubs()
            const getRunArgs = captureRunArgs(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-sync', null, null)
            const args = getRunArgs()
            const idx = args.indexOf('--health-start-period')
            expect(idx).to.be.greaterThan(-1)
            const seconds = parseInt(String(args[idx + 1]).replace(/s$/, ''), 10)
            const retryWindow = 3 * 15
            expect(seconds).to.be.at.least(300 - retryWindow)
        })

        })

moduleSuite('buildAndUp() healthcheck args', function () {

        it('warns and returns [] when the descriptor portKey is missing from the env', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const logSpy = sinon.spy(console, 'log')
            try {
                // DECODER_API_PORT deliberately absent from the env
                const args = ms.buildHealthcheckArgs('xchain-decoder', {})
                expect(args).to.deep.equal([])
                const warned = logSpy.getCalls().map(c => c.args.join(' ')).join('\n')
                expect(warned).to.match(/WARNING: no healthcheck for xchain-decoder/)
                expect(warned).to.match(/DECODER_API_PORT is unset/)
            } finally {
                logSpy.restore()
            }
        })

        it('does not warn and returns health args when the portKey is present', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const logSpy = sinon.spy(console, 'log')
            try {
                const args = ms.buildHealthcheckArgs('xchain-decoder', { DECODER_API_PORT: '3002' })
                expect(args).to.include('--health-cmd')
                const warned = logSpy.getCalls().map(c => c.args.join(' ')).join('\n')
                expect(warned).to.not.match(/WARNING: no healthcheck/)
            } finally {
                logSpy.restore()
            }
        })

        // The healthcheck grace window is env-tunable per service so an
        // operator can widen it for a long bootstrap restore.
        it('honors XCHAIN_NODE_HEALTH_START_PERIOD_<SERVICE> override', function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)
            const saved = process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
            process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = '900s'
            try {
                const args = ms.buildHealthcheckArgs('xchain-utxo-tracker', { UTXO_TRACKER_API_PORT: '3003' })
                const i = args.indexOf('--health-start-period')
                expect(i).to.be.greaterThan(-1)
                expect(args[i + 1]).to.equal('900s')
            } finally {
                if (saved === undefined) delete process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER
                else process.env.XCHAIN_NODE_HEALTH_START_PERIOD_XCHAIN_UTXO_TRACKER = saved
            }
        })

        // The comment block documents `=900` (bare seconds) as a valid override, but
        // docker parses --health-start-period with Go's time.ParseDuration, which
        // rejects a unitless number and fails the whole `docker run`. Bare seconds
        // must therefore reach docker with an 's' appended, never verbatim.
        })
