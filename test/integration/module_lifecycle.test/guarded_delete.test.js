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

const state = require('../../../src/state')
const TestEnv = require('../helpers/test-env')

describe('Integration: guarded module registry delete', function () {
    let env

    beforeEach(async function () {
        env = new TestEnv()
        await env.setup()
    })

    afterEach(async function () {
        await env.teardown()
    })

    it('preserves a replacement row and deletes the matching row', async function () {
        const staleId = TestEnv.fakeContainerId('b')
        const replacementId = TestEnv.fakeContainerId('c')
        await state.db.setModuleContainer('xchain-decoder', 'bitcoin', 'mainnet', replacementId)

        const staleRemoved = await state.db.deleteModuleContainerIfMatches(
            'xchain-decoder', 'bitcoin', 'mainnet', staleId
        )
        expect(staleRemoved).to.be.false
        expect(await state.db.getModuleContainer('xchain-decoder', 'bitcoin', 'mainnet')).to.equal(replacementId)

        const currentRemoved = await state.db.deleteModuleContainerIfMatches(
            'xchain-decoder', 'bitcoin', 'mainnet', replacementId
        )
        expect(currentRemoved).to.be.true
        expect(await state.db.getModuleContainer('xchain-decoder', 'bitcoin', 'mainnet')).to.be.null
    })
})
