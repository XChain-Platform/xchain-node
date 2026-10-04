'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')
const sinon = require('sinon')
const trackerHeight = require('../../../../src/services/bootstrap_service/tracker_height')

const TRACKER_SERVICE = 'xchain-utxo-tracker'
const PORT_KEY = 'UTXO_TRACKER_API_PORT'

function configureTrackerHeight(probeServiceStatus) {
    const execFile = sinon.stub().callsFake((command, args, options, callback) => {
        callback(null, { stdout: '', stderr: '' })
    })
    const getDefaultConfig = sinon.stub().resolves({ [PORT_KEY]: 8080 })
    const logger = { info: sinon.stub() }

    trackerHeight.configureDependencies({
        childProcess: { execFile },
        config: { XChainService: { XCHAIN_UTXO_TRACKER: TRACKER_SERVICE } },
        configService: { getDefaultConfig },
        bootstrapHealthGate: {
            probeServiceStatus,
            MODULE_API_PORT_KEY: { [TRACKER_SERVICE]: PORT_KEY }
        },
        logger
    })
    return { execFile, getDefaultConfig, logger }
}

describe('tracker_height', function () {
    let probeServiceStatus
    let fakes

    beforeEach(function () {
        probeServiceStatus = sinon.stub()
        fakes = configureTrackerHeight(probeServiceStatus)
    })

    for (const [relationship, tracker, archive, expected] of [
        ['ahead of', 100, 105, 105],
        ['equal to', 100, 100, 100],
        ['behind', 100, 95, 100]
    ]) {
        it(`chooses safely when the archive height is ${relationship} the tracker height`, function () {
            expect(trackerHeight.chooseArchiveHeight(tracker, archive)).to.equal(expected)
        })
    }

    it('keeps the tracker height when the archive height is missing', function () {
        expect(trackerHeight.chooseArchiveHeight(100, null)).to.equal(100)
    })

    it('uses the archive height when the tracker height is missing', function () {
        expect(trackerHeight.chooseArchiveHeight(null, 105)).to.equal(105)
    })

    it('returns null when both heights are missing', function () {
        expect(trackerHeight.chooseArchiveHeight(null, null)).to.equal(null)
    })

    it('reads the committed height through configured fakes', async function () {
        probeServiceStatus.resolves({ committed_height: 321 })

        const height = await trackerHeight.readTrackerCommittedHeight('bitcoin', 'mainnet', 'container-id')

        expect(height).to.equal(321)
        expect(fakes.getDefaultConfig.calledOnceWithExactly(TRACKER_SERVICE, 'bitcoin', 'mainnet')).to.equal(true)
        expect(probeServiceStatus.firstCall.args.slice(0, 2)).to.deep.equal(['container-id', 8080])
        expect(fakes.execFile.called).to.equal(false)
    })

    it('retries the post-restart height through configured fakes', async function () {
        probeServiceStatus.onFirstCall().rejects(new Error('not ready'))
        probeServiceStatus.onSecondCall().resolves({ tracker_height: 322 })

        const height = await trackerHeight.readTrackerHeightAfterRestart(
            'bitcoin', 'mainnet', 'container-id', { attempts: 2, delayMs: 0 }
        )

        expect(height).to.equal(322)
        expect(probeServiceStatus.callCount).to.equal(2)
        expect(fakes.execFile.called).to.equal(false)
    })
})
