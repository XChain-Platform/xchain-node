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

    // Experiment: cloneGit + buildAndUp error chain
    describe('Experiment: Multi-step operation error propagation', function () {

        it('cloneGit error prevents buildAndUp from running', async function () {
            const stubs = makeStubs()
            sinon.stub(console, 'log')

            // cloneGit will fail (module doesn't have URL)
            const ms = loadModuleService(stubs)

            try {
                await ms.cloneGit('nonexistent-module')
                expect.fail('should have rejected')
            } catch (err) {
                expect(err).to.include("doesn't have an url")
            }

            // No docker commands should have been called
            expect(stubs.execFile.called).to.be.false
        })
    })
})
