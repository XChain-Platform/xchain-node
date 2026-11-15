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
 * Hub config push: the wall-clock budget is handed to each attempt, so it
 * is a cap and not a check made after an attempt has already spent it.
 ********************************************************************/

const sinon = require('sinon')
const assert = require('node:assert/strict')
const { expect } = require('chai')

const { updateHubOrExplorer } = require('../../src/services/hub_service/update_hub_or_explorer')

const WALL_MS = 180000

function deps({ updateConfig, clock, sleep }) {
    return {
        HUB_MODULE_NAME: 'xchain-hub',
        EXPLORER_MODULE_NAME: 'xchain-explorer',
        EXTERNAL_DB: false,
        XChainService: { XCHAIN_INDEXER: 'xchain-indexer' },
        db: { getModuleContainer: sinon.stub().resolves('c') },
        getLastStatus: () => ({}),
        isStatusUpdated: () => true,
        sleep: sleep || sinon.stub().resolves(),
        redactSecrets: v => String(v && v.message ? v.message : v),
        getDefaultConfig: sinon.stub().resolves({ HUB_PORT: 10000, EXPLORER_PORT: 10001 }),
        getStatus: sinon.stub().resolves(),
        getExternalDbConfig: sinon.stub().resolves(null),
        readContainerEnv: sinon.stub().resolves(null),
        HubConnector: class {
            constructor() {
                this.lastFailures = []
                this.updateConfig = updateConfig
            }
        },
        ExplorerConnector: class {},
        dockerService: {},
        buildHubModuleConfig: sinon.stub().returns(null),
        buildCheckpointConfig: sinon.stub().returns({}),
        isCheckpointSelfSyncEnabled: sinon.stub().resolves(false),
        logger: { info: sinon.stub() },
        now: () => clock.t
    }
}

const budgets = (spy) => spy.getCalls().map(call => call.args[1].budgetMs)

describe('hub config push hands its budget to each attempt', function () {
    it('an attempt that honours the budget never takes the run past the wall clock', async function () {
        const clock = { t: 0 }
        const updateConfig = sinon.spy(async (json, opts) => { clock.t += Math.min(60000, opts.budgetMs); return null })

        await assert.rejects(
            updateHubOrExplorer('xchain-hub', deps({ updateConfig, clock })),
            /There was a problem trying to update a config/
        )

        expect(clock.t).to.be.at.most(WALL_MS)
        expect(budgets(updateConfig)).to.deep.equal([180000, 120000, 60000])
    })

    it('the budget an attempt receives is what is left, not the full allowance', async function () {
        const clock = { t: 0 }
        const updateConfig = sinon.spy(async (json, opts) => { clock.t += Math.min(100000, opts.budgetMs); return null })

        await assert.rejects(
            updateHubOrExplorer('xchain-hub', deps({ updateConfig, clock })),
            /There was a problem trying to update a config/
        )

        expect(budgets(updateConfig)).to.deep.equal([180000, 80000])
        expect(clock.t).to.equal(WALL_MS)
    })

    it('no attempt is started once the retry sleep has used the budget up', async function () {
        const clock = { t: 0 }
        const updateConfig = sinon.spy(async () => { clock.t += 178000; return null })
        const sleep = sinon.spy(async () => { clock.t += 3000 })

        await assert.rejects(
            updateHubOrExplorer('xchain-hub', deps({ updateConfig, clock, sleep })),
            /There was a problem trying to update a config/
        )

        expect(updateConfig.callCount).to.equal(1)
    })

    it('a giving-up error still names the last cause', async function () {
        const clock = { t: 0 }
        const updateConfig = sinon.spy(async function (json, opts) {
            this.lastFailures = ['http://127.0.0.1:10000 → timeout: no complete response within ' + opts.budgetMs + 'ms']
            clock.t += Math.min(100000, opts.budgetMs)
            return null
        })

        await assert.rejects(
            updateHubOrExplorer('xchain-hub', deps({ updateConfig, clock })),
            err => String(err).includes('last error: http://127.0.0.1:10000 → timeout: no complete response within 80000ms')
        )
    })
})
