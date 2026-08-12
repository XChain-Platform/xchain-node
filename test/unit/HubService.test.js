/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * HubService.updateHub: shared-container network attachment.
 *
 * updateHub() used to catch every addContainerToNetwork failure, discard the
 * error and still return true, so a topology change published module config
 * while the shared hub/sync container was never joined to the new coin
 * network, leaving those endpoints unreachable until an unrelated later
 * mutation happened to retry. These cases pin the replacement contract:
 * one retry, then report the networks that stayed unreachable.
 *
 * The hub and sync loops share attachSharedContainer, so exercising the sync
 * loop (hub registry row absent) covers both without dragging the heavy
 * updateHubOrExplorer config push into a unit test.
 ********************************************************************/

const sinon      = require('sinon')
const { expect } = require('chai')
const proxyquire = require('proxyquire')

const { HUB_MODULE_NAME, SYNC_MODULE_NAME } = require('../../src/config/constants')

function loadHubService({ addContainerToNetwork } = {}) {
    const getModuleContainer = sinon.stub()
    getModuleContainer.withArgs(HUB_MODULE_NAME,  '', '').resolves(null)
    getModuleContainer.withArgs(SYNC_MODULE_NAME, '', '').resolves('sync1234sync1234')

    const attach = addContainerToNetwork || sinon.stub().resolves(true)

    const svc = proxyquire('../../src/services/HubService', {
        '../state':          { db: { getModuleContainer } },
        './StatusService':   { getInstalledCoinsAndNetworks: async () => ({ bitcoin: ['mainnet'] }) },
        './DockerService':   { addContainerToNetwork: attach },
        '../utils/helpers':  { sleep: async () => {} },
    })

    return { svc, attach }
}

describe('HubService.updateHub network attachment', function () {

    it('returns true when every shared-container attach succeeds', async function () {
        const { svc, attach } = loadHubService()
        expect(await svc.updateHub()).to.be.true
        sinon.assert.calledWith(attach, 'sync1234sync1234', 'xchain-node-bitcoin-mainnet')
    })

    it('retries a failed attach once and succeeds on the second try', async function () {
        const attach = sinon.stub()
        attach.onFirstCall().rejects(new Error('docker race'))
        attach.onSecondCall().resolves(true)
        const { svc } = loadHubService({ addContainerToNetwork: attach })
        expect(await svc.updateHub()).to.be.true
        expect(attach.callCount).to.equal(2)
    })

    it('rejects naming the unreachable network instead of reporting success', async function () {
        const attach = sinon.stub().rejects(new Error('network xchain-node-bitcoin-mainnet not found'))
        const { svc } = loadHubService({ addContainerToNetwork: attach })
        let threw = null
        try {
            await svc.updateHub()
        } catch (err) {
            threw = err
        }
        expect(threw).to.be.an('error')
        expect(threw.message).to.match(/xchain-sync -> bitcoin\/mainnet/)
        expect(attach.callCount).to.equal(2)
    })
})
