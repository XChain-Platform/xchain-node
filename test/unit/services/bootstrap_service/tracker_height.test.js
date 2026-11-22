'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai')
const sinon = require('sinon')
const vm = require('vm')
const trackerHeight = require('../../../../src/services/bootstrap_service/tracker_height')

const TRACKER_SERVICE = 'xchain-utxo-tracker'
const PORT_KEY = 'UTXO_TRACKER_API_PORT'

function configureTrackerHeight(probeServiceStatus) {
    const execFile = sinon.stub().callsFake((command, args, options, callback) => {
        callback(null, { stdout: '', stderr: '' })
    })
    const getDefaultConfig = sinon.stub().resolves({ [PORT_KEY]: 8080 })
    const logger = { info: sinon.stub() }
    class BootstrapSourceUnhealthyError extends Error {
        constructor(label, reasons) {
            super(`${label}: ${reasons.join('; ')}`)
            this.name = 'BootstrapSourceUnhealthyError'
            this.reasons = reasons
        }
    }
    const gateSkipped = sinon.stub().returns(false)

    trackerHeight.configureDependencies({
        childProcess: { execFile },
        config: { XChainService: { XCHAIN_UTXO_TRACKER: TRACKER_SERVICE } },
        configService: { getDefaultConfig },
        bootstrapHealthGate: {
            probeServiceStatus,
            MODULE_API_PORT_KEY: { [TRACKER_SERVICE]: PORT_KEY },
            BootstrapSourceUnhealthyError,
            gateSkipped
        },
        logger
    })
    return { execFile, getDefaultConfig, logger, gateSkipped, BootstrapSourceUnhealthyError }
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
            expect(trackerHeight.chooseArchiveHeight(tracker, archive, expected)).to.equal(expected)
        })
    }

    it('refuses when only the tracker height before the stop was read', function () {
        expect(() => trackerHeight.chooseArchiveHeight(100, null)).to.throw(/archived store/)
    })

    it('uses the archive height when the tracker height is missing', function () {
        expect(trackerHeight.chooseArchiveHeight(null, 105, 105)).to.equal(105)
    })

    it('returns null when both heights are missing', function () {
        expect(() => trackerHeight.chooseArchiveHeight(null, null)).to.throw(/archived store/)
    })

})

function registerFrozenStoreReadTests(getFakes) {
    it('readFrozenStoreHeight reads the height of the archived directory', async function () {
        const fakes = getFakes()
        fakes.execFile.callsFake((command, args, options, callback) => callback(null, {
            stdout: '{"height":4242,"haltMarker":null}\n', stderr: ''
        }))

        const height = await trackerHeight.readFrozenStoreHeight('vol', '/data/.snap', 'container-id')

        expect(height).to.equal(4242)
        const inspectArgs = fakes.execFile.firstCall.args[1]
        const readArgs = fakes.execFile.secondCall.args[1]
        expect(inspectArgs).to.include('container-id')
        expect(readArgs).to.include('vol:/data')
        expect(readArgs[readArgs.length - 1]).to.equal('/data/.snap')
        expect(readArgs).to.not.include('/data/.snap/xchain-utxo-tracker')
    })

    it('passes a syntactically valid height reader to node', async function () {
        const fakes = getFakes()
        fakes.execFile.callsFake((command, args, options, callback) => callback(null, {
            stdout: '{"height":4242,"haltMarker":null}\n', stderr: ''
        }))

        await trackerHeight.readFrozenStoreHeight('vol', '/data/.snap', 'container-id')

        const readArgs = fakes.execFile.secondCall.args[1]
        const scriptIndex = readArgs.indexOf('-e')
        expect(scriptIndex).to.be.greaterThan(-1)
        const script = readArgs[scriptIndex + 1]
        expect(() => new vm.Script(script, { filename: 'read_store_height.js' })).to.not.throw()
    })

    it('readFrozenStoreHeight returns null on junk output or a failed read', async function () {
        const fakes = getFakes()
        fakes.execFile.callsFake((command, args, options, callback) => callback(null, { stdout: '12abc', stderr: '' }))
        expect(await trackerHeight.readFrozenStoreHeight('vol', '/data', 'container-id')).to.equal(null)
        fakes.execFile.callsFake((command, args, options, callback) => callback(new Error('no such file')))
        expect(await trackerHeight.readFrozenStoreHeight('vol', '/data', 'container-id')).to.equal(null)
    })

    it('reports whether the frozen halt marker was checked and present', async function () {
        const fakes = getFakes()
        fakes.execFile.callsFake((command, args, options, callback) => callback(null, {
            stdout: '{"height":4242,"haltMarker":"{\\"reason\\":\\"reorg\\"}"}\n', stderr: ''
        }))
        expect(await trackerHeight.readFrozenStoreState('vol', '/data', 'container-id')).to.deep.equal({
            height: 4242, haltMarker: '{"reason":"reorg"}', haltChecked: true
        })
        fakes.execFile.callsFake((command, args, options, callback) => callback(null, { stdout: 'junk', stderr: '' }))
        expect(await trackerHeight.readFrozenStoreState('vol', '/data', 'container-id')).to.deep.equal({
            height: null, haltMarker: null, haltChecked: false
        })
    })
}

function registerFrozenStoreSafetyTests(getFakes) {
    it('refuses a present or unchecked frozen marker and accepts an absent one', function () {
        const fakes = getFakes()
        const base = { coin: 'bitcoin', network: 'mainnet' }
        expect(() => trackerHeight.refuseHaltedFrozenStore({ ...base,
            frozenStoreState: { height: 10, haltMarker: null, haltChecked: true }
        })).to.not.throw()
        expect(() => trackerHeight.refuseHaltedFrozenStore({ ...base,
            frozenStoreState: { height: 10, haltMarker: '{"reason":"reorg"}', haltChecked: true }
        })).to.throw(fakes.BootstrapSourceUnhealthyError, /Every restore would boot halted/)
        expect(() => trackerHeight.refuseHaltedFrozenStore({ ...base,
            frozenStoreState: { height: null, haltMarker: null, haltChecked: false }
        })).to.throw(fakes.BootstrapSourceUnhealthyError, /could not be checked/)
    })

    it('warns and continues when the health gate skip is explicit', function () {
        const fakes = getFakes()
        fakes.gateSkipped.returns(true)
        expect(() => trackerHeight.refuseHaltedFrozenStore({ coin: 'bitcoin', network: 'mainnet',
            frozenStoreState: { height: 10, haltMarker: 'halted', haltChecked: true }
        })).to.not.throw()
        expect(fakes.logger.info.firstCall.args[0]).to.match(/^WARNING:/)
    })

    it('a frozen-store height wins over the live readings and lifts the pre-stop-only refusal', function () {
        expect(trackerHeight.chooseArchiveHeight(100, null, 99)).to.equal(99)
        expect(trackerHeight.chooseArchiveHeight(100, 105, 99)).to.equal(99)
        expect(() => trackerHeight.refusePreStopOnlyHeight({ coin: 'bitcoin', network: 'mainnet', preStopHeight: 100, postRestartHeight: null, frozenHeight: 99 })).to.not.throw()
        expect(() => trackerHeight.refusePreStopOnlyHeight({ coin: 'bitcoin', network: 'mainnet', preStopHeight: 100, postRestartHeight: null, frozenHeight: null })).to.throw()
    })
}

describe('tracker_height frozen store', function () {
    let fakes

    beforeEach(function () {
        fakes = configureTrackerHeight(sinon.stub())
    })

    registerFrozenStoreReadTests(() => fakes)
    registerFrozenStoreSafetyTests(() => fakes)
})

describe('tracker_height archive height edge inputs', function () {
    let fakes

    beforeEach(function () {
        fakes = configureTrackerHeight(sinon.stub())
    })

    it('records a frozen-store height alone when neither live reading exists', function () {
        expect(trackerHeight.chooseArchiveHeight(null, null, 99)).to.equal(99)
        expect(fakes.logger.info.lastCall.args[0]).to.match(/Archive height: 99 \(read from the frozen store\)/)
    })

    it('treats a frozen-store height of zero as a reading, not as missing', function () {
        expect(trackerHeight.chooseArchiveHeight(100, 105, 0)).to.equal(0)
        expect(() => trackerHeight.refusePreStopOnlyHeight({ coin: 'bitcoin', network: 'mainnet', preStopHeight: 100, postRestartHeight: null, frozenHeight: 0 })).to.not.throw()
    })

    it('ignores non-integer readings instead of recording them', function () {
        expect(() => trackerHeight.chooseArchiveHeight('100', 105)).to.throw(/archived store/)
        expect(() => trackerHeight.chooseArchiveHeight(100.5, 105)).to.throw(/archived store/)
        expect(() => trackerHeight.chooseArchiveHeight(NaN, null)).to.throw(/archived store/)
        expect(() => trackerHeight.chooseArchiveHeight(null, 105, '99')).to.throw(/archived store/)
    })

    it('refuses a pre-stop reading that has no post-restart reading and no frozen height', function () {
        const run = { coin: 'bitcoin', network: 'mainnet', preStopHeight: 100, postRestartHeight: null, frozenHeight: null }
        expect(() => trackerHeight.refusePreStopOnlyHeight(run)).to.throw(/did not report its committed height after the restart/)
        expect(() => trackerHeight.chooseArchiveHeight(run.preStopHeight, run.postRestartHeight, run.frozenHeight)).to.throw(/archived store/)
    })
})

describe('tracker_height live readings', function () {
    let probeServiceStatus
    let fakes

    beforeEach(function () {
        probeServiceStatus = sinon.stub()
        fakes = configureTrackerHeight(probeServiceStatus)
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

    it('propagates halted tracker payloads instead of accepting their heights', async function () {
        for (const payload of [
            { status: 'halted', committed_height: 322 },
            { halted: true, tracker_height: 323 }
        ]) {
            probeServiceStatus.resetHistory()
            probeServiceStatus.resolves(payload)
            let error = null
            try {
                await trackerHeight.readTrackerHeightAfterRestart(
                    'bitcoin', 'mainnet', 'container-id', { attempts: 2, delayMs: 0 }
                )
            } catch (err) { error = err }
            expect(error).to.be.instanceOf(fakes.BootstrapSourceUnhealthyError)
            expect(probeServiceStatus.callCount).to.equal(1)
        }
    })
})
