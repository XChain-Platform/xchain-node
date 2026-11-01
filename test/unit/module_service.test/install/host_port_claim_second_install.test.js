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
const { XChainService, HUB_MODULE_NAME } = require('../../../../src/config')
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

moduleSuite('assertNoHostPortConflicts(): a second install on the same host', function () {
    registerSecondInstallTests()
    registerRefusalTests()
    registerPickTests()
})
