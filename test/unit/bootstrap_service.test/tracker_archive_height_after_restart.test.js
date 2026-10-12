'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const {
    sinon,
    expect,
    XChainService,
    COIN,
    NETWORK,
    FAKE_CONTAINER_ID,
    makeAutoSpawn,
    makeStubs,
    loadBootstrapService
} = require('./helpers/support')

const PORT_KEY = 'UTXO_TRACKER_API_PORT'

let savedRequireSigned

function saveRequireSignedBootstrapSetting() {
    savedRequireSigned = process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = '0'
}

function restoreRequireSignedBootstrapSetting() {
    if (savedRequireSigned === undefined) delete process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP
    else process.env.XCHAIN_NODE_REQUIRE_SIGNED_BOOTSTRAP = savedRequireSigned
}

// Wire a tracker status probe that answers `heights` in order, noting whether the tracker had been restarted at each call.
function trackerStubsWithProbe(heights, { snapshotFails = false } = {}) {
    const stubs = makeStubs()
    stubs.fs.existsSync.returns(false)
    stubs.db.getModuleContainer.resolves(FAKE_CONTAINER_ID)
    stubs.fs.promises.stat.resolves({ size: 1024 * 1024 })
    stubs.execFile = sinon.stub().callsFake((cmd, args) => {
        if (snapshotFails && cmd === 'docker' && Array.isArray(args) && args.includes('sh')) {
            return Promise.reject(new Error('cp: cannot create hard link'))
        }
        return Promise.resolve({ stdout: '104857600\t/data\n' })
    })
    stubs.configService.getDefaultConfig.resolves({
        UTXO_TRACKER_BOOTSTRAP_VOLUME: '/data/bitcoin/mainnet/xchain-utxo-tracker/bootstrap/',
        [PORT_KEY]: '8080'
    })
    const probeLog = []
    stubs.healthGate.MODULE_API_PORT_KEY = { [XChainService.XCHAIN_UTXO_TRACKER]: PORT_KEY }
    stubs.healthGate.probeServiceStatus = sinon.stub().callsFake(async () => {
        const answer = heights[Math.min(probeLog.length, heights.length - 1)]
        probeLog.push({ restarted: stubs.dockerService.startContainer.called })
        if (answer instanceof Error) throw answer
        return { committed_height: answer }
    })
    return { stubs, probeLog }
}

function recordedHeight(stubs) {
    return stubs.archiveMeta.writeBootstrapMeta.firstCall.args[1].height
}

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): archive height is read after the restart', function () {
        it('records the post-restart height on the snapshot path, not the pre-stop one', async function () {
            const { stubs, probeLog } = trackerStubsWithProbe([100, 101])
            makeAutoSpawn(stubs)

            const bs = loadBootstrapService(stubs)
            expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true

            expect(probeLog.map(p => p.restarted)).to.deep.equal([false, true])
            expect(recordedHeight(stubs)).to.equal(101)
        })

        it('restarts the tracker after the compress and before the wrap on the stopped-tracker fallback', async function () {
            const { stubs, probeLog } = trackerStubsWithProbe([100, 104], { snapshotFails: true })
            const spawnCalls = makeAutoSpawn(stubs)
            const rawSpawn = stubs.spawn
            const startedAtSpawn = []
            stubs.spawn = sinon.stub().callsFake((cmd, args) => {
                startedAtSpawn.push(stubs.dockerService.startContainer.callCount)
                return rawSpawn(cmd, args)
            })

            const bs = loadBootstrapService(stubs)
            expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true

            // spawn #0 is the docker tar compress (tracker still stopped), spawn #1 the outer wrap (tracker back).
            expect(spawnCalls[0].cmd).to.equal('docker')
            expect(spawnCalls[1].cmd).to.equal('tar')
            expect(startedAtSpawn).to.deep.equal([0, 1])
            expect(stubs.dockerService.startContainer.callCount).to.equal(1)
            expect(stubs.encoderMaintenance.clearEncoderMaintenance.callCount).to.equal(1)
            expect(probeLog.map(p => p.restarted)).to.deep.equal([false, true])
            expect(recordedHeight(stubs)).to.equal(104)
        })

        it('keeps the pre-stop height when a rollback leaves the post-restart reading lower', async function () {
            const { stubs } = trackerStubsWithProbe([100, 98])
            makeAutoSpawn(stubs)

            const bs = loadBootstrapService(stubs)
            expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true
            expect(recordedHeight(stubs)).to.equal(100)
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): an unreadable post-restart height is never archived', function () {
        // A pre-stop floor with no post-restart reading may understate the archived data, so the run refuses
        // before the compress; the probe's 5 s retry delays run on fake timers.
        it('refuses before the compress when the post-restart height cannot be read on the snapshot path', async function () {
            const { stubs, probeLog } = trackerStubsWithProbe([100, new Error('connection refused')])
            const spawnCalls = makeAutoSpawn(stubs)
            const clock = sinon.useFakeTimers({ toFake: ['setTimeout'] })
            try {
                const bs = loadBootstrapService(stubs)
                let err = null
                const run = bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER).then(() => null, e => { err = e })
                for (let i = 0; i < 200 && err === null; i++) await clock.tickAsync(5000)
                await run

                expect(err, 'an unreadable post-restart height must fail the create').to.not.equal(null)
                expect(err.message).to.match(/did not report its committed height after the restart/)
                expect(err.message).to.include('pre-stop reading 100')
                expect(probeLog.filter(p => p.restarted)).to.have.length(60)
                expect(spawnCalls, 'no compress or wrap may run').to.have.length(0)
                expect(stubs.archiveMeta.writeBootstrapMeta.called).to.equal(false)
                expect(stubs.dockerService.startContainer.callCount).to.equal(1)
                expect(stubs.encoderMaintenance.clearEncoderMaintenance.callCount).to.equal(1)
            } finally {
                clock.restore()
            }
        })
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('makeBootstrapUtxoTracker(): an unclean tracker stop is never archived', function () {
        it('stops the tracker with its 120 s service budget when the container carries no stamp', async function () {
            const { stubs } = trackerStubsWithProbe([100, 101])
            makeAutoSpawn(stubs)

            const bs = loadBootstrapService(stubs)
            expect(await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER)).to.be.true
            expect(stubs.dockerService.stopContainer.firstCall.args).to.deep.equal([FAKE_CONTAINER_ID, 120])
        })

        for (const [label, outcome] of [
            ['was killed at the budget', { stopped: true, seconds: 120, killed: true, exitCode: 137 }],
            ['exited non-zero inside the budget', { stopped: true, seconds: 100, killed: false, exitCode: 1 }]
        ]) {
            it(`refuses to snapshot, compress or sign when the tracker ${label}, and restarts it`, async function () {
                const { stubs } = trackerStubsWithProbe([100, 101])
                const spawnCalls = makeAutoSpawn(stubs)
                stubs.dockerService.stopContainer = sinon.stub().resolves(outcome)

                const bs = loadBootstrapService(stubs)
                let err = null
                try { await bs.makeBootstrap(COIN, NETWORK, XChainService.XCHAIN_UTXO_TRACKER) } catch (e) { err = e }

                expect(err, 'an unclean stop must fail the create').to.not.equal(null)
                expect(err.message).to.match(/did not shut down cleanly/)
                expect(err.message).to.include(`exit code ${outcome.exitCode}`)
                const snapshots = stubs.execFile.getCalls().filter(c => Array.isArray(c.args[1]) && c.args[1].includes('sh'))
                expect(snapshots, 'no snapshot may be taken of an unclean store').to.have.length(0)
                expect(spawnCalls, 'no compress or wrap may run').to.have.length(0)
                expect(stubs.archiveMeta.writeBootstrapMeta.called).to.equal(false)
                expect(stubs.dockerService.startContainer.calledOnceWithExactly(FAKE_CONTAINER_ID)).to.equal(true)
                expect(stubs.encoderMaintenance.clearEncoderMaintenance.callCount).to.equal(1)
            })
        }
    })
})

describe('BootstrapService', function () {
    beforeEach(saveRequireSignedBootstrapSetting)
    afterEach(restoreRequireSignedBootstrapSetting)
    describe('tracker archive height helpers', function () {
        const trackerArchive = require('../../../src/services/bootstrap_service/tracker_archive')

        it('chooseArchiveHeight never records below either reading and refuses when the post-read fails', function () {
            loadBootstrapService(makeStubs())
            expect(trackerArchive.chooseArchiveHeight(null, null)).to.equal(null)
            expect(() => trackerArchive.chooseArchiveHeight(100, null)).to.throw(/refusing to record the pre-stop height 100/)
            expect(trackerArchive.chooseArchiveHeight(null, 101)).to.equal(101)
            expect(trackerArchive.chooseArchiveHeight(100, 101)).to.equal(101)
            expect(trackerArchive.chooseArchiveHeight(100, 98)).to.equal(100)
        })

        it('readTrackerHeightAfterRestart retries a tracker that is still coming up', async function () {
            const { stubs } = trackerStubsWithProbe([new Error('connection refused'), new Error('connection refused'), 107])
            loadBootstrapService(stubs)
            const height = await trackerArchive.readTrackerHeightAfterRestart(COIN, NETWORK, FAKE_CONTAINER_ID, { attempts: 5, delayMs: 0 })
            expect(height).to.equal(107)
            expect(stubs.healthGate.probeServiceStatus.callCount).to.equal(3)
        })

        it('readTrackerHeightAfterRestart gives up with null after its attempts', async function () {
            const { stubs } = trackerStubsWithProbe([new Error('connection refused')])
            loadBootstrapService(stubs)
            const height = await trackerArchive.readTrackerHeightAfterRestart(COIN, NETWORK, FAKE_CONTAINER_ID, { attempts: 3, delayMs: 0 })
            expect(height).to.equal(null)
            expect(stubs.healthGate.probeServiceStatus.callCount).to.equal(3)
        })
    })
})
