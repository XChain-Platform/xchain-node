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

    // -------------------------------------------------------------------
    // buildAndUp
    // -------------------------------------------------------------------
moduleSuite('buildAndUp()', function () {

        it('throws when module does not exist', async function () {
            const stubs = makeStubs()
            const ms = proxyquire('../../../src/services/module_service', {
                'child_process': { execFile: stubs.execFile },
                'fs': stubs.fs,
                '../state': { db: stubs.db, getRemoteModuleVersions: () => ({}), getLastStatus: () => null },
                './config_service': {
                    getModuleDir: (mod) => '/modules/' + mod,
                    getModuleTmpDir: (mod) => '/tmp/' + mod,
                    moduleDirExists: sinon.stub().returns(false),
                    checkIfModuleExists: sinon.stub().returns(false),
                    removeModuleDir: sinon.stub(),
                    removeModuleTmpDir: sinon.stub(),
                    createModuleTmpDir: sinon.stub(),
                    getDockerContainerImageName: sinon.stub().returns('xchain-node-bitcoin-mainnet-xchain-encoder'),
                    getDockerNetwork: sinon.stub().returns('xchain-node-bitcoin-mainnet'),
                    getDefaultConfig: sinon.stub().resolves({})
                },
                './status_service': { statusChanged: stubs.statusChanged, getStatus: stubs.getStatus },
                './docker_service': { killContainer: stubs.killContainer, stopContainerByName: stubs.stopContainerByName, removeContainer: stubs.removeContainer, forceRemoveContainerByName: stubs.forceRemoveContainerByName, getStatusFromContainer: stubs.getStatusFromContainer },
                './database_service': { setDatabaseParameters: sinon.stub().resolves(), setHubDatabaseParameters: sinon.stub().resolves() }
            })
            try {
                await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
                expect.fail()
            } catch (err) {
                expect(err).to.equal('module not found')
            }
        })

        it('runs docker build with correct image name and cwd', async function () {
            const stubs = makeStubs()
            let buildArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    buildArgs = args
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(buildArgs).to.include('-t')
            expect(buildArgs).to.include('xchain-node-bitcoin-mainnet-xchain-encoder')
        })

        })

moduleSuite('buildAndUp()', function () {it('passes environment variables via the child env (bare --env NAME), not as argv values', async function () {
            const stubs = makeStubs()
            let runArgs = null
            let runOpts = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    runArgs = args
                    runOpts = opts
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            // Names on the command line...
            expect(runArgs).to.include('--env')
            expect(runArgs).to.include('NETWORK')
            expect(runArgs).to.include('NODE_PORT')
            // ...values only in the child process env (keeps secrets off argv).
            expect(runOpts.env.NETWORK).to.equal('bitcoin-mainnet')
            expect(runOpts.env.NODE_PORT).to.equal('8332')
            expect(runArgs).to.not.include('NETWORK=bitcoin-mainnet')
        })

        it('includes port mapping for encoder', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    runArgs = args
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_ENCODER, 'bitcoin', 'mainnet')
            expect(runArgs).to.include('-p')
            expect(runArgs).to.include('3003:3003')
        })

        })

moduleSuite('buildAndUp()', function () {it('includes volume mount for decoder', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    runArgs = args
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_DECODER, 'bitcoin', 'mainnet')
            expect(runArgs).to.include('-v')
            expect(runArgs.some(a => a.includes('/bootstrap/xchain-decoder'))).to.be.true
        })

        it('includes ulimit for utxo-tracker', async function () {
            const stubs = makeStubs()
            const seen = stubDockerCreate(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            expect(runArgsOf(seen)).to.include('--ulimit')
            expect(runArgsOf(seen)).to.include('nofile=2048:2048')
        })

        // The derived cap only reaches the kernel if it reaches argv. Nothing else
        // in this file would notice the two flags being dropped from runArgs.
        it('caps the tracker with --memory and an equal --memory-swap', async function () {
            const stubs = makeStubs()
            const seen = stubDockerCreate(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            const runArgs = runArgsOf(seen)
            expect(runArgs).to.include('--memory')
            expect(runArgs).to.include('--memory-swap')
            const mb = runArgs[runArgs.indexOf('--memory') + 1]
            expect(mb).to.match(/^\d+m$/)
            expect(runArgs[runArgs.indexOf('--memory-swap') + 1]).to.equal(mb)
        })

        it('keeps the legacy tracker volume name under the default NODE_PREFIX', async function () {
            const stubs = makeStubs()
            const seen = stubDockerCreate(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            expect(runArgsOf(seen)).to.include('xchain-utxo-tracker-bitcoin-mainnet-data:/data/xchain-utxo-tracker')
        })

        })

moduleSuite('buildAndUp()', function () {it('prefixes the tracker volume name under a non-default NODE_PREFIX (F11)', async function () {
            const stubs = makeStubs()
            const seen = stubDockerCreate(stubs)
            const ms = loadModuleService(stubs, { NODE_PREFIX: 'xchain-fed' })
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'regtest')
            expect(runArgsOf(seen)).to.include('xchain-fed-xchain-utxo-tracker-bitcoin-regtest-data:/data/xchain-utxo-tracker')
        })

        it('includes --network flag in docker run', async function () {
            const stubs = makeStubs()
            let runArgs = null
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    runArgs = args
                    cb(null, 'a'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(runArgs).to.include('--network')
            expect(runArgs).to.include('xchain-node-bitcoin-mainnet')
        })

        it('stores container ID in LevelDB on success', async function () {
            const stubs = makeStubs()
            const containerId = 'b'.repeat(64)
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, containerId + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(stubs.db.setModuleContainer.calledOnce).to.be.true
            const dbArgs = stubs.db.setModuleContainer.firstCall.args
            expect(dbArgs[0]).to.equal('xchain-encoder')
            expect(dbArgs[1]).to.equal('bitcoin')
            expect(dbArgs[2]).to.equal('mainnet')
            expect(dbArgs[3]).to.equal(containerId)
        })

        })

moduleSuite('buildAndUp()', function () {it('calls statusChanged after storing container ID', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, 'c'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(stubs.statusChanged.calledOnce).to.be.true
        })

        it('kills and removes old container when overwriteContainerId is provided', async function () {
            const stubs = makeStubs()
            stubs.execFile.callsFake((cmd, args, ...rest) => {
                let opts = {}, cb
                if (typeof rest[0] === 'function') { cb = rest[0] }
                else { opts = rest[0] || {}; cb = rest[1] }
                if (args[0] === 'build') {
                    cb(null)
                } else if (args[0] === 'run') {
                    cb(null, 'd'.repeat(64) + '\n')
                }
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet', 'old-id-123')
            expect(stubs.stopContainerByName.calledWith('old-id-123', 30)).to.be.true
            expect(stubs.removeContainer.calledWith('old-id-123')).to.be.true
        })
    })

    // -------------------------------------------------------------------
    // buildAndUp: the memory limit that was asked for is the one that landed
    // -------------------------------------------------------------------
    // A kernel with no memory cgroup controller (Raspberry Pi OS by default)
    // takes --memory, warns on stderr, exits 0, and creates the container with
    // HostConfig.Memory=0. An operator was told his tracker was capped at 2703 MB
    // on a 16 GB host while it was in fact running on the whole box.
moduleSuite('buildAndUp() memory limit readback', function () {

        let out
        beforeEach(function () { out = captureConsole() })
        afterEach(function () { out.restore() })

        it('reads the new container back and says nothing when the cap stuck', async function () {
            const stubs = makeStubs()
            const seen = stubDockerCreate(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            const inspect = seen.find(c => c.args[0] === 'inspect')
            expect(inspect, 'the create must read its own container back').to.exist
            expect(inspect.args).to.include('{{.HostConfig.Memory}}')
            expect(out.warn.join('\n')).to.not.match(/running UNCAPPED/)
        })

        it('warns loudly, and does NOT fail the create, when docker kept no limit', async function () {
            const stubs = makeStubs()
            stubDockerCreate(stubs, { memoryBytes: 0 })
            const ms = loadModuleService(stubs)
            const id = await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            expect(id, 'an unenforceable cap must not block the install').to.equal('a'.repeat(64))
            expect(stubs.db.setModuleContainer.calledOnce).to.be.true
            const warned = out.warn.join('\n')
            expect(warned).to.match(/memory limit was requested for xchain-utxo-tracker \(bitcoin mainnet\)/)
            expect(warned).to.match(/Docker did not keep it/)
            expect(warned).to.match(/running UNCAPPED/)
            expect(warned).to.match(/cgroup_enable=memory cgroup_memory=1/)
            expect(warned).to.match(/\/boot\/firmware\/cmdline\.txt/)
            expect(warned).to.match(/recreate xchain-utxo-tracker all all/)
            expect(warned).to.match(/No memory limit support/)
        })

        it('warns when a limit was kept but is not the one that was asked for', async function () {
            const stubs = makeStubs()
            stubDockerCreate(stubs, { memoryBytes: 512 * 1024 * 1024 })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            expect(out.warn.join('\n')).to.match(/running UNCAPPED/)
        })

        it('does not read anything back for a module that asked for no cap', async function () {
            const stubs = makeStubs()
            const seen = stubDockerCreate(stubs, { memoryBytes: 0 })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp('xchain-encoder', 'bitcoin', 'mainnet')
            expect(seen.some(c => c.args[0] === 'inspect')).to.be.false
            expect(out.warn.join('\n')).to.not.match(/running UNCAPPED/)
        })
    })

    // -------------------------------------------------------------------
    // buildAndUp: what a successful create said, and which chain it was about
    // -------------------------------------------------------------------
moduleSuite('buildAndUp() create narration', function () {

        let out
        beforeEach(function () { out = captureConsole() })
        afterEach(function () { out.restore() })

        // Exit 0 with a warning on stderr is how docker reports that it took an
        // argument and then ignored it, and a callback that reads stdout only drops it.
        it('surfaces what a SUCCESSFUL docker run wrote to stderr', async function () {
            const stubs = makeStubs()
            stubDockerCreate(stubs, {
                memoryBytes: 0,
                runStderr: 'WARNING: Your kernel does not support memory limit capabilities '
                    + 'or the cgroup is not mounted. Limitation discarded.\n'
            })
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'bitcoin', 'mainnet')
            const warned = out.warn.join('\n')
            expect(warned).to.match(/docker said while creating xchain-utxo-tracker \(bitcoin mainnet\)/)
            expect(warned).to.match(/Limitation discarded/)
        })

        // `update all` creates one tracker per chain and printed the same note
        // three times, with nothing in it naming which container it described.
        it('names the chain in the memory note', async function () {
            const stubs = makeStubs()
            stubDockerCreate(stubs)
            const ms = loadModuleService(stubs)
            await ms.buildAndUp(XChainService.XCHAIN_UTXO_TRACKER, 'dogecoin', 'mainnet')
            expect(out.log.join('\n')).to.match(
                /memory limit for xchain-utxo-tracker \(dogecoin mainnet\): \d+ MB \(host \d+ MB, 50% shared by \d+ tracker/)
        })
    })
