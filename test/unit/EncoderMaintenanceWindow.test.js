'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bootstrap publish stops the UTXO tracker, the encoder reports
// that truthfully, and the public board had only one word for the result:
// Degraded (2026-08-01: 3h36m on mainnet BTC). This module hands the encoder
// the operator's declaration that the outage is planned, so the board can
// say Maintenance instead.
//
// Two properties carry the design:
//   1. The sentinel always carries an EXPIRY, so a publish that dies without
//      cleaning up stops excusing the outage at its own end time.
//   2. Nothing here may throw. A cosmetic status label must never fail a
//      publish or leave a tracker down.

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noCallThru()

const { XChainService } = require('../../src/config/constants')

const COIN    = 'bitcoin'
const NETWORK = 'mainnet'
const ENCODER_CONTAINER = 'e'.repeat(64)

function load({ containerId = ENCODER_CONTAINER, writeErr = null, execErr = null, getContainerErr = null } = {}) {
    const stubs = {
        getModuleContainer: getContainerErr
            ? sinon.stub().rejects(getContainerErr)
            : sinon.stub().resolves(containerId),
        stringToDockerContainerFile: writeErr
            ? sinon.stub().rejects(writeErr)
            : sinon.stub().resolves(true),
        execContainer: execErr
            ? sinon.stub().rejects(execErr)
            : sinon.stub().resolves('')
    }
    const mod = proxyquire('../../src/services/EncoderMaintenanceWindow', {
        '../config/constants': { XChainService },
        '../state': { db: { getModuleContainer: stubs.getModuleContainer } },
        './DockerService': {
            stringToDockerContainerFile: stubs.stringToDockerContainerFile,
            execContainer: stubs.execContainer
        }
    })
    return { mod, stubs }
}

describe('EncoderMaintenanceWindow', function () {

    describe('declareEncoderMaintenance()', function () {

        it('writes a bounded, currently-open sentinel into the encoder container', async function () {
            const { mod, stubs } = load()
            const before = Date.now()
            expect(await mod.declareEncoderMaintenance(COIN, NETWORK, { reason: 'utxo-tracker bootstrap publish' })).to.be.true

            expect(stubs.getModuleContainer.calledWith(XChainService.XCHAIN_ENCODER, COIN, NETWORK)).to.be.true
            const [containerId, body, filePath] = stubs.stringToDockerContainerFile.getCall(0).args
            expect(containerId).to.equal(ENCODER_CONTAINER)
            expect(filePath).to.equal(mod.SENTINEL_PATH)

            const doc = JSON.parse(body)
            expect(doc.reason).to.equal('utxo-tracker bootstrap publish')
            // The expiry is the whole safety property: a crashed publish must
            // stop excusing the outage on its own.
            const until = Date.parse(doc.until)
            const since = Date.parse(doc.since)
            expect(since).to.be.at.least(before)
            expect(until).to.be.greaterThan(since)
            expect(until - since).to.equal(mod.DEFAULT_WINDOW_MINUTES * 60 * 1000)
        })

        it('honours an explicit window length', async function () {
            const { mod, stubs } = load()
            await mod.declareEncoderMaintenance(COIN, NETWORK, { reason: 'reindex', minutes: 30 })
            const doc = JSON.parse(stubs.stringToDockerContainerFile.getCall(0).args[1])
            expect(Date.parse(doc.until) - Date.parse(doc.since)).to.equal(30 * 60 * 1000)
        })

        it('falls back to a generic reason rather than writing an empty one', async function () {
            const { mod, stubs } = load()
            await mod.declareEncoderMaintenance(COIN, NETWORK)
            const doc = JSON.parse(stubs.stringToDockerContainerFile.getCall(0).args[1])
            expect(doc.reason).to.be.a('string').and.not.be.empty
        })

        // A host that runs a tracker but no encoder is a normal deployment, not
        // an error, and must not cost a log line on every publish.
        it('reports false and writes nothing when there is no encoder here', async function () {
            const { mod, stubs } = load({ containerId: null })
            expect(await mod.declareEncoderMaintenance(COIN, NETWORK)).to.be.false
            expect(stubs.stringToDockerContainerFile.called).to.be.false
        })

        it('never throws when the container lookup fails', async function () {
            const { mod, stubs } = load({ getContainerErr: new Error('store unavailable') })
            expect(await mod.declareEncoderMaintenance(COIN, NETWORK)).to.be.false
            expect(stubs.stringToDockerContainerFile.called).to.be.false
        })

        it('never throws when the write fails', async function () {
            const { mod } = load({ writeErr: new Error('docker exec: no such container') })
            expect(await mod.declareEncoderMaintenance(COIN, NETWORK)).to.be.false
        })
    })

    describe('clearEncoderMaintenance()', function () {

        it('removes the sentinel from the encoder container', async function () {
            const { mod, stubs } = load()
            expect(await mod.clearEncoderMaintenance(COIN, NETWORK)).to.be.true
            const [containerId, argv] = stubs.execContainer.getCall(0).args
            expect(containerId).to.equal(ENCODER_CONTAINER)
            // -f so a sentinel already gone (encoder restarted mid-run) is not
            // reported as a failure.
            expect(argv).to.deep.equal(['rm', '-f', mod.SENTINEL_PATH])
        })

        it('never throws when the removal fails', async function () {
            const { mod } = load({ execErr: new Error('container is restarting') })
            expect(await mod.clearEncoderMaintenance(COIN, NETWORK)).to.be.false
        })

        it('is a no-op with no encoder on this host', async function () {
            const { mod, stubs } = load({ containerId: null })
            expect(await mod.clearEncoderMaintenance(COIN, NETWORK)).to.be.false
            expect(stubs.execContainer.called).to.be.false
        })
    })

    describe('sentinel path', function () {
        // The encoder resolves the same default (xchain-encoder
        // src/maintenanceWindow.js DEFAULT_SENTINEL). A drift here means the
        // publish writes a window nothing ever reads.
        it('defaults to the path the encoder reads', function () {
            const { mod } = load()
            expect(mod.SENTINEL_PATH).to.equal('/tmp/xchain-encoder-maintenance.json')
        })
    })
})
