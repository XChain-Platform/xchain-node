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

// Pins the stop a name-keyed teardown gives a container the registry never
// recorded: docker rm -f is SIGKILL, so a decoder or tracker still draining
// must get its stop budget first, exactly as every id-keyed teardown does.

const { sinon, expect, makeStubs, stubDockerCreate, loadModuleService, moduleSuite } = require('../support/helpers')
const dockerService = require('../../../../src/services/docker_service')

const DECODER = 'xchain-node-bitcoin-mainnet-xchain-decoder'

async function buildDecoder(presence, overwriteContainerId = null) {
    const stubs = makeStubs()
    stubs.probeContainerPresenceByName.resolves(presence)
    stubDockerCreate(stubs)
    const ms = loadModuleService(stubs)
    await ms.buildAndUp('xchain-decoder', 'bitcoin', 'mainnet', overwriteContainerId)
    return stubs
}

moduleSuite('buildAndUp() name-keyed teardown', function () {
    // The stop reads the container's stamped budget off docker; keep that read off a real daemon.
    beforeEach(function () { sinon.stub(dockerService, 'getContainerStopSettings').resolves(null) })
    afterEach(function () { sinon.restore() })

    it('gives a running container the registry never recorded its stop budget before the force-remove', async function () {
        const stubs = await buildDecoder('exists')
        expect(stubs.probeContainerPresenceByName.calledWith(DECODER)).to.equal(true)
        expect(stubs.stopContainerByName.calledOnceWith(DECODER, 120)).to.equal(true)
        expect(stubs.stopContainerByName.calledBefore(stubs.forceRemoveContainerByName)).to.equal(true)
        expect(stubs.forceRemoveContainerByName.calledOnceWith(DECODER)).to.equal(true)
    })

    it('stops by name when docker cannot confirm the container is gone', async function () {
        const stubs = await buildDecoder('unknown')
        expect(stubs.stopContainerByName.calledOnceWith(DECODER, 120)).to.equal(true)
        expect(stubs.stopContainerByName.calledBefore(stubs.forceRemoveContainerByName)).to.equal(true)
    })

    it('does not stop anything when docker confirms the name is free, and still force-removes', async function () {
        const stubs = await buildDecoder('gone')
        expect(stubs.stopContainerByName.called).to.equal(false)
        expect(stubs.forceRemoveContainerByName.calledOnceWith(DECODER)).to.equal(true)
    })

    it('stops the registered container by id and finds the name free afterwards', async function () {
        const stubs = await buildDecoder('gone', 'old-id-123')
        expect(stubs.stopContainerByName.calledOnceWith('old-id-123', 120)).to.equal(true)
        expect(stubs.removeContainer.calledWith('old-id-123')).to.equal(true)
        expect(stubs.stopContainerByName.calledWith(DECODER)).to.equal(false)
    })

    it('stops by name after the id-keyed teardown when a second container still holds the name', async function () {
        const stubs = await buildDecoder('exists', 'old-id-123')
        expect(stubs.stopContainerByName.callCount).to.equal(2)
        expect(stubs.stopContainerByName.firstCall.args).to.deep.equal(['old-id-123', 120])
        expect(stubs.stopContainerByName.secondCall.args).to.deep.equal([DECODER, 120])
        expect(stubs.forceRemoveContainerByName.firstCall.calledAfter(stubs.stopContainerByName.secondCall)).to.equal(true)
    })
})
