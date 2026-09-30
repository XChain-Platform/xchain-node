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
    describe('tracker archive height helpers', function () {
        const trackerArchive = require('../../../src/services/bootstrap_service/tracker_archive')

        it('chooseArchiveHeight never records below either reading and keeps the floor when the post-read fails', function () {
            loadBootstrapService(makeStubs())
            expect(trackerArchive.chooseArchiveHeight(null, null)).to.equal(null)
            expect(trackerArchive.chooseArchiveHeight(100, null)).to.equal(100)
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
