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

hubConfigSuite('hub update retry window', function (fixture) {

    it('succeeds when the hub answers on the last attempt of its boot window', async function () {
        const { env, httpCapture, makeHubService, TestEnv } = fixture()
        const state = require('../../../src/state')

        const hubId = TestEnv.fakeContainerId('h')
        await env.insertModule('xchain-hub', '', '', hubId)

        state.setStatusUpdated(true)
        state.setLastStatus({})

        httpCapture.when('127.0.0.1:10000').failsThenSucceeds(
            59,
            new Error('Connection refused'),
            { data: { result: true } }
        )

        const { HubService } = makeHubService()
        await HubService.updateHubOrExplorer('xchain-hub')

        expect(httpCapture.callCount('127.0.0.1:10000')).to.equal(60)
    })
})
