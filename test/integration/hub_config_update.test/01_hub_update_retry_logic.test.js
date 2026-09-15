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

const { expect } = require('chai')

const { hubConfigSuite } = require('./support/fixture')

hubConfigSuite('hub update retry logic', function (fixture) {

    it('retries on failure and succeeds when hub responds', async function () {
        const { env, httpCapture, makeHubService, TestEnv } = fixture()
        const state = require('../../../src/state')

        const hubId = TestEnv.fakeContainerId('h')
        const encId = TestEnv.fakeContainerId('e')
        await env.insertModule('xchain-hub', '', '', hubId)
        await env.insertModule('xchain-encoder', 'bitcoin', 'mainnet', encId)

        env.writeConfigFile('bitcoin-mainnet', '')
        state.setStatusUpdated(true)
        state.setLastStatus({
            'bitcoin': {
                'mainnet': {
                    'xchain-encoder': { container_id: encId, status: { State: { Status: 'running' } } }
                }
            }
        })

        httpCapture.when('127.0.0.1:10000').failsThenSucceeds(
            2,
            new Error('Connection refused'),
            { data: { result: true } }
        )

        const { HubService } = makeHubService()
        await HubService.updateHubOrExplorer('xchain-hub')

        // Should have been called 3 times (2 failures + 1 success)
        expect(httpCapture.callCount('127.0.0.1:10000')).to.equal(3)
    })

    it('throws after exhausting all retries', async function () {
        const { env, httpCapture, makeHubService, TestEnv } = fixture()
        const state = require('../../../src/state')

        const hubId = TestEnv.fakeContainerId('h')
        await env.insertModule('xchain-hub', '', '', hubId)

        state.setStatusUpdated(true)
        state.setLastStatus({})

        httpCapture.when('127.0.0.1:10000').rejects(new Error('Connection refused'))

        const { HubService } = makeHubService()

        try {
            await HubService.updateHubOrExplorer('xchain-hub')
            expect.fail('Should have thrown')
        } catch (err) {
            expect(err).to.include('problem trying to update')
        }

        expect(httpCapture.callCount('127.0.0.1:10000')).to.equal(10)
    })
})
