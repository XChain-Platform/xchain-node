'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    sinon,
    expect,
    PassThrough,
    XChainService,
    COIN,
    NETWORK,
    FAKE_CONTAINER_ID,
    makeSpawnProc,
    drainPassThrough,
    makeAutoSpawn,
    makeStubs,
    loadBootstrapService
} = require('./helpers/support')

let savedRequireSigned

function saveRequireSignedBootstrapSetting() {
    savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
}

function restoreRequireSignedBootstrapSetting() {
    if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
}

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        it('refuses to publish a truncated outer archive when the wrap tar dies', async function () {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.execFile = sinon.stub().resolves({ stdout: '104857600\t/data\n' })
            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })

            // spawn #0 is the docker tar (inner), spawn #1 the outer wrap.
            makeAutoSpawn(stubs, { exitCodes: { 1: 2 } })

            const bs = loadBootstrapService(stubs)
            const err = await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
                .then(() => null, e => e)
            expect(err).to.not.be.null
            expect(err.message).to.include('tar exited with code 2')
            expect(stubs.dockerService.startContainer.called).to.be.true

            // The partial archive must not be left in the directory the publish
            // rsyncs from.
            const removed = stubs.fs.rmSync.getCalls()
                .some(c => String(c.args[0]).endsWith('.tar.gz'))
            expect(removed, 'the truncated outer archive must be removed').to.be.true
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        it('throws when container not found', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(null)
            stubs.execFile = sinon.stub().resolves({ stdout: '1024\t/data\n' })
            const bs = loadBootstrapService(stubs)
            try {
                await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('utxo-tracker container not found')
            }
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        it('proceeds when du estimate fails (catch branch, progress shows ?%)', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)

            // The `docker du` size estimate throws → progress falls back to ?%
            stubs.execFile = sinon.stub().callsFake((cmd, args) => {
                if (cmd === 'docker' && Array.isArray(args) && args.includes('du')) {
                    return Promise.reject(new Error('docker du failed'))
                }
                return Promise.resolve({ stdout: '' })
            })

            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
            stubs.fs.promises.writeFile.resolves()

            makeAutoSpawn(stubs)

            const bs = loadBootstrapService(stubs)
            const result = await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
            expect(result).to.be.true
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        it('restarts container even when tar spawn fails', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.execFile = sinon.stub().resolves({ stdout: '' })

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(tarProc)

            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)

            setImmediate(() => {
                tarProc.emit('error', new Error('spawn error'))
            })

            try {
                await promise
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('spawn error')
            }
            expect(stubs.dockerService.startContainer.called).to.be.true
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        it('restarts container when docker tar exits non-zero', async function () {
            const stubs = makeStubs()
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.execFile = sinon.stub().resolves({ stdout: '' })

            const tarProc = makeSpawnProc()
            stubs.spawn = sinon.stub().returns(tarProc)

            const writeStream = new PassThrough()
            drainPassThrough(writeStream)
            stubs.fs.createWriteStream.returns(writeStream)

            const bs = loadBootstrapService(stubs)
            const promise = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)

            setImmediate(() => {
                tarProc.emit('close', 127)
            })

            try {
                await promise
                expect.fail()
            } catch (err) {
                expect(err.message).to.include('docker tar exited with code 127')
            }
            expect(stubs.dockerService.startContainer.called).to.be.true
        })
    })
})

        function trackerStubs() {
            const stubs = makeStubs()
            stubs.fs.existsSync.returns(false)
            stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
            stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
            stubs.execFile = sinon.stub().resolves({ stdout: '104857600\t/data\n' })
            return stubs
        }


    // The snapshot shrinks the outage but does not
    // remove it, and the fallback path still holds the tracker down for the
    // whole compress. Whatever the outage's length, the encoder reports it
    // honestly and the public board has only one word for it:
    // Degraded. The publish therefore tells the encoder the outage is
    // planned, so the board can say Maintenance instead.

        // On the snapshot path the encoder recovers seconds after the stop,
        // so holding the window open for the multi-hour compress would have
        // /status advertising maintenance on an encoder that is serving.

        // A cosmetic status label is never worth a failed publish or a
        // tracker left down.
describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        describe('encoder maintenance window', function () {
            it('declares the window BEFORE the tracker stops', async function () {
                const stubs = trackerStubs()
                let declaredBeforeStop = null
                stubs.dockerService.stopContainer = sinon.stub().callsFake(async () => {
                    declaredBeforeStop = stubs.encoderMaintenance.declareEncoderMaintenance.called
                })
                makeAutoSpawn(stubs)

                const bs = loadBootstrapService(stubs)
                expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true

                // Otherwise the first probe after the stop still sees a bare
                // 503 with nothing to explain it.
                expect(declaredBeforeStop, 'the window must be declared before the outage starts').to.be.true
                const [coin, network, opts] = stubs.encoderMaintenance.declareEncoderMaintenance.getCall(0).args
                expect(coin).to.equal(COIN)
                expect(network).to.equal(NETWORK)
                expect(opts.reason).to.include(XChainService.XCHAIN_UTXO_TRACKER)
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        describe('encoder maintenance window', function () {
            it('clears the window as soon as the tracker is back, not when the compress ends', async function () {
                const stubs = trackerStubs()
                let clearedBeforeFirstSpawn = null
                const spawnCalls = makeAutoSpawn(stubs)
                const rawSpawn = stubs.spawn
                stubs.spawn = sinon.stub().callsFake((cmd, args) => {
                    if (clearedBeforeFirstSpawn === null) {
                        clearedBeforeFirstSpawn = stubs.encoderMaintenance.clearEncoderMaintenance.called
                    }
                    return rawSpawn(cmd, args)
                })

                const bs = loadBootstrapService(stubs)
                expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true

                expect(clearedBeforeFirstSpawn).to.be.true
                // Idempotent: the finally must not clear a window it already closed.
                expect(stubs.encoderMaintenance.clearEncoderMaintenance.callCount).to.equal(1)
                expect(spawnCalls.length).to.be.at.least(1)
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        describe('encoder maintenance window', function () {
            it('holds the window for the whole compress on the stopped-tracker fallback', async function () {
                const stubs = trackerStubs()
                stubs.execFile = sinon.stub().callsFake((cmd, args) => {
                    if (cmd === 'docker' && Array.isArray(args) && args.includes('sh')) {
                        return Promise.reject(new Error('cp: cannot create hard link'))
                    }
                    return Promise.resolve({ stdout: '104857600\t/data\n' })
                })
                let clearedBeforeFirstSpawn = null
                const rawSpawnCalls = makeAutoSpawn(stubs)
                const rawSpawn = stubs.spawn
                stubs.spawn = sinon.stub().callsFake((cmd, args) => {
                    if (clearedBeforeFirstSpawn === null) {
                        clearedBeforeFirstSpawn = stubs.encoderMaintenance.clearEncoderMaintenance.called
                    }
                    return rawSpawn(cmd, args)
                })

                const bs = loadBootstrapService(stubs)
                expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true

                // The tracker is down for the whole run here, so the window has
                // to outlive the compress and close with the restart.
                expect(clearedBeforeFirstSpawn).to.be.false
                expect(stubs.encoderMaintenance.clearEncoderMaintenance.callCount).to.equal(1)
                expect(rawSpawnCalls.length).to.be.at.least(1)
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        describe('encoder maintenance window', function () {
            it('clears the window even when the publish fails mid-compress', async function () {
                const stubs = trackerStubs()
                // Fallback path, so the window is still open when the run dies:
                // on the snapshot path it was already closed at the restart.
                stubs.execFile = sinon.stub().callsFake((cmd, args) => {
                    if (cmd === 'docker' && Array.isArray(args) && args.includes('sh')) {
                        return Promise.reject(new Error('cp: cannot create hard link'))
                    }
                    return Promise.resolve({ stdout: '104857600\t/data\n' })
                })
                stubs.fs.promises.writeFile.rejects(new Error('ENOSPC: no space left on device'))
                makeAutoSpawn(stubs)

                const bs = loadBootstrapService(stubs)
                const err = await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)
                    .then(() => null, e => e)
                expect(err).to.not.be.null
                // A failed run must not leave the board excusing an encoder that
                // is serving again.
                expect(stubs.encoderMaintenance.clearEncoderMaintenance.called).to.be.true
            })
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): happy path', function () {
        describe('encoder maintenance window', function () {
            it('publishes normally when the encoder cannot be told', async function () {
                const stubs = trackerStubs()
                stubs.encoderMaintenance.declareEncoderMaintenance = sinon.stub().resolves(false)
                makeAutoSpawn(stubs)

                const bs = loadBootstrapService(stubs)
                expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true
                // Nothing was declared, so nothing is cleared.
                expect(stubs.encoderMaintenance.clearEncoderMaintenance.called).to.be.false
                expect(stubs.dockerService.startContainer.calledWith(FAKE_CONTAINER_ID)).to.be.true
            })
        })
    })
})
