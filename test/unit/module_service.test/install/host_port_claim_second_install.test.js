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

// Every install defaults the utxo-tracker host port to 3001, so a second install on
// the same host (testnet beside mainnet) asked for a port the first already
// published and stopped on a host port conflict. A port the registry publishes only
// on request now moves to a free one; the hub and explorer ports still refuse.

const { expect, makeStubs, loadModuleService, moduleSuite } = require('../support/helpers')
const { XChainService, HUB_MODULE_NAME, SERVICE_REGISTRY } = require('../../../../src/config')
const { claimFreeHostPorts, nextFreeHostPort } = require('../../../../src/services/module_service/host_port_claim')

const FIRST_TRACKER = 'xchain-node-bitcoin-mainnet-xchain-utxo-tracker'
const SECOND_TRACKER = 'xchain-node-bitcoin-testnet-xchain-utxo-tracker'

function trackerEnv() {
    return { UTXO_TRACKER_PORT: 3001, UTXO_TRACKER_API_PORT: 3001 }
}

function loadWithPublished(entries) {
    const stubs = makeStubs()
    stubs.getPublishedHostPorts.resolves(new Map(entries.map(([port, name]) => [port, new Set([name])])))
    return loadModuleService(stubs)
}

function registerSecondInstallTests() {
    it('publishes a second install\'s utxo-tracker on a free host port', async function () {
        const ms = loadWithPublished([['3001', FIRST_TRACKER]])
        const env = trackerEnv()
        const portArgs = ['-p', '3001:3001']

        await ms.assertNoHostPortConflicts(portArgs, SECOND_TRACKER, { module: XChainService.XCHAIN_UTXO_TRACKER, environmentVariables: env })

        expect(portArgs).to.deep.equal(['-p', '3101:3001'])
        expect(env.UTXO_TRACKER_PORT).to.equal(3101)
        expect(env.UTXO_TRACKER_API_PORT).to.equal(3001, 'the container side is untouched')
    })

    it('skips host ports already taken by a third install', async function () {
        const ms = loadWithPublished([['3001', FIRST_TRACKER], ['3101', 'xchain-node-litecoin-mainnet-xchain-utxo-tracker']])
        const env = trackerEnv()
        const portArgs = ['-p', '3001:3001']

        await ms.assertNoHostPortConflicts(portArgs, SECOND_TRACKER, { module: XChainService.XCHAIN_UTXO_TRACKER, environmentVariables: env })

        expect(portArgs).to.deep.equal(['-p', '3201:3001'])
    })

    it('leaves a free port alone, and does not count its own container as a holder', async function () {
        const ms = loadWithPublished([['3001', SECOND_TRACKER]])
        const env = trackerEnv()
        const portArgs = ['-p', '3001:3001']

        await ms.assertNoHostPortConflicts(portArgs, SECOND_TRACKER, { module: XChainService.XCHAIN_UTXO_TRACKER, environmentVariables: env })

        expect(portArgs).to.deep.equal(['-p', '3001:3001'])
        expect(env.UTXO_TRACKER_PORT).to.equal(3001)
    })
}

function registerRefusalTests() {
    it('still refuses a conflict when the caller does not opt in', async function () {
        const ms = loadWithPublished([['3001', FIRST_TRACKER]])
        await ms.assertNoHostPortConflicts(['-p', '3001:3001'], SECOND_TRACKER)
            .then(() => { throw new Error('expected a host port conflict') },
                (err) => expect(err.message).to.match(/host port 3001 is already published by/))
    })

    it('still refuses a conflict on the hub port, which the CLI dials on 127.0.0.1', async function () {
        const ms = loadWithPublished([['10000', 'some-other-hub']])
        const env = { HUB_PORT: 10000 }
        const portArgs = ['-p', '10000:10000']
        await ms.assertNoHostPortConflicts(portArgs, 'xchain-node-xchain-hub', { module: HUB_MODULE_NAME, environmentVariables: env })
            .then(() => { throw new Error('expected a host port conflict') },
                (err) => expect(err.message).to.match(/host port 10000 is already published by: some-other-hub/))
        expect(portArgs).to.deep.equal(['-p', '10000:10000'])
    })

    it('refuses a validator P2P conflict without rewriting its listener port', async function () {
        const ms = loadWithPublished([['10001', 'other-stack-hub']])
        const env = { HUB_PORT: 10000, P2P_PORT: 10001 }
        const portArgs = ['-p', '10000:10000', '-p', '10001:10001']
        await ms.assertNoHostPortConflicts(portArgs, 'xchain-node-xchain-hub', { module: HUB_MODULE_NAME, environmentVariables: env })
            .then(() => { throw new Error('expected a host port conflict') },
                err => expect(err.message).to.match(/host port 10001 is already published by: other-stack-hub/))
        expect(portArgs).to.deep.equal(['-p', '10000:10000', '-p', '10001:10001'])
        expect(env.P2P_PORT).to.equal(10001)
    })
}

function registerPickTests() {
    it('steps by 100 and gives up past the last port', function () {
        expect(nextFreeHostPort(3001, new Set(['3101']))).to.equal(3201)
        expect(nextFreeHostPort(65500, new Set())).to.equal(null)
    })

    it('changes nothing without a claim', function () {
        const conflicts = [{ hostPort: '3001', holders: [FIRST_TRACKER] }]
        expect(claimFreeHostPorts(conflicts, ['-p', '3001:3001'], ['3001'], new Map(), null)).to.equal(conflicts)
        expect(conflicts).to.have.length(1)
    })
}

const DECODER = 'xchain-node-bitcoin-testnet-xchain-decoder'
const FIRST_DECODER = 'xchain-node-bitcoin-mainnet-xchain-decoder'

function decoderClaim(env, selfName, reserved) {
    return {
        module: XChainService.XCHAIN_DECODER, environmentVariables: env, selfName, reserved,
        registry: SERVICE_REGISTRY, logger: { info() {} }
    }
}

function decoderCall(published, claim) {
    const env = { DECODER_PORT: 3002, DECODER_API_PORT: 3002 }
    const portArgs = ['-p', '3002:3002']
    const claimArg = decoderClaim(env, claim.selfName, claim.reserved)
    const left = claimFreeHostPorts([{ hostPort: '3002', holders: [FIRST_DECODER] }], portArgs, ['3002'], published, claimArg)
    return { env, portArgs, left }
}

function registerRebuildStabilityTests() {
    it('keeps the port the container being recreated already publishes', function () {
        const published = new Map([['3002', new Set([FIRST_DECODER])], ['3102', new Set([DECODER])]])
        const { env, portArgs, left } = decoderCall(published, { selfName: DECODER })
        expect(left).to.have.length(0)
        expect(portArgs).to.deep.equal(['-p', '3102:3002'])
        expect(env.DECODER_PORT).to.equal(3102)
    })

    it('still skips a port the recreated container shares with another container', function () {
        const published = new Map([['3002', new Set([FIRST_DECODER])], ['3102', new Set([DECODER, 'some-other'])]])
        expect(decoderCall(published, { selfName: DECODER }).portArgs).to.deep.equal(['-p', '3202:3002'])
    })

    it('counts every published port as taken when no self name is given', function () {
        const published = new Map([['3002', new Set([FIRST_DECODER])], ['3102', new Set([DECODER])]])
        expect(decoderCall(published, {}).portArgs).to.deep.equal(['-p', '3202:3002'])
    })

    it('does not flip the port across two rebuilds through assertNoHostPortConflicts', async function () {
        const ms = loadWithPublished([['3002', FIRST_DECODER], ['3102', DECODER]])
        const seen = []
        for (let rebuild = 0; rebuild < 2; rebuild++) {
            const env = { DECODER_PORT: 3002, DECODER_API_PORT: 3002 }
            const portArgs = ['-p', '3002:3002']
            await ms.assertNoHostPortConflicts(portArgs, DECODER, { module: XChainService.XCHAIN_DECODER, environmentVariables: env })
            seen.push(portArgs[1])
        }
        expect(seen).to.deep.equal(['3102:3002', '3102:3002'])
    })
}

function registerStoppedSiblingTests() {
    it('does not hand a new install the port a stopped sibling will bind again', async function () {
        const stubs = makeStubs()
        stubs.getPublishedHostPorts.resolves(new Map([['3001', new Set([FIRST_TRACKER])]]))
        stubs.getAllBoundHostPorts.resolves(new Map([['3101', new Set([SECOND_TRACKER])]]))
        const ms = loadModuleService(stubs)
        const env = trackerEnv()
        const portArgs = ['-p', '3001:3001']

        await ms.assertNoHostPortConflicts(portArgs, 'xchain-node-litecoin-mainnet-xchain-utxo-tracker', { module: XChainService.XCHAIN_UTXO_TRACKER, environmentVariables: env })

        expect(portArgs).to.deep.equal(['-p', '3201:3001'])
    })

    it('ignores the recreated container\'s own saved ports when picking', async function () {
        const stubs = makeStubs()
        stubs.getPublishedHostPorts.resolves(new Map([['3001', new Set([FIRST_TRACKER])]]))
        stubs.getAllBoundHostPorts.resolves(new Map([['3101', new Set([SECOND_TRACKER])]]))
        const ms = loadModuleService(stubs)
        const portArgs = ['-p', '3001:3001']

        await ms.assertNoHostPortConflicts(portArgs, SECOND_TRACKER, { module: XChainService.XCHAIN_UTXO_TRACKER, environmentVariables: trackerEnv() })

        expect(portArgs).to.deep.equal(['-p', '3101:3001'])
    })

    it('leaves a requested port that only a stopped container holds as it is', async function () {
        const stubs = makeStubs()
        stubs.getAllBoundHostPorts.resolves(new Map([['3001', new Set([FIRST_TRACKER])]]))
        const ms = loadModuleService(stubs)
        const portArgs = ['-p', '3001:3001']

        await ms.assertNoHostPortConflicts(portArgs, SECOND_TRACKER, { module: XChainService.XCHAIN_UTXO_TRACKER, environmentVariables: trackerEnv() })

        expect(portArgs).to.deep.equal(['-p', '3001:3001'])
        expect(stubs.getAllBoundHostPorts.called).to.equal(false)
    })

    it('does not read the all-container ports when there is no claim or no conflict', async function () {
        const stubs = makeStubs()
        stubs.getPublishedHostPorts.resolves(new Map([['3001', new Set([FIRST_TRACKER])]]))
        const ms = loadModuleService(stubs)
        await ms.assertNoHostPortConflicts(['-p', '3001:3001'], SECOND_TRACKER).catch(() => {})
        await ms.assertNoHostPortConflicts(['-p', '3999:3999'], SECOND_TRACKER, { module: XChainService.XCHAIN_UTXO_TRACKER, environmentVariables: { UTXO_TRACKER_PORT: 3999, UTXO_TRACKER_API_PORT: 3999 } })
        expect(stubs.getAllBoundHostPorts.called).to.equal(false)
    })

    it('honours claim.reserved in claimFreeHostPorts', function () {
        const published = new Map([['3002', new Set([FIRST_DECODER])]])
        const { portArgs } = decoderCall(published, { selfName: DECODER, reserved: new Set(['3102']) })
        expect(portArgs).to.deep.equal(['-p', '3202:3002'])
    })
}

moduleSuite('assertNoHostPortConflicts(): a second install on the same host', function () {
    registerSecondInstallTests()
    registerRefusalTests()
    registerPickTests()
    registerRebuildStabilityTests()
    registerStoppedSiblingTests()
})
