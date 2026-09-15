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

const sinon      = require('sinon')
const { expect } = require('chai')
const { makeStubs, loadModuleService } = require('./helpers')

describe('Chaos: Process Resilience', function () {

    afterEach(function () {
        sinon.restore()
    })

    // Experiment: uninstallModule error scenarios
    describe('Experiment: Uninstall resilience', function () {

        it('throws when trying to uninstall the database module', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            try {
                await ms.uninstallModule('bitcoin', 'mainnet', 'database')
                expect.fail('should have thrown')
            } catch (err) {
                expect(err).to.include('manually removed')
            }
        })

        it('returns true when module is not found in status (already uninstalled)', async function () {
            const stubs = makeStubs()
            const ms = loadModuleService(stubs)

            const result = await ms.uninstallModule('bitcoin', 'mainnet', 'xchain-encoder')
            expect(result).to.be.true
        })
    })
})
