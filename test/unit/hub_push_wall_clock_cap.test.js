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
 * Hub config push: bounded by wall time when the hub hangs.
 ********************************************************************/

const sinon = require('sinon')
const assert = require('node:assert/strict')
const { expect } = require('chai')

const { updateHubOrExplorer } = require('../../src/services/hub_service/update_hub_or_explorer')

function deps({ updateConfig, clock }) {
    return {
        HUB_MODULE_NAME: 'xchain-hub',
        EXPLORER_MODULE_NAME: 'xchain-explorer',
        EXTERNAL_DB: false,
        XChainService: { XCHAIN_INDEXER: 'xchain-indexer' },
        db: { getModuleContainer: sinon.stub().resolves('c') },
        getLastStatus: () => ({}),
        isStatusUpdated: () => true,
        sleep: sinon.stub().resolves(),
        redactSecrets: v => String(v && v.message ? v.message : v),
        getDefaultConfig: sinon.stub().resolves({ HUB_PORT: 10000, EXPLORER_PORT: 10001 }),
        getStatus: sinon.stub().resolves(),
        getExternalDbConfig: sinon.stub().resolves(null),
        readContainerEnv: sinon.stub().resolves(null),
        HubConnector: class { constructor() { this.updateConfig = updateConfig } },
        ExplorerConnector: class {},
        dockerService: {},
        buildHubModuleConfig: sinon.stub().returns(null),
        buildCheckpointConfig: sinon.stub().returns({}),
        isCheckpointSelfSyncEnabled: sinon.stub().resolves(false),
        logger: { info: sinon.stub() },
        now: clock ? () => clock.t : undefined
    }
}

describe('hub config push wall-clock cap', function () {
    it('gives up after about three minutes when every attempt hangs for 60 s', async function () {
        const clock = { t: 0 }
        const updateConfig = sinon.spy(async () => { clock.t += 60000; return null })
        await assert.rejects(
            updateHubOrExplorer('xchain-hub', deps({ updateConfig, clock })),
            /There was a problem trying to update a config/
        )
        expect(updateConfig.callCount).to.be.at.most(4)
        expect(clock.t).to.be.at.most(240000)
    })

    it('still retries fast failures up to the attempt limit', async function () {
        const clock = { t: 0 }
        const updateConfig = sinon.spy(async () => null)
        await assert.rejects(
            updateHubOrExplorer('xchain-hub', deps({ updateConfig, clock })),
            /There was a problem trying to update a config/
        )
        expect(updateConfig.callCount).to.equal(60)
    })

    it('succeeds when the hub answers on a later attempt within the budget', async function () {
        const clock = { t: 0 }
        const updateConfig = sinon.spy(async () => { clock.t += 60000; return updateConfig.callCount >= 3 })
        expect(await updateHubOrExplorer('xchain-hub', deps({ updateConfig, clock }))).to.be.true
        expect(updateConfig.callCount).to.equal(3)
    })
})
